// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Tasks service — implements Tessera task verbs.
 *
 *   task.create        ──► event(kind=created)        + INSERT tasks (version=1)
 *   task.get           ──► SELECT task + recent_events + agent_context
 *   task.update_status ──► event(kind=status_changed) + UPDATE tasks (version+1)
 *
 * Architectural rules (eng review, locked):
 *   1. Business logic lives ONLY here. /api/* and /mcp/* are thin adapters.
 *   2. Event-write + projection-update share a single transaction.
 *   3. Idempotency, version checks, and event log writes happen here, once.
 *
 *  ┌──────────────────┐
 *  │  task.create()   │
 *  │   ┌──────────┐   │
 *  │   │ idempot? │── │── replay-cached → return cached
 *  │   └──────────┘   │── conflict → throw 409
 *  │        │         │── expired → throw 410
 *  │        ▼         │
 *  │   BEGIN TX       │
 *  │     INSERT event │  ─┐
 *  │     INSERT task  │   │ same TX
 *  │     INSERT op    │  ─┘
 *  │   COMMIT         │
 *  │        │         │
 *  │        ▼         │
 *  │  agent_context   │
 *  └──────────────────┘
 */

import { and, desc, eq, asc, inArray, ne, sql, ilike } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '../db/client.ts';
import { events, taskDependencies, tasks, workflowColumns, workflowTransitions, sprintTasks } from '../db/schema.ts';
import type { TaskRow, EventRow } from '../db/schema.ts';
import {
  DEFAULT_LIMIT,
  type AddDependencyReq,
  type AddDependencyRes,
  type AgentContext,
  type Event,
  type ListDependenciesReq,
  type ListDependenciesRes,
  type RemoveDependencyReq,
  type SetParentReq,
  type SetParentRes,
  type Task,
  type TaskCreateReq,
  type TaskCreateRes,
  type TaskGetReq,
  type TaskGetRes,
  type TaskListReq,
  type TaskListRes,
  type TaskStatus,
  type TaskUpdateStatusReq,
  type TaskUpdateStatusRes,
  type UpdateTaskPointsReq,
  type UpdateTaskPointsRes,
  type WorkflowColumn,
  type WorkflowColumnsListRes,
  type TaskTransitionWorkflowReq,
  type TaskTransitionWorkflowRes,
  type TaskReorderReq,
  type TaskReorderRes,
} from '../domain/index.ts';
import {
  checkIdempotency,
  hashRequest,
  recordOperation,
} from './idempotency.ts';
import { resolveProject } from './projects.ts';
import { applyAutomationRules } from './automation.ts';
import { assertProjectInWorkspace } from './authorization.ts';

type SelectClient = Pick<Db, 'select'>;

/**
 * Returns the Tessera event payload body unchanged.
 *
 * workspace_id is NOT embedded in the payload: it is a first-class column
 * surfaced via SQL JOIN on EventWithActor (see service/events.ts).
 * Injecting it into the payload JSON would violate the Tessera protocol
 * contract (payload must contain only task delta fields).
 */
function governancePayload(
  _workspaceId: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  return body;
}

export class TaskNotFoundError extends Error {
  constructor(public readonly taskId: string) {
    super(`task ${taskId} not found`);
    this.name = 'TaskNotFoundError';
  }
}

export class VersionMismatchError extends Error {
  constructor(public readonly currentTask: Task) {
    super('if_match version does not match server state');
    this.name = 'VersionMismatchError';
  }
}

export class WorkflowColumnNotFoundError extends Error {
  constructor(public readonly columnId: string) {
    super(`workflow column ${columnId} not found in this project`);
    this.name = 'WorkflowColumnNotFoundError';
  }
}

export class WorkflowTransitionForbiddenError extends Error {
  constructor(
    public readonly fromColumnId: string | null,
    public readonly toColumnId: string,
  ) {
    super(
      `workflow transition from ${fromColumnId ?? 'null'} to ${toColumnId} is not allowed`,
    );
    this.name = 'WorkflowTransitionForbiddenError';
  }
}

export class TaskNotInColumnError extends Error {
  constructor(public readonly taskId: string, public readonly columnId: string) {
    super(`task ${taskId} is not in column ${columnId}`);
    this.name = 'TaskNotInColumnError';
  }
}

export class HierarchyDepthExceededError extends Error {
  constructor() {
    super('task hierarchy cannot exceed 3 levels deep');
    this.name = 'HierarchyDepthExceededError';
  }
}

export class ParentCycleDetectedError extends Error {
  constructor() {
    super('setting this parent would create a hierarchy cycle');
    this.name = 'ParentCycleDetectedError';
  }
}

export class DependencyCycleDetectedError extends Error {
  constructor() {
    super('adding this dependency would create a cycle');
    this.name = 'DependencyCycleDetectedError';
  }
}

