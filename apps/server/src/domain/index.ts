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
  workflow_column_id: uuid.nullable(),
  rank: z.number().int().min(0),
  parent_task_id: uuid.nullable(),
  points: z.number().int().min(0).nullable(),
});
export type Task = z.infer<typeof TaskSchema>;

export const EventKindSchema = z.enum([
  'created',
  'status_changed',
  'assigned',
  'context_updated',
  'commented',
  'workflow_transitioned',
]);
export type EventKind = z.infer<typeof EventKindSchema>;

export const EventSchema = z.object({
  id: uuid,
  task_id: uuid,
  actor_id: uuid,
  kind: EventKindSchema,
  payload: z.record(z.string(), z.unknown()),
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

// ── D1: Workflow State Machine ────────────────────────────────────────────

export const WorkflowColumnSchema = z.object({
  id: uuid,
  project_id: uuid,
  name: z.string().min(1).max(80),
  position: z.number().int().min(0),
  maps_to_status: TaskStatusSchema,
  is_default: z.boolean(),
  created_at: isoDateTime,
});
export type WorkflowColumn = z.infer<typeof WorkflowColumnSchema>;

export const WorkflowTransitionSchema = z.object({
  from_column_id: uuid,
  to_column_id: uuid,
});
export type WorkflowTransition = z.infer<typeof WorkflowTransitionSchema>;

export const WorkflowColumnsListResSchema = z.object({
  columns: z.array(WorkflowColumnSchema),
  transitions: z.array(WorkflowTransitionSchema),
});
export type WorkflowColumnsListRes = z.infer<typeof WorkflowColumnsListResSchema>;

export const TaskTransitionWorkflowReqSchema = z.object({
  operation_id: uuid,
  task_id: uuid,
  to_column_id: uuid,
  if_match: z.number().int().min(1),
  notes: z.string().max(2048).optional(),
});
export type TaskTransitionWorkflowReq = z.infer<typeof TaskTransitionWorkflowReqSchema>;

export const TaskTransitionWorkflowResSchema = z.object({
  task: TaskSchema,
  event: EventSchema,
});
export type TaskTransitionWorkflowRes = z.infer<typeof TaskTransitionWorkflowResSchema>;

// ── D2: Task Reorder ──────────────────────────────────────────────────────

export const TaskReorderReqSchema = z.object({
  operation_id: uuid,
  task_id: uuid,
  column_id: uuid,
  after_task_id: uuid.nullable(),
});
export type TaskReorderReq = z.infer<typeof TaskReorderReqSchema>;

export const TaskReorderResSchema = z.object({
  tasks: z.array(TaskSchema),
});
export type TaskReorderRes = z.infer<typeof TaskReorderResSchema>;

// ── D3: Hierarchy and Dependencies ────────────────────────────────────────

export const SetParentReqSchema = z.object({
  task_id: uuid,
  parent_task_id: uuid.nullable(),
});
export type SetParentReq = z.infer<typeof SetParentReqSchema>;

export const SetParentResSchema = z.object({ task: TaskSchema });
export type SetParentRes = z.infer<typeof SetParentResSchema>;

export const AddDependencyReqSchema = z.object({
  task_id: uuid,
  blocked_by_task_id: uuid,
});
export type AddDependencyReq = z.infer<typeof AddDependencyReqSchema>;

export const AddDependencyResSchema = z.object({ task: TaskSchema });
export type AddDependencyRes = z.infer<typeof AddDependencyResSchema>;

export const RemoveDependencyReqSchema = z.object({
  task_id: uuid,
  blocked_by_task_id: uuid,
});
export type RemoveDependencyReq = z.infer<typeof RemoveDependencyReqSchema>;

export const ListDependenciesReqSchema = z.object({ task_id: uuid });
export type ListDependenciesReq = z.infer<typeof ListDependenciesReqSchema>;

export const ListDependenciesResSchema = z.object({
  blocked_by: z.array(TaskSchema),
});
export type ListDependenciesRes = z.infer<typeof ListDependenciesResSchema>;

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
    status: z.array(TaskStatusSchema).optional(),
    assignee_id: uuid.optional(),
    parent_task_id: uuid.optional(),
    title_contains: z.string().max(200).optional(),
    sprint_id: uuid.optional(),
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
  blocked_by: z.array(TaskSchema).optional(),
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

const ActorRegisterBaseReqShape = z.object({
  // Use distinct error messages so ZodError → ActorValidationError mapping
  // (in service/actors.ts) renders the exact strings the conformance
  // fixtures assert on.
  operation_id: uuid,
  display_name: z
    .string({ error: 'Required field is missing.' })
    .min(1, { message: 'Required field is missing.' })
    .max(200),
});

const AGENT_REGISTER_FIELDS_REQUIRED =
  'Agent registration requires both `agent_runtime` and `parent_actor_id`.';
const HUMAN_REGISTER_AGENT_FIELDS_REJECTED =
  'Agent-only fields are not accepted for human registration.';
const ACTOR_KIND_UNSUPPORTED =
  'Only `human` or `agent` is accepted.';
const AGENT_RUNTIME_MAX_LENGTH = 120;

export type ActorRegisterReq =
  | {
      operation_id: string;
      display_name: string;
      kind: 'human';
    }
  | {
      operation_id: string;
      display_name: string;
      kind: 'agent';
      agent_runtime: string;
      parent_actor_id: string;
    };

export const ActorRegisterReqSchema = ActorRegisterBaseReqShape.extend({
  kind: z
    .string({ error: 'Required field is missing.' })
    .refine((kind) => kind === 'human' || kind === 'agent', {
      message: ACTOR_KIND_UNSUPPORTED,
    }),
  agent_runtime: z.unknown().optional(),
  parent_actor_id: z.unknown().optional(),
})
  .strict()
  .superRefine((req, ctx) => {
    if (
      req.kind === 'human' &&
      (req.agent_runtime !== undefined ||
        req.parent_actor_id !== undefined)
    ) {
      const path =
        req.agent_runtime === undefined &&
        req.parent_actor_id !== undefined
          ? ['parent_actor_id']
          : ['agent_runtime'];
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: HUMAN_REGISTER_AGENT_FIELDS_REJECTED,
      });
      return;
    }

    if (
      req.kind === 'agent' &&
      (req.agent_runtime === undefined ||
        req.parent_actor_id === undefined)
    ) {
      const path =
        req.agent_runtime !== undefined &&
        req.parent_actor_id === undefined
          ? ['parent_actor_id']
          : ['agent_runtime'];
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: AGENT_REGISTER_FIELDS_REQUIRED,
      });
      return;
    }

    if (req.kind !== 'agent') {
      return;
    }

    if (typeof req.agent_runtime !== 'string') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agent_runtime'],
        message: 'Must be a string.',
      });
    } else if (req.agent_runtime.length < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agent_runtime'],
        message: 'Required field is missing.',
      });
    } else if (req.agent_runtime.length > AGENT_RUNTIME_MAX_LENGTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agent_runtime'],
        message: `Must be at most ${AGENT_RUNTIME_MAX_LENGTH} characters.`,
      });
    }

    if (typeof req.parent_actor_id !== 'string') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['parent_actor_id'],
        message: 'Must be a string.',
      });
    } else {
      const parentActorIdResult = uuid.safeParse(req.parent_actor_id);
      if (!parentActorIdResult.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['parent_actor_id'],
          message:
            parentActorIdResult.error.issues[0]?.message ?? 'Invalid uuid',
        });
      }
    }
  })
  .transform((req): ActorRegisterReq => {
    if (req.kind === 'human') {
      return {
        operation_id: req.operation_id,
        display_name: req.display_name,
        kind: req.kind,
      };
    }

    return {
      operation_id: req.operation_id,
      display_name: req.display_name,
      kind: req.kind,
      agent_runtime: req.agent_runtime as string,
      parent_actor_id: req.parent_actor_id as string,
    };
  });

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

