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

import { and, desc, eq } from 'drizzle-orm';
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