export class DependencyNotResolvedError extends Error {
  constructor() {
    super('task has unresolved dependencies — resolve them before changing status');
    this.name = 'DependencyNotResolvedError';
  }
}

export class ChildrenNotDoneError extends Error {
  constructor() {
    super('parent task cannot be marked done while children are not done');
    this.name = 'ChildrenNotDoneError';
  }
}

export class CrossProjectRelationError extends Error {
  constructor() {
    super('parent and dependency tasks must be in the same project');
    this.name = 'CrossProjectRelationError';
  }
}

const RECENT_EVENTS_LIMIT = 20;

// Tessera v0.0.x: agent_context payload soft-cap so a single task.get fits
// inside an agent's prompt window without surprises. We serialize the
// candidate, and if it busts the cap we shed events first (more numerous,
// lower per-item value), then related_tasks. Pagination endpoints let the
// caller fetch the trimmed tail explicitly.
const AGENT_CONTEXT_MAX_BYTES = 32 * 1024;

function encodePageToken(offset: number): string {
  // Opaque to callers — just an offset for v0. We base64url it so it's
  // visibly an opaque token rather than a number the client is tempted to
  // arithmetic on.
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString(
    'base64url',
  );
}

export function decodePageToken(token: string): { offset: number } | null {
  try {
    const decoded = JSON.parse(
      Buffer.from(token, 'base64url').toString('utf8'),
    );
    if (
      decoded &&
      typeof decoded === 'object' &&
      typeof decoded.o === 'number' &&
      Number.isInteger(decoded.o) &&
      decoded.o >= 0
    ) {
      return { offset: decoded.o };
    }
    return null;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Row → wire-shape conversion
// ────────────────────────────────────────────────────────────────────────

export function rowToTask(r: TaskRow): Task {
  return {
    id: r.id,
    project_id: r.projectId,
    title: r.title,
    description: r.description,
    status: r.status,
    assignee_id: r.assigneeId,
    created_by: r.createdBy,
    version: r.version,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
    workflow_column_id: r.workflowColumnId,
    rank: r.rank,
    parent_task_id: r.parentTaskId,
    points: r.points ?? null,
  };
}

function rowToEvent(r: EventRow): Event {
  return {
    id: r.id,
    task_id: r.taskId,
    actor_id: r.actorId,
    kind: r.kind,
    payload: r.payload as Record<string, unknown>,
    operation_id: r.operationId,
    created_at: r.createdAt.toISOString(),
  };
}

function rowToWorkflowColumn(r: typeof workflowColumns.$inferSelect): WorkflowColumn {
  return {
    id: r.id,
    project_id: r.projectId,
    name: r.name,
    position: r.position,
    maps_to_status: r.mapsToStatus,
    is_default: r.isDefault,
    created_at: r.createdAt.toISOString(),
  };
}

async function buildAgentContext(
  db: SelectClient,
  taskId: string,
): Promise<AgentContext> {
  const recentRows = await db
    .select()
    .from(events)
    .where(eq(events.taskId, taskId))
    .orderBy(desc(events.createdAt))
    .limit(RECENT_EVENTS_LIMIT);

  // Related-tasks discovery is Week 5+ — for now this is always empty, but
  // we still run truncation through it so the shape stays stable as soon
  // as discovery lands.
  const relatedTasks: Task[] = [];

  let recentEvents = recentRows.map(rowToEvent);
  let truncated = false;
  let nextEventOffset: number | null = null;
  let nextRelatedOffset: number | null = null;

  // Greedy shed: drop oldest events first (we sorted desc), then trim
  // related_tasks. If we ever blow past the cap with just the task body we
  // accept it — task fields are non-negotiable.
  const fits = (events: Event[], related: Task[]): boolean => {
    const candidate = {
      related_tasks: related,
      recent_events: events,
      repo_refs: [],
      truncated: false,
    };
    return Buffer.byteLength(JSON.stringify(candidate), 'utf8') <=
      AGENT_CONTEXT_MAX_BYTES;
  };

  while (!fits(recentEvents, relatedTasks) && recentEvents.length > 0) {
    recentEvents = recentEvents.slice(0, recentEvents.length - 1);
    truncated = true;
    nextEventOffset = recentEvents.length;
  }
  while (!fits(recentEvents, relatedTasks) && relatedTasks.length > 0) {
    relatedTasks.pop();
    truncated = true;
    nextRelatedOffset = relatedTasks.length;
  }

  return {
    related_tasks: relatedTasks,
    recent_events: recentEvents,
    repo_refs: [],
    truncated,
    next_page_tokens: truncated
      ? {
          related_tasks:
            nextRelatedOffset !== null
              ? encodePageToken(nextRelatedOffset)
              : null,
          recent_events:
            nextEventOffset !== null
              ? encodePageToken(nextEventOffset)
              : null,
        }
      : undefined,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Pagination helpers (powering /tasks/:id/related_tasks and /tasks/:id/events)
// ────────────────────────────────────────────────────────────────────────

const PAGE_DEFAULT_LIMIT = 20;
const PAGE_MAX_LIMIT = 100;

function clampPageLimit(limit: number | undefined): number {
  if (limit === undefined) return PAGE_DEFAULT_LIMIT;
  return Math.max(1, Math.min(limit, PAGE_MAX_LIMIT));
}

export async function listTaskEvents(
  db: SelectClient,
  args: { taskId: string; limit?: number; offset?: number },
): Promise<{ events: Event[]; next_page_token: string | null }> {
  // taskId existence check is the route adapter's job. Here we just paginate.
  const limit = clampPageLimit(args.limit);
  const offset = Math.max(0, args.offset ?? 0);

  // Fetch limit+1 to know whether there's a next page without a count query.
  const rows = await db
    .select()
    .from(events)
    .where(eq(events.taskId, args.taskId))
    .orderBy(desc(events.createdAt))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    events: page.map(rowToEvent),
    next_page_token: hasMore ? encodePageToken(offset + limit) : null,
  };
}

export async function listRelatedTasks(
  _db: SelectClient,
  _args: { taskId: string; limit?: number; offset?: number },
): Promise<{ tasks: Task[]; next_page_token: string | null }> {
  // Discovery logic lands in Week 5+. Endpoint exists now so the
  // pagination contract is locked at the same moment as agent_context
  // truncation — clients only need to learn one shape.
  return { tasks: [], next_page_token: null };
}

// ────────────────────────────────────────────────────────────────────────
// Verbs
// ────────────────────────────────────────────────────────────────────────

export async function createTask(
  db: Db,
  args: { req: TaskCreateReq; actorId: string; workspaceId: string },
): Promise<TaskCreateRes> {
  const requestHash = hashRequest(args.req);

  const cached = await checkIdempotency(db, args.req.operation_id, requestHash);
  if (cached) return cached as TaskCreateRes;

  const project = await resolveProject(db, {
    project_id: args.req.project_id,
    repo_path: args.req.repo_path,
  });

  await assertProjectInWorkspace(db, { projectId: project.id, workspaceId: args.workspaceId });

  const taskId = uuidv7();
  const eventId = uuidv7();
  const now = new Date();

  // Single transaction: task → event → operation.
  // Insert order note: tasks first because events.task_id has an immediate
  // FK on tasks.id. The "events are authoritative" invariant is a *replay*
  // property — given the events table you can rebuild every task — not a
  // byte-order property. Atomicity is guaranteed by the single transaction.
  try {
    return await db.transaction(async (tx) => {
      // Look up the default workflow column for this project.
      // Falls back to null gracefully if no columns are seeded yet.
      const defaultColRows = await tx
        .select({ id: workflowColumns.id })
        .from(workflowColumns)
        .where(
          and(
            eq(workflowColumns.projectId, project.id),
            eq(workflowColumns.isDefault, true),
          ),
        )
        .limit(1);
      const defaultColumnId = defaultColRows[0]?.id ?? null;

      let newRank = 1;
      if (defaultColumnId !== null) {
        const maxRankRow = await tx
          .select({ maxRank: sql<number>`COALESCE(MAX(rank), 0)` })
          .from(tasks)
          .where(eq(tasks.workflowColumnId, defaultColumnId));
        newRank = (maxRankRow[0]?.maxRank ?? 0) + 1;
      }

      const [taskRow] = await tx
        .insert(tasks)
        .values({
          id: taskId,
          projectId: project.id,
          title: args.req.title,
          description: args.req.description ?? '',
          status: 'todo',
          assigneeId: args.req.assignee_id ?? null,
          createdBy: args.actorId,
          version: 1,
          createdAt: now,
          updatedAt: now,
          workflowColumnId: defaultColumnId,
          rank: newRank,
        })
        .returning();

      const [eventRow] = await tx
        .insert(events)
        .values({
          id: eventId,
          taskId,
          actorId: args.actorId,
          kind: 'created',
          payload: governancePayload(args.workspaceId, {
            title: args.req.title,
            status: 'todo',
          }),
          operationId: args.req.operation_id,
          createdAt: now,
        })
        .returning();

      const agentContext = await buildAgentContext(tx, taskId);
      const response: TaskCreateRes = {
        task: rowToTask(taskRow!),
        agent_context: agentContext,
        event: rowToEvent(eventRow!),
      };

      await recordOperation(tx, {
        operationId: args.req.operation_id,
        actorId: args.actorId,
        requestHash,
        responseBody: response,
      });

      return response;
    });
  } catch (err) {
    const raced = await checkIdempotency(db, args.req.operation_id, requestHash);
    if (raced) return raced as TaskCreateRes;
    throw err;
  }
}

/**
 * Sprino-specific list extension. NOT a canonical Tessera verb — the canonical
 * protocol exposes only task.create, task.get, task.update_status. The list
 * shape will be standardized in Tessera v0.0.2 (ordering, pagination, filters).
 * Until then this powers the local dogfood UI only.
 */
export async function listTasks(
  db: Db,
  args: { req: TaskListReq; workspaceId: string },
): Promise<TaskListRes> {
  await assertProjectInWorkspace(db, { projectId: args.req.project_id, workspaceId: args.workspaceId });

  const limit = args.req.limit ?? DEFAULT_LIMIT;
  const offset = args.req.offset ?? 0;

  const conditions = [eq(tasks.projectId, args.req.project_id)];
  if (args.req.status && args.req.status.length > 0) {
    conditions.push(inArray(tasks.status, args.req.status));
  }
  if (args.req.assignee_id) {
    conditions.push(eq(tasks.assigneeId, args.req.assignee_id));
  }
  if (args.req.parent_task_id) {
    conditions.push(eq(tasks.parentTaskId, args.req.parent_task_id));
  }
  if (args.req.title_contains) {
    conditions.push(ilike(tasks.title, `%${args.req.title_contains}%`));
  }
  if (args.req.sprint_id) {
    const sprintTaskIds = db
      .select({ taskId: sprintTasks.taskId })
      .from(sprintTasks)
      .where(eq(sprintTasks.sprintId, args.req.sprint_id));
    conditions.push(inArray(tasks.id, sprintTaskIds));
  }

  const rows = await db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(asc(tasks.rank), asc(tasks.id))
    .limit(limit)
    .offset(offset);
  return { tasks: rows.map(rowToTask) };
}

export async function getTask(
  db: Db,
  args: { req: TaskGetReq; workspaceId: string },
): Promise<TaskGetRes> {
  const rows = await db.select().from(tasks).where(eq(tasks.id, args.req.task_id));
  const row = rows[0];
  if (!row) throw new TaskNotFoundError(args.req.task_id);

  await assertProjectInWorkspace(db, { projectId: row.projectId, workspaceId: args.workspaceId });

  const agentContext = await buildAgentContext(db, args.req.task_id);

  return {
    task: rowToTask(row),
    agent_context: agentContext,
  };
}

export async function updateTaskStatus(
  db: Db,
  args: { req: TaskUpdateStatusReq; actorId: string; workspaceId: string },
): Promise<TaskUpdateStatusRes> {
  const requestHash = hashRequest(args.req);

  const cached = await checkIdempotency(db, args.req.operation_id, requestHash);
  if (cached) return cached as TaskUpdateStatusRes;

  const eventId = uuidv7();
  const now = new Date();

  try {
    return await db.transaction(async (tx) => {
      // Lock the row: SELECT FOR UPDATE prevents two concurrent updates from
      // both reading version=N and both incrementing to N+1.
      const rows = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, args.req.task_id))
        .for('update');
      const current = rows[0];

      if (!current) throw new TaskNotFoundError(args.req.task_id);
      await assertProjectInWorkspace(tx, { projectId: current.projectId, workspaceId: args.workspaceId });
      if (current.version !== args.req.if_match) {
        throw new VersionMismatchError(rowToTask(current));
      }

      await validateStatusTransition(tx, args.req.task_id, args.req.status);

      const previousStatus: TaskStatus = current.status;

      const [eventRow] = await tx
        .insert(events)
        .values({
          id: eventId,
          taskId: args.req.task_id,
          actorId: args.actorId,
          kind: 'status_changed',
          payload: governancePayload(args.workspaceId, {
            from: previousStatus,
            to: args.req.status,
            ...(args.req.notes !== undefined ? { notes: args.req.notes } : {}),
          }),
          operationId: args.req.operation_id,
          createdAt: now,
        })
        .returning();

      const [updatedRow] = await tx
        .update(tasks)
        .set({
          status: args.req.status,
          version: current.version + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(tasks.id, args.req.task_id),
            eq(tasks.version, args.req.if_match),
          ),
        )
        .returning();

      if (!updatedRow) {
        // Should be unreachable given we held the lock, but defensive.
        throw new VersionMismatchError(rowToTask(current));
      }

      const response: TaskUpdateStatusRes = {
        task: rowToTask(updatedRow),
        event: rowToEvent(eventRow!),
      };

      await recordOperation(tx, {
        operationId: args.req.operation_id,
        actorId: args.actorId,
        requestHash,
        responseBody: response,
      });

      await applyAutomationRules(tx, {
        taskId: args.req.task_id,
        projectId: updatedRow.projectId,
        actorId: args.actorId,
        triggerField: 'status',
        newValue: args.req.status,
        depth: 0,
      });

      return response;
    });
  } catch (err) {
    const raced = await checkIdempotency(db, args.req.operation_id, requestHash);
    if (raced) return raced as TaskUpdateStatusRes;
    throw err;
  }
}

export async function listWorkflowColumns(
  db: Db,
  args: { projectId: string },
): Promise<WorkflowColumnsListRes> {
  const cols = await db
    .select()
    .from(workflowColumns)
    .where(eq(workflowColumns.projectId, args.projectId))
    .orderBy(asc(workflowColumns.position));

  const colIds = cols.map((c) => c.id);
  const trans =
    colIds.length > 0
      ? await db
          .select()
          .from(workflowTransitions)
          .where(inArray(workflowTransitions.fromColumnId, colIds))
      : [];

  return {
    columns: cols.map(rowToWorkflowColumn),
    transitions: trans.map((t) => ({
      from_column_id: t.fromColumnId,
      to_column_id: t.toColumnId,
    })),
  };
}

async function validateStatusTransition(
  db: SelectClient,
  taskId: string,
  newStatus: TaskStatus,
): Promise<void> {
  if (newStatus === 'doing' || newStatus === 'done') {
    const unresolvedDeps = await db
      .select({ id: taskDependencies.toTaskId })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.toTaskId))
      .where(
        and(
          eq(taskDependencies.fromTaskId, taskId),
          sql`${tasks.status} != 'done'`,
        ),
      );
    if (unresolvedDeps.length > 0) throw new DependencyNotResolvedError();
  }

  if (newStatus === 'done') {
    const undoneChildren = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.parentTaskId, taskId),
          sql`${tasks.status} != 'done'`,
        ),
      );
    if (undoneChildren.length > 0) throw new ChildrenNotDoneError();
  }
}

