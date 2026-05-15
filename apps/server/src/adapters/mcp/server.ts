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
import { z, ZodError } from 'zod';
import type { ActorEntry } from '../../auth/registry.ts';
import type { Db } from '../../db/client.ts';
import type { AuthEnv } from '../../auth/middleware.ts';
import {
  AttachmentCreateUploadReqSchema,
  AttachmentFinalizeReqSchema,
  AttachmentGetReqSchema,
  AttachmentListReqSchema,
  ProjectCreateReqSchema,
  ProjectGetReqSchema,
  TaskCreateReqSchema,
  TaskGetReqSchema,
  AddDependencyReqSchema,
  ListDependenciesReqSchema,
  RemoveDependencyReqSchema,
  SetParentReqSchema,
  TaskReorderReqSchema,
  TaskUpdateStatusReqSchema,
  TaskTransitionWorkflowReqSchema,
  AssignToSprintReqSchema,
  RemoveFromSprintReqSchema,
  SprintCreateReqSchema,
  SprintGetReqSchema,
  SprintListReqSchema,
  SprintTransitionReqSchema,
  UpdateTaskPointsReqSchema,
  ActorRegisterReqSchema,
  ActorListReqSchema,
  ActorGetReqSchema,
  ActorHeartbeatReqSchema,
  ActorRevokeTokenReqSchema,
  ActorDeactivateReqSchema,
  SavedViewCreateReqSchema,
  AutomationRuleCreateReqSchema,
  EventKindSchema,
  AuditExportNotEnabledError,
  EntitlementLimitError,
  WorkspaceCreateReqSchema,
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
  DEFAULT_WORKSPACE_ID,
  ProjectNotFoundError,
  ProjectSlugConflictError,
  createProject,
  getProject,
  listProjects,
} from '../../service/projects.ts';
import {
  TaskNotFoundError,
  TaskNotInColumnError,
  VersionMismatchError,
  WorkflowColumnNotFoundError,
  WorkflowTransitionForbiddenError,
  addDependency,
  createTask,
  getTask,
  listDependencies,
  removeDependency,
  reorderTask,
  setParent,
  transitionTaskWorkflow,
  updateTaskStatus,
  updateTaskPoints,
} from '../../service/tasks.ts';
import {
  SprintAlreadyActiveError,
  SprintNotFoundError,
  TaskAlreadyInActiveSprintError,
  CrossProjectSprintError,
  InvalidSprintTransitionError,
  activateSprint,
  assignToSprint,
  closeSprint,
  getSprint,
  listSprints,
  removeFromSprint,
  createSprint,
} from '../../service/sprints.ts';
import {
  SavedViewNotFoundError,
  createSavedView,
  listSavedViews,
  deleteSavedView,
} from '../../service/query-language.ts';
import {
  AutomationRuleNotFoundError,
  createAutomationRule,
  listAutomationRules,
  deleteAutomationRule,
} from '../../service/automation.ts';
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
import { exportAuditEvents } from '../../service/audit-export.ts';
import { assertAuditExportEnabled } from '../../service/entitlements.ts';
import {
  WorkspaceNotFoundError,
  WorkspaceSlugConflictError,
  WorkspaceAdminRequiredError,
  WorkspaceMemberNotFoundError,
  WorkspaceLastAdminError,
  createWorkspace,
  listWorkspacesForActor,
  listWorkspaceMembers,
  addWorkspaceMember,
  removeWorkspaceMember,
  resolveWorkspaceById,
  resolveWorkspaceForActor,
} from '../../service/workspaces.ts';

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

const WORKSPACE_ID_PROP = {
  workspace_id: {
    type: 'string',
    format: 'uuid',
    description:
      'Workspace to operate in. Omit for single-workspace setups; required when your actor belongs to multiple workspaces.',
  },
} as const;

