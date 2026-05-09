// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * HTTP adapter — thin routes calling the service/ layer.
 *
 *   POST   /api/tasks                → createTask
 *   GET    /api/tasks/:id            → getTask
 *   PATCH  /api/tasks/:id/status     → updateTaskStatus
 *   GET    /api/projects             → listProjects
 *   GET    /api/projects/resolve     → resolveProject (by slug or repo_path)
 *   GET    /api/projects/:id         → getProject
 *   GET    /api/events               → listEvents (Sprino activity feed)
 *   GET    /api/agents               → listAgents (Sprino registry view)
 *
 * No business logic in this file. Translation only:
 *   - parse request body / query via Zod
 *   - call service layer
 *   - map domain errors to HTTP status codes:
 *       TaskNotFoundError       → 404
 *       ProjectNotFoundError    → 404
 *       VersionMismatchError    → 409 with current task body
 *       IdempotencyConflictError → 409 with cached response body
 *       OperationExpiredError   → 410
 *       ZodError                → 400 with validation details
 */

import { Hono } from 'hono';
import type { AuthEnv } from '../../auth/middleware.ts';
import { workspaceAuth } from '../../auth/middleware.ts';
import {
  AgentListReqSchema,
  AttachmentCreateUploadReqSchema,
  AttachmentFinalizeReqSchema,
  AttachmentListReqSchema,
  EventListReqSchema,
  ProjectCreateReqSchema,
  ProjectGetReqSchema,
  TaskCreateReqSchema,
  TaskGetReqSchema,
  TaskListReqSchema,
  AddDependencyReqSchema,
  ListDependenciesReqSchema,
  RemoveDependencyReqSchema,
  SetParentReqSchema,
  TaskReorderReqSchema,
  TaskUpdateStatusReqSchema,
  TaskTransitionWorkflowReqSchema,
  ActorRegisterReqSchema,
  ActorListReqSchema,
  ActorGetReqSchema,
  ActorHeartbeatReqSchema,
  ActorRevokeTokenReqSchema,
  ActorDeactivateReqSchema,
  AssignToSprintReqSchema,
  RemoveFromSprintReqSchema,
  SprintCreateReqSchema,
  SprintGetReqSchema,
  SprintListReqSchema,
  SprintTransitionReqSchema,
  UpdateTaskPointsReqSchema,
  SavedViewCreateReqSchema,
  AutomationRuleCreateReqSchema,
  WorkspaceCreateReqSchema,
  WorkspaceMemberAddReqSchema,
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
  ProjectNotFoundError,
  ProjectSlugConflictError,
  createProject,
  getProject,
  listProjects,
} from '../../service/projects.ts';
import { listEvents } from '../../service/events.ts';
import { listAgents } from '../../service/agents.ts';
import {
  AgentHeartbeatForbiddenError,
  deactivateAgent,
  heartbeatAgent,
} from '../../service/agent-lifecycle.ts';
import {
  ActorNotFoundError,
  ActorLifecycleTransitionError,
  ActorValidationError,
  ConcurrentRotationError,
  EnvActorImmutableError,
  LastAdminProtectedError,
  getActor,
  listActors,
  listMembers,
  registerActor,
  revokeToken,
  rotateToken,
} from '../../service/actors.ts';
import { assertProjectInWorkspace, AuthorizationForbiddenError, WorkspaceIsolationError } from '../../service/authorization.ts';
import { issueStreamTicket } from '../../auth/stream-ticket.ts';
import {
  WorkspaceNotFoundError,
  WorkspaceSlugConflictError,
  WorkspaceMemberNotFoundError,
  WorkspaceAdminRequiredError,
  WorkspaceLastAdminError,
  createWorkspace,
  listWorkspacesForActor,
  listWorkspaceMembers,
  addWorkspaceMember,
  removeWorkspaceMember,
} from '../../service/workspaces.ts';
import {
  ChildrenNotDoneError,
  CrossProjectRelationError,
  DependencyCycleDetectedError,
  DependencyNotResolvedError,
  HierarchyDepthExceededError,
  ParentCycleDetectedError,
  TaskNotFoundError,
  TaskNotInColumnError,
  VersionMismatchError,
  WorkflowColumnNotFoundError,
  WorkflowTransitionForbiddenError,
  addDependency,
  createTask,
  getTask,
  listDependencies,
  listRelatedTasks,
  listTaskEvents,
  listTasks,
  listWorkflowColumns,
  removeDependency,
  reorderTask,
  setParent,
  transitionTaskWorkflow,
  updateTaskPoints,
  updateTaskStatus,
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
import { ZodError } from 'zod';

export function buildHttpRoutes(): Hono<AuthEnv> {
  const api = new Hono<AuthEnv>();

  // ── Workspace bypass routes (no workspace context required) ───────────────

  api.post('/workspaces', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const req = WorkspaceCreateReqSchema.parse(body);
      const actor = c.get('actor');
      const res = await createWorkspace(c.get('db'), { req, actorId: actor.id });
      return c.json(res, 201);
    } catch (err) {
      return workspaceErrorResponse(c, err);
    }
  });

  api.get('/workspaces', async (c) => {
    try {
      const actor = c.get('actor');
      const res = await listWorkspacesForActor(c.get('db'), actor.id);
      return c.json(res, 200);
    } catch (err) {
      return workspaceErrorResponse(c, err);
    }
  });

  // ── Actor lifecycle bypass routes (no workspace context required) ─────────
  // Actor operations are global: actors exist across workspaces. Only
  // GET /actors (listMembers, workspace-scoped) lives in the ws sub-router.
  // These use the `_error` envelope per Tessera v0.1.2 conformance.

  api.post('/actors', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const req = ActorRegisterReqSchema.parse(body);
      const actor = c.get('actor');
      const res = await registerActor(c.get('db'), {
        req,
        callerId: actor.id,
      });
      return c.json(res, 201);
    } catch (err) {
      return actorErrorResponse(c, err);
    }
  });

  api.get('/actors/:id', async (c) => {
    try {
      const req = ActorGetReqSchema.parse({ actor_id: c.req.param('id') });
      const res = await getActor(c.get('db'), { req });
      return c.json(res, 200);
    } catch (err) {
      return actorErrorResponse(c, err);
    }
  });

  api.post('/actors/:id/revoke_token', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const req = ActorRevokeTokenReqSchema.parse({
        ...body,
        actor_id: c.req.param('id'),
      });
      const actor = c.get('actor');
      const res = await revokeToken(c.get('db'), {
        req,
        callerId: actor.id,
      });
      return c.json(res, 200);
    } catch (err) {
      return actorErrorResponse(c, err);
    }
  });

  api.post('/actors/:id/heartbeat', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const req = ActorHeartbeatReqSchema.parse({
        ...body,
        actor_id: c.req.param('id'),
      });
      const actor = c.get('actor');
      const res = await heartbeatAgent(c.get('db'), {
        req,
        callerId: actor.id,
      });
      return c.json(res, 200);
    } catch (err) {
      return actorErrorResponse(c, err);
    }
  });

  api.post('/actors/:id/deactivate', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const req = ActorDeactivateReqSchema.parse({
        ...body,
        actor_id: c.req.param('id'),
      });
      const actor = c.get('actor');
      const res = await deactivateAgent(c.get('db'), {
        req,
        callerId: actor.id,
        callerKind: actor.kind,
        callerRole: actor.role,
      });
      return c.json(res, 200);
    } catch (err) {
      return actorErrorResponse(c, err);
    }
  });

  // Sprino-only HTTP extension. NOT a Tessera verb — operators "I lost the
  // token" recovery flow only. No idempotency: every successful call mints
  // and returns a fresh plaintext.
  api.post('/actors/:id/rotate_token', async (c) => {
    try {
      const res = await rotateToken(c.get('db'), {
        actorId: c.req.param('id'),
        callerId: c.get('actor').id,
      });
      return c.json(res, 200);
    } catch (err) {
      return actorErrorResponse(c, err);
    }
  });

  // ── Workspace-scoped sub-router (workspaceAuth required) ─────────────────
  const ws = new Hono<AuthEnv>();
  ws.use('*', workspaceAuth);

  // ── project.create (Tessera v0.1.5) ─────────────────────────────────────
  ws.post('/projects', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const req = ProjectCreateReqSchema.parse(body);
      const actor = c.get('actor');
      const res = await createProject(c.get('db'), {
        req,
        actorId: actor.id,
        workspaceId: c.get('workspace')!.id,
      });
      return c.json(res, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  ws.get('/projects', async (c) => {
    try {
      const res = await listProjects(c.get('db'), { workspaceId: c.get('workspace')!.id });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  ws.get('/projects/resolve', async (c) => {
    try {
      const req = ProjectGetReqSchema.parse({
        slug: c.req.query('slug') || undefined,
        repo_path: c.req.query('repo_path') || undefined,
      });
      const res = await getProject(c.get('db'), { req, workspaceId: c.get('workspace')!.id });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  ws.get('/projects/:id', async (c) => {
    try {
      const req = ProjectGetReqSchema.parse({
        project_id: c.req.param('id'),
      });
      const res = await getProject(c.get('db'), { req, workspaceId: c.get('workspace')!.id });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  ws.get('/projects/:id/workflow-columns', async (c) => {
    try {
      await assertProjectInWorkspace(c.get('db'), { projectId: c.req.param('id'), workspaceId: c.get('workspace')!.id });
      const res = await listWorkflowColumns(c.get('db'), {
        projectId: c.req.param('id'),
      });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // Sprino-specific list extension — see service/tasks.ts.listTasks.
  // Not exposed via /mcp to keep the canonical protocol minimal.
  ws.get('/tasks', async (c) => {
    try {
      const statusParam = c.req.queries('status') ?? [];
      const req = TaskListReqSchema.parse({
        project_id: c.req.query('project_id'),
        status: statusParam.length > 0 ? statusParam : undefined,
        assignee_id: c.req.query('assignee_id') ?? undefined,
        parent_task_id: c.req.query('parent_task_id') ?? undefined,
        title_contains: c.req.query('title_contains') ?? undefined,
        sprint_id: c.req.query('sprint_id') ?? undefined,
        limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
        offset: c.req.query('offset') ? Number(c.req.query('offset')) : undefined,
      });
      const res = await listTasks(c.get('db'), { req, workspaceId: c.get('workspace')!.id });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  ws.post('/tasks', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const req = TaskCreateReqSchema.parse(body);
      const actor = c.get('actor');
      const res = await createTask(c.get('db'), { req, actorId: actor.id, workspaceId: c.get('workspace')!.id });
      return c.json(res, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  ws.get('/tasks/:id', async (c) => {
    try {
      const req = TaskGetReqSchema.parse({ task_id: c.req.param('id') });
      const res = await getTask(c.get('db'), { req, workspaceId: c.get('workspace')!.id });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  ws.patch('/tasks/:id/status', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const req = TaskUpdateStatusReqSchema.parse({
        ...body,
        task_id: c.req.param('id'),
      });
      const actor = c.get('actor');
      const res = await updateTaskStatus(c.get('db'), {
        req,
        actorId: actor.id,
        workspaceId: c.get('workspace')!.id,
      });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  ws.post('/tasks/:id/transition', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const req = TaskTransitionWorkflowReqSchema.parse({
        ...body,
        task_id: c.req.param('id'),
      });
      const actor = c.get('actor');
      const res = await transitionTaskWorkflow(c.get('db'), {
        req,
        actorId: actor.id,
        workspaceId: c.get('workspace')!.id,
      });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  ws.post('/tasks/:id/reorder', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const req = TaskReorderReqSchema.parse({
        ...body,
        task_id: c.req.param('id'),
      });
      const actor = c.get('actor');
      const res = await reorderTask(c.get('db'), { req, actorId: actor.id, workspaceId: c.get('workspace')!.id });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  ws.patch('/tasks/:id/parent', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const req = SetParentReqSchema.parse({ ...body, task_id: c.req.param('id') });
      const actor = c.get('actor');
      const res = await setParent(c.get('db'), {
        taskId: req.task_id,
        parentTaskId: req.parent_task_id,
        actorId: actor.id,
        workspaceId: c.get('workspace')!.id,
      });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  ws.post('/tasks/:id/dependencies', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const req = AddDependencyReqSchema.parse({
        task_id: c.req.param('id'),
        blocked_by_task_id: body?.blocked_by_task_id,
      });
      const actor = c.get('actor');
      const res = await addDependency(c.get('db'), {
        fromTaskId: req.task_id,
        toTaskId: req.blocked_by_task_id,
        actorId: actor.id,
        workspaceId: c.get('workspace')!.id,
      });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  ws.delete('/tasks/:id/dependencies/:depId', async (c) => {
    try {
      const actor = c.get('actor');
      await removeDependency(c.get('db'), {
        fromTaskId: c.req.param('id'),
        toTaskId: c.req.param('depId'),
        actorId: actor.id,
        workspaceId: c.get('workspace')!.id,
      });
      return new Response(null, { status: 204 });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  ws.get('/tasks/:id/dependencies', async (c) => {
    try {
      const req = ListDependenciesReqSchema.parse({ task_id: c.req.param('id') });
      const res = await listDependencies(c.get('db'), { taskId: req.task_id });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // Pagination companions to task.get's agent_context. When agent_context
  // truncates (>32KB), the next_page_tokens point clients here for the tail.
  ws.get('/tasks/:id/events', async (c) => {
    try {
      const { limit, offset } = parseLimitOffset(c.req.query.bind(c.req));
      const res = await listTaskEvents(c.get('db'), {
        taskId: c.req.param('id'),
        limit,
        offset,
      });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  ws.get('/tasks/:id/related_tasks', async (c) => {
    try {
      const { limit, offset } = parseLimitOffset(c.req.query.bind(c.req));
      const res = await listRelatedTasks(c.get('db'), {
        taskId: c.req.param('id'),
        limit,
        offset,
      });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // Sprino-specific activity feed endpoint — see service/events.ts.
  // Project-scoped event log with denormalized actor + task fields. Not
  // exposed via /mcp; agents read events through task.get's recent_events.
  ws.get('/events', async (c) => {
    try {
      // Pass raw query strings into the schema. Zod's `z.coerce.number()`
      // (configured in EventListReqSchema) rejects malformed values like
      // `?limit=abc` or `?limit=` with a 400, instead of silently treating
      // them as "absent".
      const req = EventListReqSchema.parse({
        project_id: c.req.query('project_id'),
        task_id: c.req.query('task_id'),
        limit: c.req.query('limit'),
        offset: c.req.query('offset'),
      });
      if (req.project_id) {
        await assertProjectInWorkspace(c.get('db'), { projectId: req.project_id, workspaceId: c.get('workspace')!.id });
      }
      const res = await listEvents(c.get('db'), { req });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // Sprino-specific agent registry list — see service/agents.ts.
  // Reads the actors table (DB-unified after v0.0.9). Tokens are never
  // returned. Hard cap of 100 per page (see MAX_LIMITS.agents).
  ws.get('/agents', async (c) => {
    try {
      const req = AgentListReqSchema.parse({
        limit: c.req.query('limit'),
        offset: c.req.query('offset'),
      });
      const res = await listAgents(c.get('db'), { req });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // Mints a short-lived signed ticket so the browser EventSource can auth
  // the SSE stream (which can't send Authorization headers). See
  // auth/stream-ticket.ts. The ticket is bound to (actor, project) and
  // expires in 60s. Bearer-protected; the SSE endpoint itself is mounted
  // outside this Hono router with its own ticket-auth.
  ws.post('/events/stream-ticket', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const projectId =
        typeof body?.project_id === 'string' ? body.project_id : '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
        return c.json(
          { error: 'validation_error', detail: 'project_id must be a uuid' },
          400,
        );
      }
      const actor = c.get('actor');
      const out = issueStreamTicket(actor.id, projectId);
      // Defense-in-depth: never let a CDN cache a ticket.
      c.header('Cache-Control', 'no-store');
      return c.json(out, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // ── Tessera v0.1.2 actor lifecycle (workspace-scoped) ────────────────────
  // These endpoints use the `_error` envelope (per the v0.1.2 conformance
  // fixtures) instead of the flat error shape used by tasks/projects. The
  // shape divergence is intentional — Tessera is migrating toward the
  // envelope, but breaking task error shapes at the same time would
  // explode the conformance diff. See plan §Slice K for the rationale.

  ws.get('/actors', async (c) => {
    try {
      const kind = c.req.query('kind');
      const req = ActorListReqSchema.parse(kind ? { kind } : {});
      // Sprino-internal: surface source + revoked_at so the Members UI
      // can distinguish env vs db actors and render revocation status.
      // MCP `actor.list` continues to return the canonical Tessera shape.
      const res = await listMembers(c.get('db'), { req, workspaceId: c.get('workspace')!.id });
      return c.json(res, 200);
    } catch (err) {
      return actorErrorResponse(c, err);
    }
  });

  // ── Tessera v0.1.4 attachment verbs ────────────────────────────────────
  // Two-phase upload: POST /attachments → PUT /attachments/:id/upload → POST /attachments/:id/finalize.
  // GET /attachments/:id and GET /tasks/:id/attachments are read-only.

  ws.post('/attachments', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const req = AttachmentCreateUploadReqSchema.parse(body);
      const actor = c.get('actor');
      const res = await createUpload(c.get('db'), storage, {
        req,
        actorId: actor.id,
      });
      return c.json(res, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  ws.put('/attachments/:id/upload', async (c) => {
    try {
      const attachmentId = c.req.param('id');
      // Verify the slot exists and is still pending before writing bytes.
      // Prevents orphan blobs from arbitrary UUIDs and overwrites of finalized attachments.
      const { attachment } = await getAttachment(c.get('db'), {
        req: { attachment_id: attachmentId },
      });
      if (attachment.status !== 'pending') {
        return c.json(
          { error: 'attachment_already_finalized', attachment_id: attachmentId },
          409,
        );
      }
      const data = await c.req.arrayBuffer();
      await storage.write(attachmentId, Buffer.from(data));
      return new Response(null, { status: 204 });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Invalid attachment id')) {
        return c.json({ error: 'validation_error', details: err.message }, 400);
      }
      return errorResponse(c, err);
    }
  });

  ws.get('/attachments/:id/download', async (c) => {
    try {
      const attachmentId = c.req.param('id');
      const { attachment } = await getAttachment(c.get('db'), {
        req: { attachment_id: attachmentId },
      });
      if (attachment.status !== 'ready') {
        return c.json(
          { error: 'binary_not_uploaded', attachment_id: attachmentId },
          409,
        );
      }
      const data = await storage.read(attachmentId);
      return new Response(data, {
        status: 200,
        headers: { 'Content-Type': attachment.content_type },
      });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  ws.post('/attachments/:id/finalize', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const req = AttachmentFinalizeReqSchema.parse({
        ...body,
        attachment_id: c.req.param('id'),
      });
      const actor = c.get('actor');
      const res = await finalize(c.get('db'), storage, {
        req,
        actorId: actor.id,
      });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  ws.get('/attachments/:id', async (c) => {
    try {
      const res = await getAttachment(c.get('db'), {
        req: { attachment_id: c.req.param('id') },
      });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  ws.get('/tasks/:id/attachments', async (c) => {
    try {
      const req = AttachmentListReqSchema.parse({
        task_id: c.req.param('id'),
        limit: c.req.query('limit'),
        offset: c.req.query('offset'),
      });
      const res = await listAttachments(c.get('db'), { req });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // ── D4: Sprint routes ─────────────────────────────────────────────────────

  ws.post('/projects/:id/sprints', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const req = SprintCreateReqSchema.parse({ ...body, project_id: c.req.param('id') });
      await assertProjectInWorkspace(c.get('db'), { projectId: req.project_id, workspaceId: c.get('workspace')!.id });
      const actor = c.get('actor');
      const res = await createSprint(c.get('db'), { req, actorId: actor.id });
      return c.json(res, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  ws.get('/projects/:id/sprints', async (c) => {
    try {
      const req = SprintListReqSchema.parse({
        project_id: c.req.param('id'),
        status: c.req.query('status') || undefined,
      });
      await assertProjectInWorkspace(c.get('db'), { projectId: req.project_id, workspaceId: c.get('workspace')!.id });
      const res = await listSprints(c.get('db'), { req });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  ws.get('/sprints/:id', async (c) => {
    try {
      const req = SprintGetReqSchema.parse({ sprint_id: c.req.param('id') });
      const res = await getSprint(c.get('db'), { req });
      await assertProjectInWorkspace(c.get('db'), { projectId: res.sprint.project_id, workspaceId: c.get('workspace')!.id });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  ws.patch('/sprints/:id/status', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const req = SprintTransitionReqSchema.parse({ ...body, sprint_id: c.req.param('id') });
      const { sprint } = await getSprint(c.get('db'), { req: { sprint_id: req.sprint_id } });
      await assertProjectInWorkspace(c.get('db'), { projectId: sprint.project_id, workspaceId: c.get('workspace')!.id });
      const actor = c.get('actor');
      const res =
        req.to_status === 'active'
          ? await activateSprint(c.get('db'), { req, actorId: actor.id })
          : await closeSprint(c.get('db'), { req, actorId: actor.id });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  ws.post('/sprints/:id/tasks', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const req = AssignToSprintReqSchema.parse({ ...body, sprint_id: c.req.param('id') });
      const { sprint } = await getSprint(c.get('db'), { req: { sprint_id: req.sprint_id } });
      await assertProjectInWorkspace(c.get('db'), { projectId: sprint.project_id, workspaceId: c.get('workspace')!.id });
      const actor = c.get('actor');
      const res = await assignToSprint(c.get('db'), { req, actorId: actor.id });
      return c.json(res, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  ws.delete('/sprints/:id/tasks/:taskId', async (c) => {
    try {
      const req = RemoveFromSprintReqSchema.parse({
        sprint_id: c.req.param('id'),
        task_id: c.req.param('taskId'),
      });
      const { sprint } = await getSprint(c.get('db'), { req: { sprint_id: req.sprint_id } });
      await assertProjectInWorkspace(c.get('db'), { projectId: sprint.project_id, workspaceId: c.get('workspace')!.id });
      const actor = c.get('actor');
      await removeFromSprint(c.get('db'), { req, actorId: actor.id });
      return c.json({ ok: true }, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  ws.patch('/tasks/:id/points', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const req = UpdateTaskPointsReqSchema.parse({ ...body, task_id: c.req.param('id') });
      const actor = c.get('actor');
      const res = await updateTaskPoints(c.get('db'), { req, actorId: actor.id, workspaceId: c.get('workspace')!.id });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // ── D5: Saved views ──────────────────────────────────────────────────────

  ws.post('/projects/:id/saved-views', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const req = SavedViewCreateReqSchema.parse({
        ...body,
        project_id: c.req.param('id'),
      });
      await assertProjectInWorkspace(c.get('db'), { projectId: req.project_id, workspaceId: c.get('workspace')!.id });
      const actor = c.get('actor');
      const res = await createSavedView(c.get('db'), { req, actorId: actor.id });
      return c.json(res, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  ws.get('/projects/:id/saved-views', async (c) => {
    try {
      await assertProjectInWorkspace(c.get('db'), { projectId: c.req.param('id'), workspaceId: c.get('workspace')!.id });
      const res = await listSavedViews(c.get('db'), c.req.param('id'));
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  ws.delete('/projects/:id/saved-views/:viewId', async (c) => {
    try {
      await assertProjectInWorkspace(c.get('db'), { projectId: c.req.param('id'), workspaceId: c.get('workspace')!.id });
      await deleteSavedView(c.get('db'), {
        viewId: c.req.param('viewId'),
        projectId: c.req.param('id'),
      });
      return c.json({}, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // ── D5: Automation rules ─────────────────────────────────────────────────

  ws.post('/projects/:id/automation-rules', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const req = AutomationRuleCreateReqSchema.parse({
        ...body,
        project_id: c.req.param('id'),
      });
      await assertProjectInWorkspace(c.get('db'), { projectId: req.project_id, workspaceId: c.get('workspace')!.id });
      const actor = c.get('actor');
      const res = await createAutomationRule(c.get('db'), { req, actorId: actor.id });
      return c.json(res, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  ws.get('/projects/:id/automation-rules', async (c) => {
    try {
      await assertProjectInWorkspace(c.get('db'), { projectId: c.req.param('id'), workspaceId: c.get('workspace')!.id });
      const res = await listAutomationRules(c.get('db'), c.req.param('id'));
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  ws.delete('/projects/:id/automation-rules/:ruleId', async (c) => {
    try {
      await assertProjectInWorkspace(c.get('db'), { projectId: c.req.param('id'), workspaceId: c.get('workspace')!.id });
      await deleteAutomationRule(c.get('db'), {
        ruleId: c.req.param('ruleId'),
        projectId: c.req.param('id'),
      });
      return c.json({}, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  api.route('/', ws);

  // ── Workspace member routes (bypass — service guards membership internally) ─
  // These are intentionally placed AFTER ws is mounted so the auth middleware
  // has already validated the bearer token, but they do NOT require a workspace
  // context header. The service functions verify the caller is a member of the
  // *requested* workspace before acting (preventing IDOR cross-workspace access).

  api.get('/workspaces/:id/members', async (c) => {
    try {
      const res = await listWorkspaceMembers(c.get('db'), {
        workspaceId: c.req.param('id'),
        actorId: c.get('actor').id,
      });
      return c.json(res, 200);
    } catch (err) {
      return workspaceErrorResponse(c, err);
    }
  });

  api.post('/workspaces/:id/members', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const req = WorkspaceMemberAddReqSchema.parse(body);
      await addWorkspaceMember(c.get('db'), {
        workspaceId: c.req.param('id'),
        req,
        adminActorId: c.get('actor').id,
      });
      return c.json({}, 201);
    } catch (err) {
      return workspaceErrorResponse(c, err);
    }
  });

  api.delete('/workspaces/:id/members/:actorId', async (c) => {
    try {
      await removeWorkspaceMember(c.get('db'), {
        workspaceId: c.req.param('id'),
        actorId: c.req.param('actorId'),
        adminActorId: c.get('actor').id,
      });
      return new Response(null, { status: 204 });
    } catch (err) {
      return workspaceErrorResponse(c, err);
    }
  });

  return api;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function workspaceErrorResponse(c: any, err: unknown): Response {
  if (err instanceof ZodError) {
    return c.json({ error: 'validation_error', details: err.issues }, 400);
  }
  if (err instanceof WorkspaceSlugConflictError) {
    return c.json({ error: 'workspace_slug_conflict', slug: err.slug }, 409);
  }
  if (err instanceof WorkspaceNotFoundError) {
    return c.json({ error: 'workspace_not_found', workspace_id: err.workspaceId }, 404);
  }
  if (err instanceof WorkspaceAdminRequiredError) {
    return c.json({ error: 'workspace_admin_required', actor_id: err.actorId }, 403);
  }
  if (err instanceof WorkspaceMemberNotFoundError) {
    return c.json({ error: 'workspace_member_not_found', actor_id: err.actorId }, 404);
  }
  if (err instanceof WorkspaceLastAdminError) {
    return c.json({ error: 'workspace_last_admin' }, 409);
  }
  console.error('Unhandled workspace error:', err);
  return c.json({ error: 'internal_error' }, 500);
}

/**
 * Translate ZodError + actor service errors into the Tessera v0.1.2
 * `_error` envelope: `{ _error: { status, code, details: { field, reason } } }`.
 *
 * Pulled out into its own helper so the canonical task/project endpoints
 * (which use the legacy flat shape) don't accidentally inherit envelope
 * semantics. Two adapters, two shapes — until Tessera v0.2 unifies.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function actorErrorResponse(c: any, err: unknown): Response {
  if (err instanceof ZodError) {
    const issue = err.issues[0]!;
    const field = issue.path.length > 0 ? String(issue.path[0]) : 'request';
    return c.json(
      {
        _error: {
          status: 400,
          code: 'validation_error',
          details: { field, reason: issue.message },
        },
      },
      400,
    );
  }
  if (err instanceof ActorValidationError) {
    return c.json(
      {
        _error: {
          status: 400,
          code: 'validation_error',
          details: { field: err.field, reason: err.reason },
        },
      },
      400,
    );
  }
  if (err instanceof ActorNotFoundError) {
    return c.json(
      {
        _error: {
          status: 404,
          code: 'not_found',
          details: {
            field: 'actor_id',
            reason: 'No actor with this id.',
          },
        },
      },
      404,
    );
  }
  if (err instanceof AuthorizationForbiddenError) {
    return c.json(
      {
        _error: {
          status: 403,
          code: 'forbidden',
          details: {
            field: 'actor_id',
            reason:
              err.reason === 'human_required'
                ? 'Only human actors may manage actors.'
                : 'Only admin actors may manage actors.',
          },
        },
      },
      403,
    );
  }
  if (err instanceof AgentHeartbeatForbiddenError) {
    return c.json(
      {
        _error: {
          status: 403,
          code: 'forbidden',
          details: {
            field: 'actor_id',
            reason: 'Agents may heartbeat only themselves.',
          },
        },
      },
      403,
    );
  }
  if (err instanceof LastAdminProtectedError) {
    return c.json(
      {
        _error: {
          status: 409,
          code: 'last_admin_protected',
          details: {
            field: 'actor_id',
            reason:
              'Refusing to revoke the last active human credential. Mint another human first.',
          },
        },
      },
      409,
    );
  }
  if (err instanceof EnvActorImmutableError) {
    return c.json(
      {
        _error: {
          status: 400,
          code: 'operation_unsupported',
          details: {
            field: 'actor_id',
            reason:
              'Actor is sourced from SPRINO_ACTORS_JSON; recover via .env, not the API.',
          },
        },
      },
      400,
    );
  }
  if (err instanceof ConcurrentRotationError) {
    return c.json(
      {
        _error: {
          status: 409,
          code: 'concurrent_rotation',
          details: {
            field: 'actor_id',
            reason: 'Concurrent rotate_token detected. Retry once.',
          },
        },
      },
      409,
    );
  }
  if (err instanceof ActorLifecycleTransitionError) {
    return c.json(
      {
        _error: {
          status: 409,
          code: err.code,
          details: {
            field: 'actor_id',
            reason:
              err.code === 'actor_kind_not_agent'
                ? 'Only agent actors support lifecycle transitions.'
                : 'Agent lifecycle transition is not allowed from the current state.',
          },
        },
      },
      409,
    );
  }
  if (err instanceof IdempotencyConflictError) {
    return c.json(
      {
        _error: {
          status: 409,
          code: 'operation_id_conflict',
          details: {
            field: 'operation_id',
            reason:
              'operation_id reused with a different request payload.',
          },
        },
        cached_response: err.cachedResponse,
      },
      409,
    );
  }
  if (err instanceof OperationExpiredError) {
    return c.json(
      {
        _error: {
          status: 410,
          code: 'operation_expired',
          details: {
            field: 'operation_id',
            reason: 'operation_id is past retention.',
          },
        },
      },
      410,
    );
  }
  console.error('Unhandled actor endpoint error:', err);
  return c.json(
    {
      _error: {
        status: 500,
        code: 'internal_error',
        details: { field: 'request', reason: 'Internal server error.' },
      },
    },
    500,
  );
}

function parseLimitOffset(
  q: (key: string) => string | undefined,
): { limit: number | undefined; offset: number | undefined } {
  const parseIntParam = (v: string | undefined): number | undefined => {
    if (v === undefined || v === '') return undefined;
    if (!/^-?\d+$/.test(v)) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return undefined;
    return n;
  };
  return {
    limit: parseIntParam(q('limit')),
    offset: parseIntParam(q('offset')),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function errorResponse(c: any, err: unknown): Response {
  if (err instanceof ZodError) {
    return c.json(
      { error: 'validation_error', details: err.issues },
      400,
    );
  }
  if (err instanceof ProjectSlugConflictError) {
    return c.json({ error: 'slug_conflict', slug: err.slug }, 409);
  }
  if (err instanceof ProjectNotFoundError) {
    return c.json({ error: 'project_not_found', ref: err.ref }, 404);
  }
  if (err instanceof TaskNotFoundError) {
    return c.json({ error: 'task_not_found', task_id: err.taskId }, 404);
  }
  if (err instanceof TaskNotInColumnError) {
    return c.json(
      { error: 'task_not_in_column', task_id: err.taskId, column_id: err.columnId },
      422,
    );
  }
  if (err instanceof VersionMismatchError) {
    return c.json(
      {
        error: 'version_mismatch',
        message:
          'if_match does not match server version. See task field for current state.',
        task: err.currentTask,
      },
      409,
    );
  }
  if (err instanceof WorkflowTransitionForbiddenError) {
    return c.json(
      {
        error: 'workflow_transition_forbidden',
        from_column_id: err.fromColumnId,
        to_column_id: err.toColumnId,
      },
      422,
    );
  }
  if (err instanceof WorkflowColumnNotFoundError) {
    return c.json(
      { error: 'workflow_column_not_found', column_id: err.columnId },
      404,
    );
  }
  if (err instanceof HierarchyDepthExceededError) {
    return c.json({ error: 'hierarchy_depth_exceeded', message: err.message }, 422);
  }
  if (err instanceof ParentCycleDetectedError) {
    return c.json({ error: 'parent_cycle_detected', message: err.message }, 422);
  }
  if (err instanceof DependencyCycleDetectedError) {
    return c.json({ error: 'dependency_cycle_detected', message: err.message }, 422);
  }
  if (err instanceof DependencyNotResolvedError) {
    return c.json({ error: 'dependency_not_resolved', message: err.message }, 409);
  }
  if (err instanceof ChildrenNotDoneError) {
    return c.json({ error: 'children_not_done', message: err.message }, 409);
  }
  if (err instanceof CrossProjectRelationError) {
    return c.json({ error: 'cross_project_relation', message: err.message }, 422);
  }
  if (err instanceof SprintNotFoundError) {
    return c.json({ error: 'sprint_not_found', sprint_id: err.sprintId }, 404);
  }
  if (err instanceof SprintAlreadyActiveError) {
    return c.json({ error: 'sprint_already_active', sprint_id: err.existingSprintId }, 409);
  }
  if (err instanceof TaskAlreadyInActiveSprintError) {
    return c.json({ error: 'task_already_in_active_sprint', task_id: err.taskId }, 409);
  }
  if (err instanceof CrossProjectSprintError) {
    return c.json({ error: 'cross_project_sprint', message: err.message }, 422);
  }
  if (err instanceof InvalidSprintTransitionError) {
    return c.json({ error: 'invalid_sprint_transition', message: err.message }, 422);
  }
  if (err instanceof IdempotencyConflictError) {
    return c.json(
      {
        error: 'operation_id_conflict',
        message:
          'operation_id reused with a different request payload. Cached response in cached_response.',
        cached_response: err.cachedResponse,
      },
      409,
    );
  }
  if (err instanceof OperationExpiredError) {
    return c.json({ error: 'operation_expired' }, 410);
  }
  if (err instanceof AttachmentNotFoundError) {
    return c.json(
      { error: 'not_found', attachment_id: err.attachmentId },
      404,
    );
  }
  if (err instanceof AttachmentNotReadyError) {
    return c.json(
      { error: 'binary_not_uploaded', attachment_id: err.attachmentId },
      409,
    );
  }
  if (err instanceof AttachmentTaskNotFoundError) {
    return c.json({ error: 'task_not_found', task_id: err.taskId }, 404);
  }
  if (err instanceof SavedViewNotFoundError) {
    return c.json({ error: 'saved_view_not_found', view_id: err.viewId }, 404);
  }
  if (err instanceof AutomationRuleNotFoundError) {
    return c.json({ error: 'automation_rule_not_found', rule_id: err.ruleId }, 404);
  }
  if (err instanceof WorkspaceIsolationError) {
    return c.json(
      { error: 'workspace_isolation', project_id: err.projectId, workspace_id: err.workspaceId },
      403,
    );
  }
  console.error('Unhandled error:', err);
  return c.json({ error: 'internal_error' }, 500);
}