export async function transitionTaskWorkflow(
  db: Db,
  args: { req: TaskTransitionWorkflowReq; actorId: string; workspaceId: string },
): Promise<TaskTransitionWorkflowRes> {
  const requestHash = hashRequest(args.req);
  const cached = await checkIdempotency(db, args.req.operation_id, requestHash);
  if (cached) return cached as TaskTransitionWorkflowRes;

  const eventId = uuidv7();
  const now = new Date();

  try {
    return await db.transaction(async (tx) => {
      // Lock task row to prevent concurrent version increments.
      const taskRows = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, args.req.task_id))
        .for('update');
      const current = taskRows[0];
      if (!current) throw new TaskNotFoundError(args.req.task_id);
      await assertProjectInWorkspace(tx, { projectId: current.projectId, workspaceId: args.workspaceId });
      if (current.version !== args.req.if_match) {
        throw new VersionMismatchError(rowToTask(current));
      }

      // Verify target column exists in the same project.
      const colRows = await tx
        .select()
        .from(workflowColumns)
        .where(
          and(
            eq(workflowColumns.id, args.req.to_column_id),
            eq(workflowColumns.projectId, current.projectId),
          ),
        )
        .limit(1);
      const targetCol = colRows[0];
      if (!targetCol) {
        throw new WorkflowColumnNotFoundError(args.req.to_column_id);
      }

      await validateStatusTransition(tx, args.req.task_id, targetCol.mapsToStatus);

      const maxRankRow = await tx
        .select({ maxRank: sql<number>`COALESCE(MAX(rank), 0)` })
        .from(tasks)
        .where(eq(tasks.workflowColumnId, args.req.to_column_id));
      const transitionRank = (maxRankRow[0]?.maxRank ?? 0) + 1;

      // Transition guard. A null current column means this is a pre-D1 task
      // receiving its first column assignment — any target is allowed.
      if (current.workflowColumnId !== null) {
        const allowed = await tx
          .select({ fromColumnId: workflowTransitions.fromColumnId })
          .from(workflowTransitions)
          .where(
            and(
              eq(workflowTransitions.fromColumnId, current.workflowColumnId),
              eq(workflowTransitions.toColumnId, args.req.to_column_id),
            ),
          )
          .limit(1);
        if (!allowed[0]) {
          throw new WorkflowTransitionForbiddenError(
            current.workflowColumnId,
            args.req.to_column_id,
          );
        }
      }

      const [eventRow] = await tx
        .insert(events)
        .values({
          id: eventId,
          taskId: args.req.task_id,
          actorId: args.actorId,
          kind: 'workflow_transitioned',
          payload: governancePayload(args.workspaceId, {
            from_column_id: current.workflowColumnId,
            to_column_id: args.req.to_column_id,
            ...(args.req.notes !== undefined ? { notes: args.req.notes } : {}),
          }),
          operationId: args.req.operation_id,
          createdAt: now,
        })
        .returning();

      const [updatedRow] = await tx
        .update(tasks)
        .set({
          workflowColumnId: args.req.to_column_id,
          status: targetCol.mapsToStatus,
          rank: transitionRank,
          version: current.version + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(tasks.id, args.req.task_id),
            eq(tasks.version, args.req.if_match),
          ),
        )
        .returning();

      if (!updatedRow) throw new VersionMismatchError(rowToTask(current));

      const response: TaskTransitionWorkflowRes = {
        task: rowToTask(updatedRow),
        event: rowToEvent(eventRow!),
      };

      await recordOperation(tx, {
        operationId: args.req.operation_id,
        actorId: args.actorId,
        requestHash,
        responseBody: response,
      });

      await applyAutomationRules(tx, {
        taskId: args.req.task_id,
        projectId: current.projectId,
        actorId: args.actorId,
        triggerField: 'status',
        newValue: targetCol.mapsToStatus,
        depth: 0,
      });

      return response;
    });
  } catch (err) {
    const raced = await checkIdempotency(db, args.req.operation_id, requestHash);
    if (raced) return raced as TaskTransitionWorkflowRes;
    throw err;
  }
}