export const ActorHeartbeatReqSchema = z
  .object({
    actor_id: uuid,
  })
  .strict();
export type ActorHeartbeatReq = z.infer<typeof ActorHeartbeatReqSchema>;

export const ActorRevokeTokenReqSchema = z
  .object({
    operation_id: uuid,
    actor_id: uuid,
  })
  .strict();
export type ActorRevokeTokenReq = z.infer<typeof ActorRevokeTokenReqSchema>;

export const ActorDeactivateReqSchema = z
  .object({
    operation_id: uuid,
    actor_id: uuid,
  })
  .strict();
export type ActorDeactivateReq = z.infer<typeof ActorDeactivateReqSchema>;

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

export const ActorHeartbeatResSchema = z.object({ actor: ActorSchema });
export type ActorHeartbeatRes = z.infer<typeof ActorHeartbeatResSchema>;

export const ActorRevokeTokenResSchema = z.object({ actor: ActorSchema });
export type ActorRevokeTokenRes = z.infer<typeof ActorRevokeTokenResSchema>;

// ────────────────────────────────────────────────────────────────────────
// Attachment resource + verbs (Tessera v0.1.4)
// ────────────────────────────────────────────────────────────────────────

export const AttachmentSchema = z.object({
  id: uuid,
  task_id: uuid,
  filename: z.string().min(1).max(255),
  content_type: z.string().min(1).max(127),
  size_bytes: z.number().int().min(1),
  status: z.enum(['pending', 'ready']),
  url: z.string().min(1).nullable(),
  created_by: uuid,
  created_at: isoDateTime,
});
export type Attachment = z.infer<typeof AttachmentSchema>;

