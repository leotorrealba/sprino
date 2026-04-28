// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Events service — read-only event-log queries.
 *
 * The event-log is APPEND-ONLY (see db/schema.ts). Writes happen exclusively
 * inside `service/tasks.ts` transactions; this file only reads.
 *
 * Why join with actors here:
 *   The activity feed renders human-readable lines like "Leo created Task X".
 *   The wire shape needs the actor's display_name + kind alongside the event.
 *   Pushing the join into SQL avoids N+1 round-trips that would otherwise
 *   show up under multi-agent load.
 *
 * Why join with tasks:
 *   `events` only carries `task_id`; `project_id` lives on `tasks`. The feed
 *   is project-scoped, so we filter by tasks.project_id.
 */

import { and, asc, desc, eq, gt } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { actors, events, tasks } from '../db/schema.ts';
import {
  DEFAULT_LIMIT,
  type EventWithActor,
  type EventListReq,
  type EventListRes,
} from '../domain/index.ts';

export async function listEvents(
  db: Db,
  args: { req: EventListReq },
): Promise<EventListRes> {
  // Bounds (limit ≤ 1000, offset ≥ 0) are enforced by EventListReqSchema.
  // We only apply a default here when the caller didn't supply one.
  const limit = args.req.limit ?? DEFAULT_LIMIT;
  const offset = args.req.offset ?? 0;

  const whereClause = args.req.task_id
    ? and(
        eq(tasks.projectId, args.req.project_id),
        eq(events.taskId, args.req.task_id),
      )
    : eq(tasks.projectId, args.req.project_id);

  const rows = await db
    .select({
      id: events.id,
      task_id: events.taskId,
      actor_id: events.actorId,
      kind: events.kind,
      payload: events.payload,
      operation_id: events.operationId,
      created_at: events.createdAt,
      actor_display_name: actors.displayName,
      actor_kind: actors.kind,
      task_title: tasks.title,
    })
    .from(events)
    .innerJoin(tasks, eq(events.taskId, tasks.id))
    .innerJoin(actors, eq(events.actorId, actors.id))
    .where(whereClause)
    .orderBy(desc(events.createdAt), desc(events.id))
    .limit(limit)
    .offset(offset);

  const out: EventWithActor[] = rows.map((r) => ({
    id: r.id,
    task_id: r.task_id,
    actor_id: r.actor_id,
    kind: r.kind,
    payload: r.payload as Record<string, unknown>,
    operation_id: r.operation_id,
    created_at: r.created_at.toISOString(),
    actor: {
      id: r.actor_id,
      display_name: r.actor_display_name,
      kind: r.actor_kind,
    },
    task: {
      id: r.task_id,
      title: r.task_title,
    },
  }));

  return { events: out };
}

/**
 * Stream-replay query: events for a project newer than `afterEventId`,
 * returned in ASCENDING order so the client receives missed events in
 * causal display order. Used by the SSE handler for both initial replay
 * (when the client passes `last_event_id` from a previous session) and
 * the periodic poll loop.
 *
 * Cursor caveat: events.id is uuidv7 (time-ordered at app level), so
 * `id > last` is a best-effort strict cursor. Under highly concurrent
 * writes a transaction with a lower id could commit AFTER the poll has
 * already emitted a higher-id event, dropping the lower one. Acceptable
 * for v0.x single-tenant PoC. v0.2+ should switch to a DB-backed stream
 * sequence (LISTEN/NOTIFY or a dedicated bigserial cursor table).
 *
 * If `afterEventId` is omitted the query returns nothing — first-mount
 * activity is always loaded via the REST `listEvents` endpoint, and only
 * then does the stream pick up the tail. This avoids accidentally
 * resending the entire history on every reconnect.
 */
export async function listEventsAfter(
  db: Db,
  args: {
    projectId: string;
    afterEventId: string | null;
    limit?: number;
  },
): Promise<EventWithActor[]> {
  if (!args.afterEventId) return [];
  const limit = args.limit ?? DEFAULT_LIMIT;
  const rows = await db
    .select({
      id: events.id,
      task_id: events.taskId,
      actor_id: events.actorId,
      kind: events.kind,
      payload: events.payload,
      operation_id: events.operationId,
      created_at: events.createdAt,
      actor_display_name: actors.displayName,
      actor_kind: actors.kind,
      task_title: tasks.title,
    })
    .from(events)
    .innerJoin(tasks, eq(events.taskId, tasks.id))
    .innerJoin(actors, eq(events.actorId, actors.id))
    .where(
      and(eq(tasks.projectId, args.projectId), gt(events.id, args.afterEventId)),
    )
    .orderBy(asc(events.createdAt), asc(events.id))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    task_id: r.task_id,
    actor_id: r.actor_id,
    kind: r.kind,
    payload: r.payload as Record<string, unknown>,
    operation_id: r.operation_id,
    created_at: r.created_at.toISOString(),
    actor: {
      id: r.actor_id,
      display_name: r.actor_display_name,
      kind: r.actor_kind,
    },
    task: { id: r.task_id, title: r.task_title },
  }));
}

/**
 * Returns the most-recent event id for `projectId`, or `null` if the
 * project has no events yet.
 *
 * Used by the SSE handler when a client connects WITHOUT a `last_event_id`
 * cursor: we snapshot the current tail at open time and stream from there
 * forward. Without this, an empty-feed connection's cursor would stay null
 * forever and `listEventsAfter` (which short-circuits on null) would never
 * deliver new events to that client.
 */
export async function latestEventId(
  db: Db,
  projectId: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: events.id })
    .from(events)
    .innerJoin(tasks, eq(events.taskId, tasks.id))
    .where(eq(tasks.projectId, projectId))
    .orderBy(desc(events.createdAt), desc(events.id))
    .limit(1);
  return rows[0]?.id ?? null;
}