export async function reorderTask(
  db: Db,
  args: { req: TaskReorderReq; actorId: string; workspaceId: string },
): Promise<TaskReorderRes> {
  const requestHash = hashRequest(args.req);
  const cached = await checkIdempotency(db, args.req.operation_id, requestHash);
  if (cached) return cached as TaskReorderRes;

  try {
    return await db.transaction(async (tx) => {
      // Verify task exists and is in the requested column.
      const taskRows = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, args.req.task_id))
        .for('update');
      const target = taskRows[0];
      if (!target) throw new TaskNotFoundError(args.req.task_id);
      await assertProjectInWorkspace(tx, { projectId: target.projectId, workspaceId: args.workspaceId });
      if (target.workflowColumnId !== args.req.column_id) {
        throw new TaskNotInColumnError(args.req.task_id, args.req.column_id);
      }

      // Fetch and lock all tasks in the column, ordered by current rank.
      const colTasks = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.workflowColumnId, args.req.column_id))
        .orderBy(asc(tasks.rank), asc(tasks.id))
        .for('update');

      // Build new order.
      const without = colTasks.filter((t) => t.id !== args.req.task_id);
      const movingTask = colTasks.find((t) => t.id === args.req.task_id)!;

      let newOrder: typeof colTasks;
      if (args.req.after_task_id === null) {
        newOrder = [movingTask, ...without];
      } else {
        const anchorIdx = without.findIndex((t) => t.id === args.req.after_task_id);
        if (anchorIdx === -1) {
          throw new TaskNotInColumnError(args.req.after_task_id, args.req.column_id);
        }
        newOrder = [
          ...without.slice(0, anchorIdx + 1),
          movingTask,
          ...without.slice(anchorIdx + 1),
        ];
      }

      // Renumber 1-based and update all rows.
      await Promise.all(
        newOrder.map((t, i) =>
          tx
            .update(tasks)
            .set({ rank: i + 1 })
            .where(eq(tasks.id, t.id)),
        ),
      );

      // Fetch the updated column in rank order.
      const updated = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.workflowColumnId, args.req.column_id))
        .orderBy(asc(tasks.rank), asc(tasks.id));

      const response: TaskReorderRes = { tasks: updated.map(rowToTask) };

      await recordOperation(tx, {
        operationId: args.req.operation_id,
        actorId: args.actorId,
        requestHash,
        responseBody: response,
      });

      return response;
    });
  } catch (err) {
    const raced = await checkIdempotency(db, args.req.operation_id, requestHash);
    if (raced) return raced as TaskReorderRes;
    throw err;
  }
}