const TOOL_DEFINITIONS = [
  {
    name: 'sprino.workspace.list',
    description:
      'List all workspaces the calling actor is a member of. Use the returned workspace IDs as workspace_id in subsequent tool calls when your actor belongs to multiple workspaces.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'sprino.workspace.get',
    description:
      'Get details for a specific workspace. The calling actor must be a member.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', format: 'uuid', description: 'The workspace ID to fetch.' },
      },
      required: ['workspace_id'],
    },
  },
  {
    name: 'sprino.workspace.create',
    description:
      'Create a new workspace. The calling actor is automatically added as an admin member.',
    inputSchema: {
      type: 'object',
      required: ['name', 'slug'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 100 },
        slug: {
          type: 'string',
          minLength: 1,
          maxLength: 50,
          pattern: '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$',
        },
      },
    },
  },
  {
    name: 'sprino.workspace.member.list',
    description:
      'List all members of a workspace. The calling actor must be a member of the workspace.',
    inputSchema: {
      type: 'object',
      required: ['workspace_id'],
      additionalProperties: false,
      properties: {
        workspace_id: { type: 'string', format: 'uuid' },
      },
    },
  },
  {
    name: 'sprino.workspace.member.add',
    description:
      'Add an actor as a member of a workspace. The calling actor must be a workspace admin.',
    inputSchema: {
      type: 'object',
      required: ['workspace_id', 'actor_id'],
      additionalProperties: false,
      properties: {
        workspace_id: { type: 'string', format: 'uuid' },
        actor_id: { type: 'string', format: 'uuid' },
        role: { type: 'string', enum: ['admin', 'member'] },
      },
    },
  },
  {
    name: 'sprino.workspace.member.remove',
    description:
      'Remove a member from a workspace. The calling actor must be a workspace admin. Cannot remove the last admin.',
    inputSchema: {
      type: 'object',
      required: ['workspace_id', 'actor_id'],
      additionalProperties: false,
      properties: {
        workspace_id: { type: 'string', format: 'uuid' },
        actor_id: { type: 'string', format: 'uuid' },
      },
    },
  },
  {
    name: 'sprino.project.create',
    description:
      'Create a new project (Tessera v0.1.5). Idempotent via operation_id (UUIDv7). Returns the new project envelope. Fails with slug_conflict (409) if the slug is already taken.',
    inputSchema: {
      type: 'object',
      required: ['operation_id', 'slug', 'display_name'],
      additionalProperties: false,
      properties: {
        ...WORKSPACE_ID_PROP,
        operation_id: { type: 'string', format: 'uuid' },
        slug: {
          type: 'string',
          pattern: '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$',
          minLength: 1,
          maxLength: 64,
        },
        display_name: { type: 'string', minLength: 1, maxLength: 200 },
        repo_path: { type: ['string', 'null'], minLength: 1 },
      },
    },
  },
  {
    name: 'sprino.project.list',
    description:
      'List projects known to Sprino. Use this before task.create when no repo context is available.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...WORKSPACE_ID_PROP,
      },
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
        ...WORKSPACE_ID_PROP,
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
        ...WORKSPACE_ID_PROP,
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
      properties: {
        ...WORKSPACE_ID_PROP,
        task_id: { type: 'string', format: 'uuid' },
      },
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
        ...WORKSPACE_ID_PROP,
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
        ...WORKSPACE_ID_PROP,
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
  {
    name: 'sprino.task.transition_workflow',
    description:
      "Move a task to a different workflow column. Validates the transition against the project's allowed-transition graph. Idempotent via operation_id; concurrency-safe via if_match.",
    inputSchema: {
      type: 'object',
      required: ['operation_id', 'task_id', 'to_column_id', 'if_match'],
      additionalProperties: false,
      properties: {
        ...WORKSPACE_ID_PROP,
        operation_id: { type: 'string', format: 'uuid' },
        task_id: { type: 'string', format: 'uuid' },
        to_column_id: { type: 'string', format: 'uuid' },
        if_match: { type: 'integer', minimum: 1 },
        notes: { type: 'string', maxLength: 2048 },
      },
    },
  },
  {
    name: 'sprino.task.reorder',
    description:
      "Reorder a task within its current workflow column. after_task_id=null moves the task to the top of the column. Idempotent via operation_id. column_id must match the task's current workflow_column_id.",
    inputSchema: {
      type: 'object',
      required: ['operation_id', 'task_id', 'column_id', 'after_task_id'],
      additionalProperties: false,
      properties: {
        ...WORKSPACE_ID_PROP,
        operation_id: { type: 'string', format: 'uuid' },
        task_id: { type: 'string', format: 'uuid' },
        column_id: { type: 'string', format: 'uuid' },
        after_task_id: { type: ['string', 'null'], format: 'uuid' },
      },
    },
  },
  {
    name: 'sprino.task.set_parent',
    description:
      'Set or clear the parent task for a task. parent_task_id=null makes the task a root. Max hierarchy depth is 3 levels. Rejects cycles and cross-project parents.',
    inputSchema: {
      type: 'object',
      required: ['task_id', 'parent_task_id'],
      additionalProperties: false,
      properties: {
        ...WORKSPACE_ID_PROP,
        task_id: { type: 'string', format: 'uuid' },
        parent_task_id: { type: ['string', 'null'], format: 'uuid' },
      },
    },
  },
  {
    name: 'sprino.task.add_dependency',
    description:
      'Mark a task as blocked by another task. The from task (task_id) cannot move to doing or done until the blocking task (blocked_by_task_id) is done. Auto-sets task status to blocked. Rejects cycles.',
    inputSchema: {
      type: 'object',
      required: ['task_id', 'blocked_by_task_id'],
      additionalProperties: false,
      properties: {
        ...WORKSPACE_ID_PROP,
        task_id: { type: 'string', format: 'uuid' },
        blocked_by_task_id: { type: 'string', format: 'uuid' },
      },
    },
  },
  {
    name: 'sprino.task.remove_dependency',
    description:
      'Remove a blocked-by dependency. Does not auto-update task status — call task.update_status separately if the task is ready to proceed.',
    inputSchema: {
      type: 'object',
      required: ['task_id', 'blocked_by_task_id'],
      additionalProperties: false,
      properties: {
        ...WORKSPACE_ID_PROP,
        task_id: { type: 'string', format: 'uuid' },
        blocked_by_task_id: { type: 'string', format: 'uuid' },
      },
    },
  },
  {
    name: 'sprino.task.list_dependencies',
    description:
      'List all tasks that are blocking the given task (its blocked_by list).',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      additionalProperties: false,
      properties: {
        ...WORKSPACE_ID_PROP,
        task_id: { type: 'string', format: 'uuid' },
      },
    },
  },
  {
    name: 'sprino.sprint.create',
    description: 'Create a new sprint in a project. Idempotent via operation_id. Sprint starts in planning status.',
    inputSchema: {
      type: 'object',
      required: ['operation_id', 'project_id', 'name', 'starts_on', 'ends_on'],
      additionalProperties: false,
      properties: {
        ...WORKSPACE_ID_PROP,
        operation_id: { type: 'string', format: 'uuid' },
        project_id: { type: 'string', format: 'uuid' },
        name: { type: 'string', minLength: 1, maxLength: 200 },
        starts_on: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        ends_on: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
    },
  },
  {
    name: 'sprino.sprint.transition',
    description: 'Transition sprint status: planning→active or active→completed. Closing returns carry_over_tasks.',
    inputSchema: {
      type: 'object',
      required: ['operation_id', 'sprint_id', 'to_status', 'if_match'],
      additionalProperties: false,
      properties: {
        ...WORKSPACE_ID_PROP,
        operation_id: { type: 'string', format: 'uuid' },
        sprint_id: { type: 'string', format: 'uuid' },
        to_status: { type: 'string', enum: ['active', 'completed'] },
        if_match: { type: 'integer', minimum: 1 },
      },
    },
  },
  {
    name: 'sprino.sprint.list',
    description: 'List sprints for a project. Filter by status: planning, active, or completed.',
    inputSchema: {
      type: 'object',
      required: ['project_id'],
      additionalProperties: false,
      properties: {
        ...WORKSPACE_ID_PROP,
        project_id: { type: 'string', format: 'uuid' },
        status: { type: 'string', enum: ['planning', 'active', 'completed'] },
      },
    },
  },
  {
    name: 'sprino.sprint.get',
    description: 'Get a sprint with its tasks and burndown series (task count or story points).',
    inputSchema: {
      type: 'object',
      required: ['sprint_id'],
      additionalProperties: false,
      properties: {
        ...WORKSPACE_ID_PROP,
        sprint_id: { type: 'string', format: 'uuid' },
      },
    },
  },
  {
    name: 'sprino.task.assign_sprint',
    description: 'Assign a task to a sprint. Idempotent. A task can only be in one active sprint at a time.',
    inputSchema: {
      type: 'object',
      required: ['operation_id', 'sprint_id', 'task_id'],
      additionalProperties: false,
      properties: {
        ...WORKSPACE_ID_PROP,
        operation_id: { type: 'string', format: 'uuid' },
        sprint_id: { type: 'string', format: 'uuid' },
        task_id: { type: 'string', format: 'uuid' },
      },
    },
  },
  {
    name: 'sprino.task.remove_from_sprint',
    description: 'Remove a task from a sprint. No-op if not assigned.',
    inputSchema: {
      type: 'object',
      required: ['sprint_id', 'task_id'],
      additionalProperties: false,
      properties: {
        ...WORKSPACE_ID_PROP,
        sprint_id: { type: 'string', format: 'uuid' },
        task_id: { type: 'string', format: 'uuid' },
      },
    },
  },
  {
    name: 'sprino.task.set_points',
    description: 'Set or clear story points on a task. Null clears the estimate.',
    inputSchema: {
      type: 'object',
      required: ['operation_id', 'task_id', 'if_match'],
      additionalProperties: false,
      properties: {
        ...WORKSPACE_ID_PROP,
        operation_id: { type: 'string', format: 'uuid' },
        task_id: { type: 'string', format: 'uuid' },
        points: { type: ['integer', 'null'], minimum: 0 },
        if_match: { type: 'integer', minimum: 1 },
      },
    },
  },
  {
    name: 'sprino.saved_view.create',
    description: 'Create a project-shared saved view',
    inputSchema: {
      type: 'object',
      required: ['project_id', 'name', 'filters'],
      additionalProperties: false,
      properties: {
        ...WORKSPACE_ID_PROP,
        project_id: { type: 'string', format: 'uuid' },
        name: { type: 'string', minLength: 1, maxLength: 100 },
        filters: { type: 'object' },
      },
    },
  },
  {
    name: 'sprino.saved_view.list',
    description: 'List saved views for a project',
    inputSchema: {
      type: 'object',
      required: ['project_id'],
      additionalProperties: false,
      properties: {
        ...WORKSPACE_ID_PROP,
        project_id: { type: 'string', format: 'uuid' },
      },
    },
  },
  {
    name: 'sprino.saved_view.delete',
    description: 'Delete a saved view',
    inputSchema: {
      type: 'object',
      required: ['view_id', 'project_id'],
      additionalProperties: false,
      properties: {
        ...WORKSPACE_ID_PROP,
        view_id: { type: 'string', format: 'uuid' },
        project_id: { type: 'string', format: 'uuid' },
      },
    },
  },
  {
    name: 'sprino.automation_rule.create',
    description: 'Create a project automation rule',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...WORKSPACE_ID_PROP,
        project_id: { type: 'string', format: 'uuid' },
        name: { type: 'string', minLength: 1, maxLength: 200 },
        trigger_field: { type: 'string', enum: ['status', 'assignee_id'] },
        trigger_value: { type: 'string' },
        action_field: { type: 'string', enum: ['status', 'assignee_id'] },
        action_value: { type: 'string' },
      },
      required: ['project_id', 'name', 'trigger_field', 'action_field'],
    },
  },
  {
    name: 'sprino.automation_rule.list',
    description: 'List automation rules for a project',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...WORKSPACE_ID_PROP,
        project_id: { type: 'string', format: 'uuid' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'sprino.automation_rule.delete',
    description: 'Delete an automation rule',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...WORKSPACE_ID_PROP,
        rule_id: { type: 'string', format: 'uuid' },
        project_id: { type: 'string', format: 'uuid' },
      },
      required: ['rule_id', 'project_id'],
    },
  },
  {
    name: 'audit.export',
    description: 'Export paginated audit events for the current workspace.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['workspaceId'],
      properties: {
        workspaceId: { type: 'string', format: 'uuid' },
        actorId: { type: 'string', format: 'uuid' },
        kind: {
          type: 'string',
          enum: [
            'created',
            'status_changed',
            'assigned',
            'context_updated',
            'commented',
            'workflow_transitioned',
          ],
        },
        since: { type: 'string', format: 'date-time' },
        until: { type: 'string', format: 'date-time' },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
        offset: { type: 'integer', minimum: 0 },
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

async function resolveWorkspaceForMcp(
  db: Db,
  actorId: string,
  args: unknown,
): Promise<string> {
  const wsId = (args as Record<string, unknown> | null | undefined)?.workspace_id;
  if (typeof wsId === 'string') {
    const resolved = await resolveWorkspaceById(db, { workspaceId: wsId, actorId });
    if (!resolved) throw new RpcMethodError(-32003, 'workspace_not_found_or_not_member');
    return resolved.workspaceId;
  }
  const resolution = await resolveWorkspaceForActor(db, actorId);
  if (resolution.kind === 'resolved') return resolution.workspaceId;
  throw new RpcMethodError(-32003, 'workspace_id_required', {
    hint: 'Call sprino.workspace.list to get your workspace IDs, then pass workspace_id in tool arguments.',
  });
}

// Tools that bypass workspace resolution (manage workspaces themselves or are global)
const WORKSPACE_BYPASS = new Set([
  'sprino.workspace.list',
  'sprino.workspace.get',
  'sprino.workspace.create',
  'sprino.workspace.member.list',
  'sprino.workspace.member.add',
  'sprino.workspace.member.remove',
  'sprino.actor.register',
  'sprino.actor.get',
  'sprino.actor.heartbeat',
  'sprino.actor.revoke_token',
  'sprino.actor.deactivate',
  'audit.export', // audit.export handles its own workspace resolution via explicit workspaceId param
]);

async function callTool(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
  name: string,
  args: unknown,
): Promise<unknown> {
  const db: Db = c.get('db');
  const actor: ActorEntry = c.get('actor');

  let workspaceId: string = DEFAULT_WORKSPACE_ID;
  if (!WORKSPACE_BYPASS.has(name)) {
    workspaceId = await resolveWorkspaceForMcp(db, actor.id, args);
  }

  switch (name) {
    case 'sprino.workspace.list': {
      const res = await listWorkspacesForActor(db, actor.id);
      return wrapToolResult(res);
    }
    case 'sprino.workspace.get': {
      const { workspace_id } = z.object({ workspace_id: z.string().uuid() }).parse(args);
      const resolved = await resolveWorkspaceById(db, { workspaceId: workspace_id, actorId: actor.id });
      if (!resolved) throw new RpcMethodError(-32003, 'workspace_not_found_or_not_member');
      const { workspaces: all } = await listWorkspacesForActor(db, actor.id);
      const ws = all.find((w) => w.id === workspace_id);
      if (!ws) throw new RpcMethodError(-32003, 'workspace_not_found_or_not_member');
      return wrapToolResult({ workspace: ws });
    }
    case 'sprino.workspace.create': {
      const req = WorkspaceCreateReqSchema.parse(args);
      const res = await createWorkspace(db, { req, actorId: actor.id });
      return wrapToolResult(res);
    }
    case 'sprino.workspace.member.list': {
      const { workspace_id } = z.object({ workspace_id: z.string().uuid() }).parse(args);
      const res = await listWorkspaceMembers(db, { workspaceId: workspace_id, actorId: actor.id });
      return wrapToolResult(res);
    }
    case 'sprino.workspace.member.add': {
      const { workspace_id, actor_id, role } = z
        .object({
          workspace_id: z.string().uuid(),
          actor_id: z.string().uuid(),
          role: z.enum(['admin', 'member']).optional(),
        })
        .parse(args);
      await addWorkspaceMember(db, {
        workspaceId: workspace_id,
        req: { actor_id, role },
        adminActorId: actor.id,
      });
      return wrapToolResult({ ok: true });
    }
    case 'sprino.workspace.member.remove': {
      const { workspace_id, actor_id } = z
        .object({
          workspace_id: z.string().uuid(),
          actor_id: z.string().uuid(),
        })
        .parse(args);
      await removeWorkspaceMember(db, {
        workspaceId: workspace_id,
        actorId: actor_id,
        adminActorId: actor.id,
      });
      return wrapToolResult({ ok: true });
    }
    case 'sprino.project.create': {
      const req = ProjectCreateReqSchema.parse(args);
      const res = await createProject(db, { req, actorId: actor.id, workspaceId });
      return wrapToolResult(res);
    }
    case 'sprino.project.list': {
      const res = await listProjects(db, { workspaceId });
      return wrapToolResult(res);
    }
    case 'sprino.project.get': {
      const req = ProjectGetReqSchema.parse(args ?? {});
      const res = await getProject(db, { req, workspaceId });
      return wrapToolResult(res);
    }
    case 'sprino.task.create': {
      const req = TaskCreateReqSchema.parse(args);
      const res = await createTask(db, { req, actorId: actor.id, workspaceId });
      return wrapToolResult(res);
    }
    case 'sprino.task.get': {
      const req = TaskGetReqSchema.parse(args);
      const res = await getTask(db, { req, workspaceId });
      return wrapToolResult(res);
    }
    case 'sprino.task.update_status': {
      const req = TaskUpdateStatusReqSchema.parse(args);
      const res = await updateTaskStatus(db, { req, actorId: actor.id, workspaceId });
      return wrapToolResult(res);
    }
    case 'sprino.task.transition_workflow': {
      const req = TaskTransitionWorkflowReqSchema.parse(args);
      const res = await transitionTaskWorkflow(db, { req, actorId: actor.id, workspaceId });
      return wrapToolResult(res);
    }
    case 'sprino.task.reorder': {
      const req = TaskReorderReqSchema.parse(args);
      const res = await reorderTask(db, { req, actorId: actor.id, workspaceId });
      return wrapToolResult(res);
    }
    case 'sprino.task.set_parent': {
      const req = SetParentReqSchema.parse(args);
      const res = await setParent(db, {
        taskId: req.task_id,
        parentTaskId: req.parent_task_id,
        actorId: actor.id,
        workspaceId,
      });
      return wrapToolResult(res);
    }
    case 'sprino.task.add_dependency': {
      const req = AddDependencyReqSchema.parse(args);
      const res = await addDependency(db, {
        fromTaskId: req.task_id,
        toTaskId: req.blocked_by_task_id,
        actorId: actor.id,
        workspaceId,
      });
      return wrapToolResult(res);
    }
    case 'sprino.task.remove_dependency': {
      const req = RemoveDependencyReqSchema.parse(args);
      await removeDependency(db, {
        fromTaskId: req.task_id,
        toTaskId: req.blocked_by_task_id,
        actorId: actor.id,
        workspaceId,
      });
      return wrapToolResult({ ok: true });
    }
    case 'sprino.task.list_dependencies': {
      const req = ListDependenciesReqSchema.parse(args);
      const res = await listDependencies(db, { taskId: req.task_id });
      return wrapToolResult(res);
    }
    case 'sprino.actor.register': {
      const req = ActorRegisterReqSchema.parse(args);
      const res = await registerActor(db, { req, callerId: actor.id });
      return wrapToolResult(res);
    }
    case 'sprino.actor.list': {
      const req = ActorListReqSchema.parse(args ?? {});
      const res = await listActors(db, { req, workspaceId });
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
    case 'sprino.sprint.create': {
      const req = SprintCreateReqSchema.parse(args);
      const res = await createSprint(db, { req, actorId: actor.id });
      return wrapToolResult(res);
    }
    case 'sprino.sprint.transition': {
      const req = SprintTransitionReqSchema.parse(args);
      const res =
        req.to_status === 'active'
          ? await activateSprint(db, { req, actorId: actor.id })
          : await closeSprint(db, { req, actorId: actor.id });
      return wrapToolResult(res);
    }
    case 'sprino.sprint.list': {
      const req = SprintListReqSchema.parse(args);
      const res = await listSprints(db, { req });
      return wrapToolResult(res);
    }
    case 'sprino.sprint.get': {
      const req = SprintGetReqSchema.parse(args);
      const res = await getSprint(db, { req });
      return wrapToolResult(res);
    }
    case 'sprino.task.assign_sprint': {
      const req = AssignToSprintReqSchema.parse(args);
      const res = await assignToSprint(db, { req, actorId: actor.id });
      return wrapToolResult(res);
    }
    case 'sprino.task.remove_from_sprint': {
      const req = RemoveFromSprintReqSchema.parse(args);
      await removeFromSprint(db, { req, actorId: actor.id });
      return wrapToolResult({ ok: true });
    }
    case 'sprino.task.set_points': {
      const req = UpdateTaskPointsReqSchema.parse(args);
      const res = await updateTaskPoints(db, { req, actorId: actor.id, workspaceId });
      return wrapToolResult(res);
    }
    case 'sprino.saved_view.create': {
      const req = SavedViewCreateReqSchema.parse(args);
      const res = await createSavedView(db, { req, actorId: actor.id });
      return wrapToolResult(res);
    }
    case 'sprino.saved_view.list': {
      const projectId = z.object({ project_id: z.string().uuid() }).parse(args).project_id;
      const res = await listSavedViews(db, projectId);
      return wrapToolResult(res);
    }
    case 'sprino.saved_view.delete': {
      const { view_id, project_id } = z
        .object({ view_id: z.string().uuid(), project_id: z.string().uuid() })
        .parse(args);
      await deleteSavedView(db, { viewId: view_id, projectId: project_id });
      return wrapToolResult({});
    }
    case 'sprino.automation_rule.create': {
      const req = AutomationRuleCreateReqSchema.parse(args);
      const res = await createAutomationRule(db, { req, actorId: actor.id });
      return wrapToolResult(res);
    }
    case 'sprino.automation_rule.list': {
      const projectId = z.object({ project_id: z.string().uuid() }).parse(args).project_id;
      const res = await listAutomationRules(db, projectId);
      return wrapToolResult(res);
    }
    case 'sprino.automation_rule.delete': {
      const { rule_id, project_id } = z
        .object({ rule_id: z.string().uuid(), project_id: z.string().uuid() })
        .parse(args);
      await deleteAutomationRule(db, { ruleId: rule_id, projectId: project_id });
      return wrapToolResult({});
    }
    case 'audit.export': {
      const parsed = z
        .object({
          workspaceId: z.string().uuid(),
          actorId: z.string().uuid().optional(),
          kind: EventKindSchema.optional(),
          since: z.string().datetime({ offset: true }).optional(),
          until: z.string().datetime({ offset: true }).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        })
        .parse(args);
      const member = await resolveWorkspaceById(db, {
        workspaceId: parsed.workspaceId,
        actorId: actor.id,
      });
      if (!member) {
        throw new RpcMethodError(-32003, 'forbidden');
      }
      await assertAuditExportEnabled(db, parsed.workspaceId);
      const res = await exportAuditEvents(db, {
        workspaceId: parsed.workspaceId,
        actorId: parsed.actorId,
        kind: parsed.kind,
        since: parsed.since,
        until: parsed.until,
        limit: parsed.limit,
        offset: parsed.offset,
      });
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
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: Record<string, unknown>,
  ) {
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
    return rpcError(id, err.code, err.message, err.data);
  }
  if (err instanceof ProjectSlugConflictError) {
    return rpcError(id, -32009, 'slug_conflict', { slug: err.slug });
  }
  if (err instanceof ProjectNotFoundError) {
    return rpcError(id, -32004, 'project_not_found', { ref: err.ref });
  }
  if (err instanceof TaskNotFoundError) {
    return rpcError(id, -32004, 'task_not_found', { task_id: err.taskId });
  }
  if (err instanceof TaskNotInColumnError) {
    return rpcError(id, -32010, 'task_not_in_column', {
      task_id: err.taskId,
      column_id: err.columnId,
    });
  }
  if (err instanceof VersionMismatchError) {
    return rpcError(id, -32009, 'version_mismatch', {
      task: err.currentTask,
    });
  }
  if (err instanceof WorkflowTransitionForbiddenError) {
    return rpcError(id, -32009, 'workflow_transition_forbidden', {
      from_column_id: err.fromColumnId,
      to_column_id: err.toColumnId,
    });
  }
  if (err instanceof WorkflowColumnNotFoundError) {
    return rpcError(id, -32004, 'workflow_column_not_found', {
      column_id: err.columnId,
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
  if (err instanceof SprintNotFoundError) {
    return rpcError(id, -32004, 'sprint_not_found', { sprint_id: err.sprintId });
  }
  if (err instanceof SprintAlreadyActiveError) {
    return rpcError(id, -32009, 'sprint_already_active', { sprint_id: err.existingSprintId });
  }
  if (err instanceof TaskAlreadyInActiveSprintError) {
    return rpcError(id, -32009, 'task_already_in_active_sprint', { task_id: err.taskId });
  }
  if (err instanceof CrossProjectSprintError) {
    return rpcError(id, -32602, 'cross_project_sprint', {});
  }
  if (err instanceof InvalidSprintTransitionError) {
    return rpcError(id, -32602, 'invalid_sprint_transition', { from: err.from, to: err.to });
  }
  if (err instanceof SavedViewNotFoundError) {
    return rpcError(id, -32004, 'saved_view_not_found', { view_id: err.viewId });
  }
  if (err instanceof AutomationRuleNotFoundError) {
    return rpcError(id, -32004, 'automation_rule_not_found', { rule_id: err.ruleId });
  }
  if (err instanceof WorkspaceNotFoundError) {
    return rpcError(id, -32003, 'workspace_not_found_or_not_member', { workspace_id: err.workspaceId });
  }
  if (err instanceof WorkspaceSlugConflictError) {
    return rpcError(id, -32009, 'slug_conflict', { slug: err.slug });
  }
  if (err instanceof WorkspaceAdminRequiredError) {
    return rpcError(id, -32003, 'workspace_admin_required', { actor_id: err.actorId });
  }
  if (err instanceof WorkspaceMemberNotFoundError) {
    return rpcError(id, -32004, 'member_not_found', { actor_id: err.actorId });
  }
  if (err instanceof WorkspaceLastAdminError) {
    return rpcError(id, -32009, 'last_admin_protected', { workspace_id: err.workspaceId });
  }
  if (err instanceof AuditExportNotEnabledError) {
    return rpcError(id, -32003, 'audit_export_not_enabled', {
      workspace_id: err.workspaceId,
    });
  }
  if (err instanceof EntitlementLimitError) {
    return rpcError(id, -32003, 'entitlement_limit', {
      resource: err.resource,
      limit: err.limit,
    });
  }
  console.error('Unhandled MCP error:', err);
  return rpcError(id, -32603, 'Internal error');
}
