// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Zod schemas mirroring tessera/schemas/*.json.
 *
 * These provide runtime validation at adapter boundaries. The DB schema
 * (Drizzle) is the source of truth for storage shape; these are the source
 * of truth for the wire shape.
 *
 * Cross-checking: a future test (deferred to v0.0.2) will verify that these
 * Zod schemas produce JSON Schemas equivalent to the canonical Tessera
 * schemas via z.toJSONSchema().
 */

import { z } from 'zod';
import { MAX_LIMITS, paginationSchema } from './pagination.ts';

export {
  DEFAULT_LIMIT,
  MAX_LIMITS,
  paginationSchema,
} from './pagination.ts';

const uuid = z.string().uuid();
const isoDateTime = z.string().datetime({ offset: true });
const projectSlug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);

// ────────────────────────────────────────────────────────────────────────
// Resources
// ────────────────────────────────────────────────────────────────────────

export const ActorSchema = z.object({
  id: uuid,
  kind: z.enum(['human', 'agent']),
  display_name: z.string().min(1).max(200),
  agent_runtime: z.string().nullable(),
  parent_actor_id: uuid.nullable(),
  created_at: isoDateTime,
});
export type Actor = z.infer<typeof ActorSchema>;

export const ProjectSchema = z.object({
  id: uuid,
  slug: projectSlug,
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

// Sprino-specific activity-feed types. Not part of canonical Tessera; the
// protocol exposes events through `task.get`'s `recent_events`.
//
// EventWithActor reuses `ActorSchema` / `TaskSchema` field constraints via
// `.pick(...)` so this response shape stays in lockstep with the canonical
// resource shapes — no drift in min/max bounds.
export const EventWithActorSchema = EventSchema.extend({
  actor: ActorSchema.pick({
    id: true,
    display_name: true,
    kind: true,
  }),
  task: TaskSchema.pick({
    id: true,
    title: true,
  }),
});
export type EventWithActor = z.infer<typeof EventWithActorSchema>;

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
// Verbs — request schemas
// ────────────────────────────────────────────────────────────────────────

export const ProjectGetReqSchema = z
  .object({
    project_id: uuid.optional(),
    slug: projectSlug.optional(),
    repo_path: z.string().min(1).optional(),
  })
  .refine((req) => req.project_id || req.slug || req.repo_path, {
    message: 'one of project_id, slug, or repo_path is required',
  });
export type ProjectGetReq = z.infer<typeof ProjectGetReqSchema>;

export const TaskCreateReqSchema = z
  .object({
    operation_id: uuid,
    project_id: uuid.optional(),
    repo_path: z.string().min(1).optional(),
    title: z.string().min(1).max(280),
    description: z.string().max(16384).optional(),
    assignee_id: uuid.nullable().optional(),
  })
  .refine((req) => req.project_id || req.repo_path, {
    message: 'one of project_id or repo_path is required',
  });
export type TaskCreateReq = z.infer<typeof TaskCreateReqSchema>;

export const TaskGetReqSchema = z.object({ task_id: uuid });
export type TaskGetReq = z.infer<typeof TaskGetReqSchema>;

export const TaskUpdateStatusReqSchema = z.object({
  operation_id: uuid,
  task_id: uuid,
  status: TaskStatusSchema,
  if_match: z.number().int().min(1),
  // Free-form operator note captured into the status_changed event payload
  // so the audit log preserves the rationale, not just the from→to delta.
  notes: z.string().max(8192).optional(),
});
export type TaskUpdateStatusReq = z.infer<typeof TaskUpdateStatusReqSchema>;

export const EventListReqSchema = z
  .object({
    project_id: uuid,
    task_id: uuid.optional(),
  })
  .merge(paginationSchema(MAX_LIMITS.events));
export type EventListReq = z.infer<typeof EventListReqSchema>;

export const TaskListReqSchema = z
  .object({
    project_id: uuid,
  })
  .merge(paginationSchema(MAX_LIMITS.tasks));
export type TaskListReq = z.infer<typeof TaskListReqSchema>;

export const AgentListReqSchema = paginationSchema(MAX_LIMITS.agents);
export type AgentListReq = z.infer<typeof AgentListReqSchema>;

export const ActorLifecycleStateSchema = z.enum(['active', 'inactive']);
export type ActorLifecycleState = z.infer<typeof ActorLifecycleStateSchema>;

export const AgentLifecycleTransitionIntentSchema = z.enum([
  'heartbeat',
  'deactivate',
]);
export type AgentLifecycleTransitionIntent = z.infer<
  typeof AgentLifecycleTransitionIntentSchema
>;

// ────────────────────────────────────────────────────────────────────────
// Verbs — response shapes
// ────────────────────────────────────────────────────────────────────────

export const TaskCreateResSchema = z.object({
  task: TaskSchema,
  agent_context: AgentContextSchema,
  event: EventSchema,
});
export type TaskCreateRes = z.infer<typeof TaskCreateResSchema>;

export const ProjectListResSchema = z.object({
  projects: z.array(ProjectSchema),
});
export type ProjectListRes = z.infer<typeof ProjectListResSchema>;

export const ProjectGetResSchema = z.object({
  project: ProjectSchema,
});
export type ProjectGetRes = z.infer<typeof ProjectGetResSchema>;

export const TaskGetResSchema = z.object({
  task: TaskSchema,
  agent_context: AgentContextSchema,
});
export type TaskGetRes = z.infer<typeof TaskGetResSchema>;

export const TaskUpdateStatusResSchema = z.object({
  task: TaskSchema,
  event: EventSchema,
});
export type TaskUpdateStatusRes = z.infer<typeof TaskUpdateStatusResSchema>;

export const EventListResSchema = z.object({
  events: z.array(EventWithActorSchema),
});
export type EventListRes = z.infer<typeof EventListResSchema>;

export const TaskListResSchema = z.object({
  tasks: z.array(TaskSchema),
});
export type TaskListRes = z.infer<typeof TaskListResSchema>;

// agents.list exposes the registry view of an actor — id, kind, display_name,
// and optional agent_runtime / parent_actor_id. The auth token is NEVER
// included in responses.
export const AgentSchema = z.object({
  id: uuid,
  kind: z.literal('agent'),
  display_name: z.string().min(1).max(200),
  agent_runtime: z.string().nullable(),
  parent_actor_id: uuid.nullable(),
});
export type Agent = z.infer<typeof AgentSchema>;

export const AgentListResSchema = z.object({
  agents: z.array(AgentSchema),
});
export type AgentListRes = z.infer<typeof AgentListResSchema>;

// ────────────────────────────────────────────────────────────────────────
// Append-only — Tessera v0.1.2 actor lifecycle.
// ────────────────────────────────────────────────────────────────────────

const ActorRegisterReqShape = z.object({
  // Use distinct error messages so ZodError → ActorValidationError mapping
  // (in service/actors.ts) renders the exact strings the conformance
  // fixtures assert on.
  operation_id: uuid,
  display_name: z
    .string({
      required_error: 'Required field is missing.',
      invalid_type_error: 'Must be a string.',
    })
    .min(1, { message: 'Required field is missing.' })
    .max(200),
  kind: z
    .string({
      required_error: 'Required field is missing.',
    })
    .refine((v) => v === 'human', {
      message: 'Only `human` is accepted in v0.1.2.',
    }),
});

export const ActorRegisterReqSchema = ActorRegisterReqShape.strict().transform(
  (v) => ({
    operation_id: v.operation_id,
    display_name: v.display_name,
    kind: v.kind as 'human',
  }),
);
export type ActorRegisterReq = {
  operation_id: string;
  display_name: string;
  kind: 'human';
};

export const ActorListReqSchema = z
  .object({
    kind: z.enum(['human', 'agent']).optional(),
  })
  .strict();
export type ActorListReq = z.infer<typeof ActorListReqSchema>;

export const ActorGetReqSchema = z
  .object({
    actor_id: uuid,
  })
  .strict();
export type ActorGetReq = z.infer<typeof ActorGetReqSchema>;

export const ActorRevokeTokenReqSchema = z
  .object({
    operation_id: uuid,
    actor_id: uuid,
  })
  .strict();
export type ActorRevokeTokenReq = z.infer<typeof ActorRevokeTokenReqSchema>;

export const ActorRegisterResSchema = z.object({
  actor: ActorSchema,
  // `token` is present ONLY on the first call; replay omits it. The
  // service layer guarantees the redaction.
  token: z.string().min(32).optional(),
});
export type ActorRegisterRes = z.infer<typeof ActorRegisterResSchema>;

export const ActorListResSchema = z.object({ actors: z.array(ActorSchema) });
export type ActorListRes = z.infer<typeof ActorListResSchema>;

export const ActorGetResSchema = z.object({ actor: ActorSchema });
export type ActorGetRes = z.infer<typeof ActorGetResSchema>;

export const ActorRevokeTokenResSchema = z.object({ actor: ActorSchema });
export type ActorRevokeTokenRes = z.infer<typeof ActorRevokeTokenResSchema>;