// ── D3: Graph helpers ─────────────────────────────────────────────────────

/** Maximum number of levels from root to leaf (root = level 1). */
const MAX_TASK_HIERARCHY_DEPTH = 3;

async function walkAncestors(
  db: SelectClient,
  startId: string,
): Promise<string[]> {
  const ancestors: string[] = [];
  const visited = new Set<string>();
  let currentId: string | null = startId;
  while (currentId !== null && !visited.has(currentId)) {
    visited.add(currentId);
    const rows = await db
      .select({ parentTaskId: tasks.parentTaskId })
      .from(tasks)
      .where(eq(tasks.id, currentId));
    const parentId = rows[0]?.parentTaskId ?? null;
    if (parentId !== null) ancestors.push(parentId);
    currentId = parentId;
  }
  return ancestors;
}

/** Maximum edge-count from `taskId` down to any descendant (0 if no children). */
async function walkDescendants(db: SelectClient, taskId: string): Promise<number> {
  const childRows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.parentTaskId, taskId));
  let maxDown = 0;
  for (const row of childRows) {
    const down = await walkDescendants(db, row.id);
    maxDown = Math.max(maxDown, 1 + down);
  }
  return maxDown;
}

async function isReachableInDependencies(
  db: SelectClient,
  fromId: string,
  targetId: string,
): Promise<boolean> {
  const visited = new Set<string>();
  const queue: string[] = [fromId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === targetId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const edges = await db
      .select({ toTaskId: taskDependencies.toTaskId })
      .from(taskDependencies)
      .where(eq(taskDependencies.fromTaskId, current));
    for (const e of edges) queue.push(e.toTaskId);
  }
  return false;
}

