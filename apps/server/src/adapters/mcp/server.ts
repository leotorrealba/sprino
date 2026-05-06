// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * MCP-over-HTTP adapter — minimal JSON-RPC 2.0 dispatch on POST /mcp.
 *
 * Supports two methods:
 *   - tools/list        → returns Tessera task/project tool definitions
 *   - tools/call        → dispatches sprino.{task,project} tools
 *
 * Per the locked architecture (eng review): this is a thin adapter over
 * service/tasks.ts. Same idempotency, same transactions, same error codes.
 *
 * v0.x scope:
 *   - No SSE / streaming responses
 *   - No session state
 *   - No resources, prompts, or sampling
 *
 * If Claude Desktop / other clients need stdio MCP, write a shim at
 * apps/server/scripts/mcp-stdio.ts that proxies to this endpoint.
 */

import { Hono } from 'hono';
import { ZodError } from 'zod';
import type { ActorEntry } from '../../auth/registry.ts';
import type { Db } from '../../db/client.ts';
import type { AuthEnv } from '../../auth/middleware.ts';
import {
  AttachmentCreateUploadReqSchema,
  AttachmentFinalizeReqSchema,
  AttachmentGetReqSchema,
  AttachmentListReqSchema,
  ProjectGetReqSchema,
  TaskCreateReqSchema,
  TaskGetReqSchema,
  TaskUpdateStatusReqSchema,
  ActorRegisterReqSchema,
  ActorListReqSchema,
  ActorGetReqSchema,
  ActorHeartbeatReqSchema,
  ActorRevokeTokenReqSchema,
  ActorDeactivateReqSchema,
} from '../../domain/index.ts';
import {
  AttachmentNotFoundError,
  AttachmentNotReadyError,
  AttachmentTaskNotFoundError,
  createUpload,
  finalize,
  getAttachment,
  listAttachments,
} from '../../service/attachments.ts';
import { storage } from '../../service/attachments/instance.ts';
import {
  AgentHeartbeatForbiddenError,
  deactivateAgent,
  heartbeatAgent,
} from '../../service/agent-lifecycle.ts';
import {
  ProjectNotFoundError,
  getProject,
  listProjects,
} from '../../service/projects.ts';
import {
  TaskNotFoundError,
  VersionMismatchError,
  createTask,
  getTask,
  updateTaskStatus,
} from '../../service/tasks.ts';
import {
  IdempotencyConflictError,
  OperationExpiredError,
} from '../../service/idempotency.ts';
import {
  ActorNotFoundError,
  ActorLifecycleTransitionError,
  ActorValidationError,
  EnvActorImmutableError,
  LastAdminProtectedError,
  getActor,
  listActors,
  registerActor,
  revokeToken,
} from '../../service/actors.ts';
import { AuthorizationForbiddenError } from '../../service/authorization.ts';