// attachment.create_upload
export const AttachmentCreateUploadReqSchema = z
  .object({
    operation_id: uuid,
    task_id: uuid,
    filename: z.string().min(1).max(255),
    content_type: z.string().min(1).max(127),
    size_bytes: z.number().int().min(1),
  })
  .strict();
export type AttachmentCreateUploadReq = z.infer<typeof AttachmentCreateUploadReqSchema>;

export const AttachmentCreateUploadResSchema = z.object({
  attachment: AttachmentSchema,
  upload_url: z.string().min(1),
});
export type AttachmentCreateUploadRes = z.infer<typeof AttachmentCreateUploadResSchema>;

// attachment.finalize
export const AttachmentFinalizeReqSchema = z
  .object({
    operation_id: uuid,
    attachment_id: uuid,
  })
  .strict();
export type AttachmentFinalizeReq = z.infer<typeof AttachmentFinalizeReqSchema>;

export const AttachmentFinalizeResSchema = z.object({
  attachment: AttachmentSchema,
});
export type AttachmentFinalizeRes = z.infer<typeof AttachmentFinalizeResSchema>;

// attachment.get
export const AttachmentGetReqSchema = z
  .object({ attachment_id: uuid })
  .strict();
export type AttachmentGetReq = z.infer<typeof AttachmentGetReqSchema>;

export const AttachmentGetResSchema = z.object({
  attachment: AttachmentSchema,
});
export type AttachmentGetRes = z.infer<typeof AttachmentGetResSchema>;

// attachment.list
export const AttachmentListReqSchema = z
  .object({ task_id: uuid })
  .merge(paginationSchema(MAX_LIMITS.attachments));
export type AttachmentListReq = z.infer<typeof AttachmentListReqSchema>;

export const AttachmentListResSchema = z.object({
  attachments: z.array(AttachmentSchema),
});
export type AttachmentListRes = z.infer<typeof AttachmentListResSchema>;

// ────────────────────────────────────────────────────────────────────────
// project.create (Tessera v0.1.5)
// ────────────────────────────────────────────────────────────────────────

export const ProjectCreateReqSchema = z
  .object({
    operation_id: uuid,
    slug: projectSlug,
    display_name: z.string().min(1).max(200),
    repo_path: z.string().min(1).nullable().optional(),
  })
  .strict();
export type ProjectCreateReq = z.infer<typeof ProjectCreateReqSchema>;