export async function setParent(
  db: Db,
  args: { taskId: string; parentTaskId: string | null; actorId: string; workspaceId: string },
): Promise<SetParentRes> {
  const now = new Date();

  return await db.transaction(async (tx) => {
    const taskRows = await tx.select().from(tasks).where(eq(tasks.id, args.taskId));
    const current = taskRows[0];
    if (!current) throw new TaskNotFoundError(args.taskId);
    await assertProjectInWorkspace(tx, { projectId: current.projectId, workspaceId: args.workspaceId });

    if (args.parentTaskId !== null) {
      const parentRows = await tx.select().from(tasks).where(eq(tasks.id, args.parentTaskId));
      const parent = parentRows[0];
      if (!parent) throw new TaskNotFoundError(args.parentTaskId);
      if (parent.projectId !== current.projectId) throw new CrossProjectRelationError();

      const ancestors = await walkAncestors(tx, args.parentTaskId);
      if (ancestors.includes(args.taskId)) throw new ParentCycleDetectedError();
      const maxDescendantDepth = await walkDescendants(tx, args.taskId);
      if (ancestors.length + 1 + maxDescendantDepth >= MAX_TASK_HIERARCHY_DEPTH) {
        throw new HierarchyDepthExceededError();
      }
    }

    const prevParentId = current.parentTaskId;

    const [updated] = await tx
      .update(tasks)
      .set({ parentTaskId: args.parentTaskId, updatedAt: now })
      .where(eq(tasks.id, args.taskId))
      .returning();

    await tx.insert(events).values({
      id: uuidv7(),
      taskId: args.taskId,
      actorId: args.actorId,
      kind: 'context_updated',
      payload: governancePayload(args.workspaceId, {
        field: 'parent_task_id',
        old: prevParentId,
        new: args.parentTaskId,
      }),
      operationId: uuidv7(),
      createdAt: now,
    });

    return { task: rowToTask(updated!) };
  });
}