type Env = AuthEnv;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const TOOL_DEFINITIONS = [
  {
    name: 'sprino.project.list',
    description:
      'List projects known to Sprino. Use this before task.create when no repo context is available.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'sprino.project.get',
    description:
      'Fetch a project by project_id, slug, or repo_path. Repo paths are used for week 2 multi-repo auto-detection.',
    inputSchema: {
      type: 'object',
      anyOf: [
        { required: ['project_id'] },
        { required: ['slug'] },
        { required: ['repo_path'] },
      ],
      properties: {
        project_id: { type: 'string', format: 'uuid' },
        slug: { type: 'string', minLength: 1, maxLength: 64 },
        repo_path: { type: 'string', minLength: 1 },
      },
    },
  },
  {
    name: 'sprino.task.create',
    description:
      'Create a task in a project. Idempotent via operation_id (UUIDv7). project_id may be inferred from repo_path by the stdio shim.',
    inputSchema: {
      type: 'object',
      required: ['operation_id', 'title'],
      properties: {
        operation_id: { type: 'string', format: 'uuid' },
        project_id: { type: 'string', format: 'uuid' },
        repo_path: { type: 'string', minLength: 1 },
        title: { type: 'string', minLength: 1, maxLength: 280 },
        description: { type: 'string', maxLength: 16384 },
        assignee_id: { type: ['string', 'null'], format: 'uuid' },
      },
    },
  },
  {
    name: 'sprino.task.get',
    description:
      'Fetch a task with its agent_context (recent_events, related_tasks, repo_refs).',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: { task_id: { type: 'string', format: 'uuid' } },
    },
  },
  {
    name: 'sprino.task.update_status',
    description:
      "Mutate a task's status. Idempotent via operation_id; concurrency-safe via if_match.",
    inputSchema: {
      type: 'object',
      required: ['operation_id', 'task_id', 'status', 'if_match'],
      properties: {
        operation_id: { type: 'string', format: 'uuid' },
        task_id: { type: 'string', format: 'uuid' },
        status: { enum: ['todo', 'doing', 'done', 'blocked'] },
        if_match: { type: 'integer', minimum: 1 },
      },
    },
  },
  {
    name: 'sprino.actor.register',
    description:
      "Register a new actor (Tessera v0.1.2). Idempotent via operation_id (UUIDv7). Returns {actor, token} on first call; replay returns {actor} only and never replays the plaintext token. Use kind='human' for people. Use kind='agent' for agent sessions; agent registrations must also provide agent_runtime and parent_actor_id.",
    inputSchema: {
      oneOf: [
        {
          type: 'object',
          required: ['operation_id', 'display_name', 'kind'],
          additionalProperties: false,
          properties: {
            operation_id: { type: 'string', format: 'uuid' },
            display_name: { type: 'string', minLength: 1, maxLength: 200 },
            kind: { const: 'human' },
          },
        },
        {
          type: 'object',
          required: [
            'operation_id',
            'display_name',
            'kind',
            'agent_runtime',
            'parent_actor_id',
          ],
          additionalProperties: false,
          properties: {
            operation_id: { type: 'string', format: 'uuid' },
            display_name: { type: 'string', minLength: 1, maxLength: 200 },
            kind: { const: 'agent' },
            agent_runtime: { type: 'string', minLength: 1, maxLength: 120 },
            parent_actor_id: { type: 'string', format: 'uuid' },
          },
        },
      ],
    },
  },
  {
    name: 'sprino.actor.list',
    description:
      'List actors known to Sprino (Tessera v0.1.2). Optional kind filter.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['human', 'agent'] },
      },
    },
  },
  {
    name: 'sprino.actor.get',
    description: 'Fetch an actor by actor_id (Tessera v0.1.2).',
    inputSchema: {
      type: 'object',
      required: ['actor_id'],
      additionalProperties: false,
      properties: {
        actor_id: { type: 'string', format: 'uuid' },
      },
    },
  },
  {
    name: 'sprino.actor.heartbeat',
    description:
      'Record a liveness heartbeat for the authenticated agent actor. The actor_id must match the caller token.',
    inputSchema: {
      type: 'object',
      required: ['actor_id'],
      additionalProperties: false,
      properties: {
        actor_id: { type: 'string', format: 'uuid' },
      },
    },
  },
  {
    name: 'sprino.actor.revoke_token',
    description:
      'Revoke all active credentials for an actor (Tessera v0.1.2). Idempotent at both the operation_id layer and the domain layer (revoking an actor with no active tokens is a no-op).',
    inputSchema: {
      type: 'object',
      required: ['operation_id', 'actor_id'],
      additionalProperties: false,
      properties: {
        operation_id: { type: 'string', format: 'uuid' },
        actor_id: { type: 'string', format: 'uuid' },
      },
    },
  },
  {
    name: 'sprino.actor.deactivate',
    description:
      'Deactivate an agent session (Tessera v0.1.3). Caller MUST be a human actor; agents cannot deactivate sessions. Idempotent via operation_id; domain-idempotent (deactivating an already-inactive agent returns the actor envelope with no error).',
    inputSchema: {
      type: 'object',
      required: ['operation_id', 'actor_id'],
      additionalProperties: false,
      properties: {
        operation_id: { type: 'string', format: 'uuid' },
        actor_id: { type: 'string', format: 'uuid' },
      },
    },
  },
  {
    name: 'sprino.attachment.create_upload',
    description:
      'Reserve an upload slot for a file attachment (Tessera v0.1.4). Returns a pending attachment and an upload_url to PUT the binary bytes to before calling attachment.finalize. Idempotent via operation_id.',
    inputSchema: {
      type: 'object',
      required: ['operation_id', 'task_id', 'filename', 'content_type', 'size_bytes'],
      additionalProperties: false,
      properties: {
        operation_id: { type: 'string', format: 'uuid' },
        task_id: { type: 'string', format: 'uuid' },
        filename: { type: 'string', minLength: 1, maxLength: 255 },
        content_type: { type: 'string', minLength: 1, maxLength: 127 },
        size_bytes: { type: 'integer', minimum: 1 },
      },
    },
  },
  {
    name: 'sprino.attachment.finalize',
    description:
      'Confirm binary upload and transition attachment from pending to ready (Tessera v0.1.4). Call after PUT binary to upload_url. Idempotent via operation_id; domain-idempotent for already-ready attachments.',
    inputSchema: {
      type: 'object',
      required: ['operation_id', 'attachment_id'],
      additionalProperties: false,
      properties: {
        operation_id: { type: 'string', format: 'uuid' },
        attachment_id: { type: 'string', format: 'uuid' },
      },
    },
  },
  {
    name: 'sprino.attachment.get',
    description:
      'Fetch an attachment by id (Tessera v0.1.4). Returns any status (pending or ready). Does not expose upload_url.',
    inputSchema: {
      type: 'object',
      required: ['attachment_id'],
      additionalProperties: false,
      properties: {
        attachment_id: { type: 'string', format: 'uuid' },
      },
    },
  },
  {
    name: 'sprino.attachment.list',
    description:
      'List all ready attachments for a task (Tessera v0.1.4). Ordered by created_at ascending. Pending attachments are excluded.',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      additionalProperties: false,
      properties: {
        task_id: { type: 'string', format: 'uuid' },
      },
    },
  },
];

