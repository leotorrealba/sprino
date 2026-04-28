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

import { and, desc, eq, asc } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '../db/client.ts';
import { events, tasks } from '../db/schema.ts';
import type { TaskRow, EventRow } from '../db/schema.ts';
import {
  type AgentContext,
  type Event,
  type Task,
  type TaskCreateReq,
  type TaskCreateRes,
  type TaskGetReq,
  type TaskGetRes,
  type TaskStatus,
  type TaskUpdateStatusReq,
  type TaskUpdateStatusRes,
} from '../domain/index.ts';
import {
  checkIdempotency,
  hashRequest,
  recordOperation,
} from './idempotency.ts';
import { resolveProject } from './projects.ts';

type SelectClient = Pick<Db, 'select'>;

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

function rowToTask(r: TaskRow): Task {
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
  args: { req: TaskCreateReq; actorId: string },
): Promise<TaskCreateRes> {
  const requestHash = hashRequest(args.req);

  const cached = await checkIdempotency(db, args.req.operation_id, requestHash);
  if (cached) return cached as TaskCreateRes;

  const project = await resolveProject(db, {
    project_id: args.req.project_id,
    repo_path: args.req.repo_path,
  });

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
        })
        .returning();

      const [eventRow] = await tx
        .insert(events)
        .values({
          id: eventId,
          taskId,
          actorId: args.actorId,
          kind: 'created',
          payload: { title: args.req.title, status: 'todo' },
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
  args: { projectId: string; limit?: number },
): Promise<{ tasks: Task[] }> {
  const limit = Math.max(1, Math.min(args.limit ?? 200, 1000));
  const rows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.projectId, args.projectId))
    .orderBy(asc(tasks.createdAt))
    .limit(limit);
  return { tasks: rows.map(rowToTask) };
}

export async function getTask(
  db: Db,
  args: { req: TaskGetReq },
): Promise<TaskGetRes> {
  const rows = await db.select().from(tasks).where(eq(tasks.id, args.req.task_id));
  const row = rows[0];
  if (!row) throw new TaskNotFoundError(args.req.task_id);

  const agentContext = await buildAgentContext(db, args.req.task_id);

  return {
    task: rowToTask(row),
    agent_context: agentContext,
  };
}

export async function updateTaskStatus(
  db: Db,
  args: { req: TaskUpdateStatusReq; actorId: string },
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
      if (current.version !== args.req.if_match) {
        throw new VersionMismatchError(rowToTask(current));
      }

      const previousStatus: TaskStatus = current.status;

      const [eventRow] = await tx
        .insert(events)
        .values({
          id: eventId,
          taskId: args.req.task_id,
          actorId: args.actorId,
          kind: 'status_changed',
          payload: {
            from: previousStatus,
            to: args.req.status,
            ...(args.req.notes !== undefined ? { notes: args.req.notes } : {}),
          },
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

      return response;
    });
  } catch (err) {
    const raced = await checkIdempotency(db, args.req.operation_id, requestHash);
    if (raced) return raced as TaskUpdateStatusRes;
    throw err;
  }
}
