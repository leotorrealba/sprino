/**
 * @sprino/protocol-types — shared wire types for Tessera v0.0.1.
 *
 * This package is the single source of truth for the runtime-validated
 * wire shape used by both `apps/server` and `apps/web`. It mirrors the
 * canonical JSON Schemas in `tessera/schemas/` but is implemented in Zod
 * for ergonomics inside the TypeScript monorepo.
 *
 * Cross-checking note (deferred to v0.0.2): a CI test will verify that
 * `z.toJSONSchema()` output of these schemas matches the JSON Schemas
 * committed to the `tessera` repo. Until then, manual review at every
 * protocol bump.
 */

import { z } from 'zod';

const uuid = z.string().uuid();
const isoDateTime = z.string().datetime({ offset: true });

// ────────────────────────────────────────────────────────────────────────
// Resources
// ────────────────────────────────────────────────────────────────────────

export const ActorKindSchema = z.enum(['human', 'agent']);
export type ActorKind = z.infer<typeof ActorKindSchema>;

export const ActorSchema = z.object({
  id: uuid,
  kind: ActorKindSchema,
  display_name: z.string().min(1).max(200),
  agent_runtime: z.string().nullable(),
  parent_actor_id: uuid.nullable(),
  created_at: isoDateTime,
});
export type Actor = z.infer<typeof ActorSchema>;

export const ProjectSchema = z.object({
  id: uuid,
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
  display_name: z.string().min(1).max(200),
  repo_path: z.string().nullable(),
  created_at: isoDateTime,
});
export type Project = z.infer<typeof ProjectSchema>;

export const TaskStatusSchema = z.enum(['todo', 'doing', 'done', 'blocked']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z.object({
  id: uuid,
  project_id: uuid,
  title: z.string().min(1).max(280),
  description: z.string().max(16384),
  status: TaskStatusSchema,
  assignee_id: uuid.nullable(),
  created_by: uuid,
  version: z.number().int().min(1),
  created_at: isoDateTime,
  updated_at: isoDateTime,
});
export type Task = z.infer<typeof TaskSchema>;

export const EventKindSchema = z.enum([
  'created',
  'status_changed',
  'assigned',
  'context_updated',
  'commented',
]);
export type EventKind = z.infer<typeof EventKindSchema>;

export const EventSchema = z.object({
  id: uuid,
  task_id: uuid,
  actor_id: uuid,
  kind: EventKindSchema,
  payload: z.record(z.unknown()),
  operation_id: uuid,
  created_at: isoDateTime,
});
export type Event = z.infer<typeof EventSchema>;

export const RepoRefSchema = z.object({
  kind: z.enum(['commit', 'branch', 'pr', 'file', 'issue']),
  ref: z.string(),
  url: z.string().url().optional(),
});
export type RepoRef = z.infer<typeof RepoRefSchema>;

export const AgentContextSchema = z.object({
  related_tasks: z.array(TaskSchema),
  recent_events: z.array(EventSchema),
  repo_refs: z.array(RepoRefSchema),
  truncated: z.boolean(),
  next_page_tokens: z
    .object({
      related_tasks: z.string().nullable().optional(),
      recent_events: z.string().nullable().optional(),
    })
    .optional(),
});
export type AgentContext = z.infer<typeof AgentContextSchema>;

// ────────────────────────────────────────────────────────────────────────
// Verbs (v0.0.1: task.create, task.get, task.update_status)
// ────────────────────────────────────────────────────────────────────────

export const TaskCreateReqSchema = z.object({
  operation_id: uuid,
  project_id: uuid,
  title: z.string().min(1).max(280),
  description: z.string().max(16384).optional(),
  assignee_id: uuid.nullable().optional(),
});
export type TaskCreateReq = z.infer<typeof TaskCreateReqSchema>;

export const TaskCreateResSchema = z.object({
  task: TaskSchema,
  agent_context: AgentContextSchema,
  event: EventSchema,
});
export type TaskCreateRes = z.infer<typeof TaskCreateResSchema>;

export const TaskGetReqSchema = z.object({ task_id: uuid });
export type TaskGetReq = z.infer<typeof TaskGetReqSchema>;

export const TaskGetResSchema = z.object({
  task: TaskSchema,
  agent_context: AgentContextSchema,
});
export type TaskGetRes = z.infer<typeof TaskGetResSchema>;

export const TaskUpdateStatusReqSchema = z.object({
  operation_id: uuid,
  task_id: uuid,
  status: TaskStatusSchema,
  if_match: z.number().int().min(1),
});
export type TaskUpdateStatusReq = z.infer<typeof TaskUpdateStatusReqSchema>;

export const TaskUpdateStatusResSchema = z.object({
  task: TaskSchema,
  event: EventSchema,
});
export type TaskUpdateStatusRes = z.infer<typeof TaskUpdateStatusResSchema>;

export const PROTOCOL_VERSION = 'tessera/v0.0.1';