export async function addDependency(
  db: Db,
  args: { fromTaskId: string; toTaskId: string; actorId: string; workspaceId: string },
): Promise<AddDependencyRes> {
  const now = new Date();

  const [fromRows, toRows] = await Promise.all([
    db.select().from(tasks).where(eq(tasks.id, args.fromTaskId)),
    db.select().from(tasks).where(eq(tasks.id, args.toTaskId)),
  ]);
  const fromTask = fromRows[0];
  const toTask = toRows[0];
  if (!fromTask) throw new TaskNotFoundError(args.fromTaskId);
  if (!toTask) throw new TaskNotFoundError(args.toTaskId);
  if (fromTask.projectId !== toTask.projectId) throw new CrossProjectRelationError();
  await assertProjectInWorkspace(db, { projectId: fromTask.projectId, workspaceId: args.workspaceId });

  const wouldCycle = await isReachableInDependencies(db, args.toTaskId, args.fromTaskId);
  if (wouldCycle) throw new DependencyCycleDetectedError();

  await db
    .insert(taskDependencies)
    .values({ fromTaskId: args.fromTaskId, toTaskId: args.toTaskId, createdAt: now })
    .onConflictDoNothing();

  let updatedRow = fromTask;
  if (fromTask.status === 'todo' || fromTask.status === 'doing') {
    const [row] = await db
      .update(tasks)
      .set({ status: 'blocked', updatedAt: now })
      .where(eq(tasks.id, args.fromTaskId))
      .returning();
    updatedRow = row!;
  }

  await db.insert(events).values({
    id: uuidv7(),
    taskId: args.fromTaskId,
    actorId: args.actorId,
    kind: 'context_updated',
    payload: governancePayload(args.workspaceId, {
      field: 'dependency_added',
      blocked_by_task_id: args.toTaskId,
    }),
    operationId: uuidv7(),
    createdAt: now,
  });

  return { task: rowToTask(updatedRow) };
}