export const ProjectCreateResSchema = z.object({
  project: ProjectSchema,
});
export type ProjectCreateRes = z.infer<typeof ProjectCreateResSchema>;

// ── D4: Sprint Planning ────────────────────────────────────────────────────

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const SprintStatusSchema = z.enum(['planning', 'active', 'completed']);
export type SprintStatus = z.infer<typeof SprintStatusSchema>;

export const SprintSchema = z.object({
  id: uuid,
  project_id: uuid,
  name: z.string().min(1).max(200),
  status: SprintStatusSchema,
  starts_on: isoDate,
  ends_on: isoDate,
  version: z.number().int().min(1),
  created_by: uuid,
  created_at: isoDateTime,
  updated_at: isoDateTime,
});
export type Sprint = z.infer<typeof SprintSchema>;

export const BurndownPointSchema = z.object({
  date: isoDate,
  remaining: z.number().int().min(0),
});
export type BurndownPoint = z.infer<typeof BurndownPointSchema>;

export const SprintGetReqSchema = z.object({ sprint_id: uuid });
export type SprintGetReq = z.infer<typeof SprintGetReqSchema>;

export const SprintGetResSchema = z.object({
  sprint: SprintSchema,
  tasks: z.array(TaskSchema),
  burndown_series: z.array(BurndownPointSchema),
  burndown_metric: z.enum(['tasks', 'points']),
});
export type SprintGetRes = z.infer<typeof SprintGetResSchema>;

export const SprintCreateReqSchema = z.object({
  operation_id: uuid,
  project_id: uuid,
  name: z.string().min(1).max(200),
  starts_on: isoDate,
  ends_on: isoDate,
});
export type SprintCreateReq = z.infer<typeof SprintCreateReqSchema>;

export const SprintCreateResSchema = z.object({ sprint: SprintSchema });
export type SprintCreateRes = z.infer<typeof SprintCreateResSchema>;

export const SprintTransitionReqSchema = z.object({
  operation_id: uuid,
  sprint_id: uuid,
  to_status: z.enum(['active', 'completed']),
  if_match: z.number().int().min(1),
});
export type SprintTransitionReq = z.infer<typeof SprintTransitionReqSchema>;

export const SprintTransitionResSchema = z.object({
  sprint: SprintSchema,
  carry_over_tasks: z.array(TaskSchema).optional(),
});
export type SprintTransitionRes = z.infer<typeof SprintTransitionResSchema>;

export const SprintListReqSchema = z.object({
  project_id: uuid,
  status: SprintStatusSchema.optional(),
});
export type SprintListReq = z.infer<typeof SprintListReqSchema>;

export const SprintListResSchema = z.object({ sprints: z.array(SprintSchema) });
export type SprintListRes = z.infer<typeof SprintListResSchema>;

export const AssignToSprintReqSchema = z.object({
  operation_id: uuid,
  sprint_id: uuid,
  task_id: uuid,
});
export type AssignToSprintReq = z.infer<typeof AssignToSprintReqSchema>;

export const AssignToSprintResSchema = z.object({ task: TaskSchema });
export type AssignToSprintRes = z.infer<typeof AssignToSprintResSchema>;

export const RemoveFromSprintReqSchema = z.object({
  sprint_id: uuid,
  task_id: uuid,
});
export type RemoveFromSprintReq = z.infer<typeof RemoveFromSprintReqSchema>;

export const UpdateTaskPointsReqSchema = z.object({
  operation_id: uuid,
  task_id: uuid,
  points: z.number().int().min(0).nullable(),
  if_match: z.number().int().min(1),
});
export type UpdateTaskPointsReq = z.infer<typeof UpdateTaskPointsReqSchema>;

export const UpdateTaskPointsResSchema = z.object({
  task: TaskSchema,
  event: EventSchema,
});
export type UpdateTaskPointsRes = z.infer<typeof UpdateTaskPointsResSchema>;

// ── D5: Search, Views, and Automation ─────────────────────────────────────

