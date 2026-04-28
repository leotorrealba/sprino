// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Drizzle schema for Sprino — implements Tessera resources.
 *
 * Resource → table:
 *   Actor    → actors
 *   Project  → projects
 *   Task     → tasks
 *   Event    → events       (APPEND-ONLY — never UPDATE or DELETE)
 *   Operation → operations  (idempotency dedup, 30-day retention)
 *
 * Versions:
 *   tasks.version is monotonically incremented inside the same transaction
 *   that writes the corresponding status_changed event.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  pgEnum,
} from 'drizzle-orm/pg-core';

// ────────────────────────────────────────────────────────────────────────
// ENUMS — keep these aligned with tessera/schemas/resources/*.json
// ────────────────────────────────────────────────────────────────────────

export const actorKindEnum = pgEnum('actor_kind', ['human', 'agent']);
export const taskStatusEnum = pgEnum('task_status', [
  'todo',
  'doing',
  'done',
  'blocked',
]);
export const eventKindEnum = pgEnum('event_kind', [
  'created',
  'status_changed',
  'assigned',
  'context_updated',
  'commented',
]);

// ────────────────────────────────────────────────────────────────────────
// TABLES
// ────────────────────────────────────────────────────────────────────────

export const actors = pgTable('actors', {
  id: uuid('id').primaryKey(),
  kind: actorKindEnum('kind').notNull(),
  displayName: text('display_name').notNull(),
  agentRuntime: text('agent_runtime'),
  parentActorId: uuid('parent_actor_id'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    displayName: text('display_name').notNull(),
    repoPath: text('repo_path'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    slugIdx: index('projects_slug_idx').on(t.slug),
    repoPathIdx: index('projects_repo_path_idx').on(t.repoPath),
  }),
);

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    title: text('title').notNull(),
    description: text('description').default('').notNull(),
    status: taskStatusEnum('status').notNull().default('todo'),
    assigneeId: uuid('assignee_id').references(() => actors.id),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => actors.id),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    projectIdx: index('tasks_project_idx').on(t.projectId),
    statusIdx: index('tasks_status_idx').on(t.projectId, t.status),
  }),
);

/**
 * APPEND-ONLY. The application MUST NOT UPDATE or DELETE rows in this table.
 * Materialized state on `tasks` is a projection of these events.
 *
 *   task.create         INSERT tasks  → INSERT events (kind='created')
 *   task.update_status  INSERT events (kind='status_changed') → UPDATE tasks
 *
 * Both happen inside the same transaction. The FK on events.task_id forces
 * the task row to exist before the event referencing it; that ordering is a
 * Postgres concern, not a semantic one. The replay invariant — "given the
 * events table you can rebuild every task" — holds independently of insert
 * order, because either the whole transaction commits or nothing does.
 */
export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => actors.id),
    kind: eventKindEnum('kind').notNull(),
    payload: jsonb('payload').default({}).notNull(),
    operationId: uuid('operation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    taskIdx: index('events_task_idx').on(t.taskId),
    actorIdx: index('events_actor_idx').on(t.actorId),
    operationIdx: index('events_operation_idx').on(t.operationId),
  }),
);

/**
 * Idempotency dedup. Stored for 30 days (default), purged by daily cron
 * (scripts/cleanup-operations.ts).
 *
 *   First call:  INSERT operations with response_body
 *   Replay:      SELECT operations WHERE operation_id = X AND request_hash = Y
 *                  → return cached response_body
 *   Mismatched:  SELECT operations WHERE operation_id = X AND request_hash != Y
 *                  → 409 Conflict with cached response_body
 *   Expired:     SELECT operations WHERE operation_id = X AND expires_at < NOW()
 *                  → 410 Gone
 */
export const operations = pgTable(
  'operations',
  {
    operationId: uuid('operation_id').primaryKey(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => actors.id),
    requestHash: text('request_hash').notNull(),
    responseBody: jsonb('response_body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    expiryIdx: index('operations_expiry_idx').on(t.expiresAt),
    actorIdx: index('operations_actor_idx').on(t.actorId),
  }),
);

// Convenience exports for service layer
export type ActorRow = typeof actors.$inferSelect;
export type NewActorRow = typeof actors.$inferInsert;
export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;
export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
export type OperationRow = typeof operations.$inferSelect;
export type NewOperationRow = typeof operations.$inferInsert;