export function buildMcpRoutes(): Hono<Env> {
  const mcp = new Hono<Env>();

  mcp.post('/', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        rpcError(null, -32700, 'Parse error: invalid JSON'),
        400,
      );
    }

    const rpc = body as JsonRpcRequest;
    if (rpc?.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
      return c.json(rpcError(rpc?.id ?? null, -32600, 'Invalid Request'), 400);
    }

    const id = rpc.id ?? null;
    try {
      const result = await dispatch(c, rpc);
      return c.json({ jsonrpc: '2.0', id, result } satisfies JsonRpcResponse);
    } catch (err) {
      return c.json(translateError(id, err));
    }
  });

  return mcp;
}

async function dispatch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
  rpc: JsonRpcRequest,
): Promise<unknown> {
  if (rpc.method === 'tools/list') {
    return { tools: TOOL_DEFINITIONS };
  }

  if (rpc.method === 'tools/call') {
    const params = rpc.params as
      | { name?: string; arguments?: unknown }
      | undefined;
    const name = params?.name;
    const args = params?.arguments;
    if (typeof name !== 'string') {
      throw new RpcMethodError(-32602, 'Invalid params: name required');
    }
    return await callTool(c, name, args);
  }

  throw new RpcMethodError(-32601, `Method not found: ${rpc.method}`);
}

async function callTool(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
  name: string,
  args: unknown,
): Promise<unknown> {
  const db: Db = c.get('db');
  const actor: ActorEntry = c.get('actor');

  switch (name) {
    case 'sprino.project.list': {
      const res = await listProjects(db);
      return wrapToolResult(res);
    }
    case 'sprino.project.get': {
      const req = ProjectGetReqSchema.parse(args ?? {});
      const res = await getProject(db, { req });
      return wrapToolResult(res);
    }
    case 'sprino.task.create': {
      const req = TaskCreateReqSchema.parse(args);
      const res = await createTask(db, { req, actorId: actor.id });
      return wrapToolResult(res);
    }
    case 'sprino.task.get': {
      const req = TaskGetReqSchema.parse(args);
      const res = await getTask(db, { req });
      return wrapToolResult(res);
    }
    case 'sprino.task.update_status': {
      const req = TaskUpdateStatusReqSchema.parse(args);
      const res = await updateTaskStatus(db, { req, actorId: actor.id });
      return wrapToolResult(res);
    }
    case 'sprino.actor.register': {
      const req = ActorRegisterReqSchema.parse(args);
      const res = await registerActor(db, { req, callerId: actor.id });
      return wrapToolResult(res);
    }
    case 'sprino.actor.list': {
      const req = ActorListReqSchema.parse(args ?? {});
      const res = await listActors(db, { req });
      return wrapToolResult(res);
    }
    case 'sprino.actor.get': {
      const req = ActorGetReqSchema.parse(args);
      const res = await getActor(db, { req });
      return wrapToolResult(res);
    }
    case 'sprino.actor.heartbeat': {
      const req = ActorHeartbeatReqSchema.parse(args);
      const res = await heartbeatAgent(db, { req, callerId: actor.id });
      return wrapToolResult(res);
    }
    case 'sprino.actor.revoke_token': {
      const req = ActorRevokeTokenReqSchema.parse(args);
      const res = await revokeToken(db, { req, callerId: actor.id });
      return wrapToolResult(res);
    }
    case 'sprino.actor.deactivate': {
      const req = ActorDeactivateReqSchema.parse(args);
      const res = await deactivateAgent(db, {
        req,
        callerId: actor.id,
        callerKind: actor.kind,
        callerRole: actor.role,
      });
      return wrapToolResult(res);
    }
    case 'sprino.attachment.create_upload': {
      const req = AttachmentCreateUploadReqSchema.parse(args);
      const res = await createUpload(db, storage, { req, actorId: actor.id });
      return wrapToolResult(res);
    }
    case 'sprino.attachment.finalize': {
      const req = AttachmentFinalizeReqSchema.parse(args);
      const res = await finalize(db, storage, { req, actorId: actor.id });
      return wrapToolResult(res);
    }
    case 'sprino.attachment.get': {
      const req = AttachmentGetReqSchema.parse(args);
      const res = await getAttachment(db, { req });
      return wrapToolResult(res);
    }
    case 'sprino.attachment.list': {
      const req = AttachmentListReqSchema.parse(args);
      const res = await listAttachments(db, { req });
      return wrapToolResult(res);
    }
    default:
      throw new RpcMethodError(-32602, `Unknown tool: ${name}`);
  }
}