export const TaskFiltersSchema = z.object({
  status: z.array(TaskStatusSchema).optional(),
  assignee_id: uuid.optional(),
  parent_task_id: uuid.optional(),
  title_contains: z.string().max(200).optional(),
  sprint_id: uuid.optional(),
});
export type TaskFilters = z.infer<typeof TaskFiltersSchema>;

export const SavedViewSchema = z.object({
  id: uuid,
  project_id: uuid,
  name: z.string().min(1).max(100),
  filters: TaskFiltersSchema,
  created_by: uuid,
  created_at: isoDateTime,
});
export type SavedView = z.infer<typeof SavedViewSchema>;

export const SavedViewCreateReqSchema = z.object({
  project_id: uuid,
  name: z.string().min(1).max(100),
  filters: TaskFiltersSchema,
});
export type SavedViewCreateReq = z.infer<typeof SavedViewCreateReqSchema>;

export const SavedViewCreateResSchema = z.object({ saved_view: SavedViewSchema });
export type SavedViewCreateRes = z.infer<typeof SavedViewCreateResSchema>;

export const SavedViewListResSchema = z.object({ saved_views: z.array(SavedViewSchema) });
export type SavedViewListRes = z.infer<typeof SavedViewListResSchema>;

export const AutomationRuleSchema = z.object({
  id: uuid,
  project_id: uuid,
  name: z.string().min(1).max(200),
  trigger_field: z.enum(['status', 'assignee_id']),
  trigger_value: z.string().nullable(),
  action_value: z.string().nullable(),
  action_field: z.enum(['status', 'assignee_id']),
  is_active: z.boolean(),
  created_by: uuid,
  created_at: isoDateTime,
});
export type AutomationRule = z.infer<typeof AutomationRuleSchema>;

export const AutomationRuleCreateReqSchema = z.object({
  project_id: uuid,
  name: z.string().min(1).max(200),
  trigger_field: z.enum(['status', 'assignee_id']),
  trigger_value: z.string().nullable().optional(),
  action_field: z.enum(['status', 'assignee_id']),
  action_value: z.string().nullable().optional(),
});
export type AutomationRuleCreateReq = z.infer<typeof AutomationRuleCreateReqSchema>;

export const AutomationRuleCreateResSchema = z.object({ automation_rule: AutomationRuleSchema });
export type AutomationRuleCreateRes = z.infer<typeof AutomationRuleCreateResSchema>;

export const AutomationRuleListResSchema = z.object({
  automation_rules: z.array(AutomationRuleSchema),
});
export type AutomationRuleListRes = z.infer<typeof AutomationRuleListResSchema>;

// ── E1: Workspace ────────────────────────────────────────────────────────

export const WorkspaceSchema = z.object({
  id: uuid,
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(50),
  created_by: uuid.nullable(),
  created_at: isoDateTime,
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const WorkspaceCreateReqSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(50).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
});
export type WorkspaceCreateReq = z.infer<typeof WorkspaceCreateReqSchema>;

export const WorkspaceCreateResSchema = z.object({
  workspace: WorkspaceSchema,
});
export type WorkspaceCreateRes = z.infer<typeof WorkspaceCreateResSchema>;

export const WorkspaceListResSchema = z.object({
  workspaces: z.array(WorkspaceSchema),
});
export type WorkspaceListRes = z.infer<typeof WorkspaceListResSchema>;

export const WorkspaceMemberSchema = z.object({
  workspace_id: uuid,
  actor_id: uuid,
  role: z.enum(['admin', 'member']),
  joined_at: isoDateTime,
});
export type WorkspaceMember = z.infer<typeof WorkspaceMemberSchema>;

export const WorkspaceMemberAddReqSchema = z.object({
  actor_id: uuid,
  role: z.enum(['admin', 'member']).optional(),
});
export type WorkspaceMemberAddReq = z.infer<typeof WorkspaceMemberAddReqSchema>;

export const WorkspaceMemberListResSchema = z.object({
  members: z.array(WorkspaceMemberSchema),
});
export type WorkspaceMemberListRes = z.infer<typeof WorkspaceMemberListResSchema>;
