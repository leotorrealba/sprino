// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera

import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { actors, events, projects, tasks } from '../db/schema.ts';
import type { EventKind, EventWithActor } from '../domain/index.ts';
import { assertAuditExportEnabled } from './entitlements.ts';

export async function exportAuditEvents(
  db: Db,
  opts: {
    workspaceId: string;
    actorId?: string;
    kind?: string;
    since?: string;
    until?: string;
    limit?: number;
    offset?: number;
  },
): Promise<{ events: EventWithActor[]; total: number }> {
  await assertAuditExportEnabled(db, opts.workspaceId);
  const limit = Math.min(opts.limit ?? 100, 500);
  const offset = opts.offset ?? 0;

  const conditions = [eq(projects.workspaceId, opts.workspaceId)];
  if (opts.actorId) {
    conditions.push(eq(events.actorId, opts.actorId));
  }
  if (opts.kind) {
    conditions.push(eq(events.kind, opts.kind as EventKind));
  }
  if (opts.since) {
    conditions.push(gte(events.createdAt, new Date(opts.since)));
  }
  if (opts.until) {
    conditions.push(lte(events.createdAt, new Date(opts.until)));
  }
  const whereClause = and(...conditions);

  const countRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(events)
    .innerJoin(tasks, eq(events.taskId, tasks.id))
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(whereClause);
  const total = countRows[0]?.count ?? 0;

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
      workspace_id: projects.workspaceId,
    })
    .from(events)
    .innerJoin(tasks, eq(events.taskId, tasks.id))
    .innerJoin(projects, eq(tasks.projectId, projects.id))
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
    workspace_id: r.workspace_id,
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

  return { events: out, total };
}