/**
 * MCP tool result envelope: { content: [{ type: 'text', text: '...' }] }.
 * We also include `structuredContent` (newer MCP feature) so MCP clients
 * that prefer typed objects don't have to parse the text blob.
 */
function wrapToolResult(payload: unknown): unknown {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

class RpcMethodError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
  }
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

function translateError(
  id: string | number | null,
  err: unknown,
): JsonRpcResponse {
  if (err instanceof ZodError) {
    return rpcError(id, -32602, 'Invalid params', err.issues);
  }
  if (err instanceof RpcMethodError) {
    return rpcError(id, err.code, err.message);
  }
  if (err instanceof ProjectNotFoundError) {
    return rpcError(id, -32004, 'project_not_found', { ref: err.ref });
  }
  if (err instanceof TaskNotFoundError) {
    return rpcError(id, -32004, 'task_not_found', { task_id: err.taskId });
  }
  if (err instanceof VersionMismatchError) {
    return rpcError(id, -32009, 'version_mismatch', {
      task: err.currentTask,
    });
  }
  if (err instanceof IdempotencyConflictError) {
    return rpcError(id, -32010, 'operation_id_conflict', {
      cached_response: err.cachedResponse,
    });
  }
  if (err instanceof OperationExpiredError) {
    return rpcError(id, -32011, 'operation_expired');
  }
  if (err instanceof ActorValidationError) {
    return rpcError(id, -32602, 'validation_error', {
      field: err.field,
      reason: err.reason,
    });
  }
  if (err instanceof ActorNotFoundError) {
    return rpcError(id, -32004, 'not_found', { actor_id: err.actorId });
  }
  if (err instanceof AuthorizationForbiddenError) {
    return rpcError(id, -32003, 'forbidden', {
      actor_id: err.actorId,
      capability: err.capability,
      reason: err.reason,
    });
  }
  if (err instanceof AgentHeartbeatForbiddenError) {
    return rpcError(id, -32003, 'forbidden', {
      actor_id: err.actorId,
      target_actor_id: err.targetActorId,
      reason: 'actor_mismatch',
    });
  }
  if (err instanceof LastAdminProtectedError) {
    return rpcError(id, -32012, 'last_admin_protected', {
      actor_id: err.actorId,
    });
  }
  if (err instanceof EnvActorImmutableError) {
    return rpcError(id, -32013, 'operation_unsupported', {
      actor_id: err.actorId,
    });
  }
  if (err instanceof ActorLifecycleTransitionError) {
    return rpcError(id, -32009, err.code, {
      actor_id: err.actorId,
      transition: err.transition,
      ...(err.fromState ? { from_state: err.fromState } : {}),
      ...(err.toState ? { to_state: err.toState } : {}),
      ...(err.actorKind ? { actor_kind: err.actorKind } : {}),
    });
  }
  if (err instanceof AttachmentNotFoundError) {
    return rpcError(id, -32004, 'attachment_not_found', {
      attachment_id: err.attachmentId,
    });
  }
  if (err instanceof AttachmentNotReadyError) {
    return rpcError(id, -32009, 'binary_not_uploaded', {
      attachment_id: err.attachmentId,
    });
  }
  if (err instanceof AttachmentTaskNotFoundError) {
    return rpcError(id, -32004, 'task_not_found', { task_id: err.taskId });
  }
  console.error('Unhandled MCP error:', err);
  return rpcError(id, -32603, 'Internal error');
}