export async function removeDependency(
  db: Db,
  args: { fromTaskId: string; toTaskId: string; actorId: string; workspaceId: string },
): Promise<void> {
  const now = new Date();

  await db.transaction(async (tx) => {
    const lockedRows = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, args.fromTaskId))
      .for('update');
    const fromTask = lockedRows[0];
    if (!fromTask) throw new TaskNotFoundError(args.fromTaskId);
    await assertProjectInWorkspace(tx, {
      projectId: fromTask.projectId,
      workspaceId: args.workspaceId,
    });

    await tx
      .delete(taskDependencies)
      .where(
        and(
          eq(taskDependencies.fromTaskId, args.fromTaskId),
          eq(taskDependencies.toTaskId, args.toTaskId),
        ),
      );

    if (fromTask.status === 'blocked') {
      const unresolved = await tx
        .select({ toTaskId: taskDependencies.toTaskId })
        .from(taskDependencies)
        .innerJoin(tasks, eq(taskDependencies.toTaskId, tasks.id))
        .where(
          and(
            eq(taskDependencies.fromTaskId, args.fromTaskId),
            ne(tasks.status, 'done'),
          ),
        );

      if (unresolved.length === 0) {
        await tx.insert(events).values({
          id: uuidv7(),
          taskId: args.fromTaskId,
          actorId: args.actorId,
          kind: 'status_changed',
          payload: governancePayload(args.workspaceId, { from: 'blocked', to: 'todo' }),
          operationId: uuidv7(),
          createdAt: now,
        });

        await tx
          .update(tasks)
          .set({
            status: 'todo',
            version: fromTask.version + 1,
            updatedAt: now,
          })
          .where(eq(tasks.id, args.fromTaskId));
      }
    }

    await tx.insert(events).values({
      id: uuidv7(),
      taskId: args.fromTaskId,
      actorId: args.actorId,
      kind: 'context_updated',
      payload: governancePayload(args.workspaceId, {
        field: 'dependency_removed',
        blocked_by_task_id: args.toTaskId,
      }),
      operationId: uuidv7(),
      createdAt: now,
    });
  });
}

export async function listDependencies(
  db: SelectClient,
  args: { taskId: string },
): Promise<ListDependenciesRes> {
  const edges = await db
    .select({ toTaskId: taskDependencies.toTaskId })
    .from(taskDependencies)
    .where(eq(taskDependencies.fromTaskId, args.taskId));

  if (edges.length === 0) return { blocked_by: [] };

  const blockerIds = edges.map((e) => e.toTaskId);
  const blockerRows = await db
    .select()
    .from(tasks)
    .where(inArray(tasks.id, blockerIds));

  return { blocked_by: blockerRows.map(rowToTask) };
}

export async function updateTaskPoints(
  db: Db,
  args: { req: UpdateTaskPointsReq; actorId: string; workspaceId: string },
): Promise<UpdateTaskPointsRes> {
  const requestHash = hashRequest(args.req);
  const cached = await checkIdempotency(db, args.req.operation_id, requestHash);
  if (cached) return cached as UpdateTaskPointsRes;

  const eventId = uuidv7();
  const now = new Date();

  try {
    return await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, args.req.task_id))
        .for('update');
      const current = rows[0];
      if (!current) throw new TaskNotFoundError(args.req.task_id);
      await assertProjectInWorkspace(tx, { projectId: current.projectId, workspaceId: args.workspaceId });
      if (current.version !== args.req.if_match) {
        throw new VersionMismatchError(rowToTask(current));
      }

      const [updated] = await tx
        .update(tasks)
        .set({
          points: args.req.points,
          version: current.version + 1,
          updatedAt: now,
        })
        .where(and(eq(tasks.id, args.req.task_id), eq(tasks.version, args.req.if_match)))
        .returning();

      const [eventRow] = await tx
        .insert(events)
        .values({
          id: eventId,
          taskId: args.req.task_id,
          actorId: args.actorId,
          kind: 'context_updated',
          payload: governancePayload(args.workspaceId, {
            field: 'points',
            new: args.req.points,
          }),
          operationId: args.req.operation_id,
          createdAt: now,
        })
        .returning();

      const response: UpdateTaskPointsRes = {
        task: rowToTask(updated!),
        event: rowToEvent(eventRow!),
      };

      await recordOperation(tx, {
        operationId: args.req.operation_id,
        actorId: args.actorId,
        requestHash,
        responseBody: response,
      });

      return response;
    });
  } catch (err) {
    const raced = await checkIdempotency(db, args.req.operation_id, requestHash);
    if (raced) return raced as UpdateTaskPointsRes;
    throw err;
  }
}
