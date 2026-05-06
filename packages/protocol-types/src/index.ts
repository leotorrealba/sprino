// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * @sprino/protocol-types — shared wire types for Tessera v0.0.2.
 *
 * This package is the shared TypeScript/Zod mirror of the canonical JSON
 * Schemas in `tessera/schemas/`. The web app imports these types directly;
 * the server keeps its own adapter-boundary validators until schema
 * generation/checking is wired in.
 *
 * Cross-checking note (deferred to v0.0.2): a CI test will verify that
 * `z.toJSONSchema()` output of these schemas matches the JSON Schemas
 * committed to the `tessera` repo. Until then, manual review at every
 * protocol bump.
 */

import { z } from 'zod';

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
// Verbs (v0.0.2: projects + task.create repo auto-resolution)
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

// Sprino-specific (not part of canonical Tessera protocol — Sprino extension
// for the activity-feed UI). Server endpoint: GET /api/events.
export const EventWithActorSchema = EventSchema.extend({
  actor: z.object({
    id: uuid,
    display_name: z.string(),
    kind: ActorKindSchema,
  }),
  task: z.object({
    id: uuid,
    title: z.string(),
  }),
});
export type EventWithActor = z.infer<typeof EventWithActorSchema>;

export const EventListResSchema = z.object({
  events: z.array(EventWithActorSchema),
});
export type EventListRes = z.infer<typeof EventListResSchema>;

// ────────────────────────────────────────────────────────────────────────
// project.create (Tessera v0.1.5)
// ────────────────────────────────────────────────────────────────────────

export const ProjectCreateReqSchema = z.object({
  operation_id: uuid,
  slug: projectSlug,
  display_name: z.string().min(1).max(200),
  repo_path: z.string().min(1).nullable().optional(),
});
export type ProjectCreateReq = z.infer<typeof ProjectCreateReqSchema>;

export const ProjectCreateResSchema = z.object({
  project: ProjectSchema,
});
export type ProjectCreateRes = z.infer<typeof ProjectCreateResSchema>;

// ────────────────────────────────────────────────────────────────────────
// Attachment resource + verbs (Tessera v0.1.4)
// ────────────────────────────────────────────────────────────────────────

export const AttachmentStatusSchema = z.enum(['pending', 'ready']);
export type AttachmentStatus = z.infer<typeof AttachmentStatusSchema>;

export const AttachmentSchema = z.object({
  id: uuid,
  task_id: uuid,
  filename: z.string().min(1).max(255),
  content_type: z.string().min(1).max(127),
  size_bytes: z.number().int().min(1),
  status: AttachmentStatusSchema,
  url: z.string().min(1).nullable(),
  created_by: uuid,
  created_at: isoDateTime,
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const AttachmentCreateUploadReqSchema = z.object({
  operation_id: uuid,
  task_id: uuid,
  filename: z.string().min(1).max(255),
  content_type: z.string().min(1).max(127),
  size_bytes: z.number().int().min(1),
});
export type AttachmentCreateUploadReq = z.infer<typeof AttachmentCreateUploadReqSchema>;

export const AttachmentCreateUploadResSchema = z.object({
  attachment: AttachmentSchema,
  upload_url: z.string().min(1),
});
export type AttachmentCreateUploadRes = z.infer<typeof AttachmentCreateUploadResSchema>;

export const AttachmentFinalizeReqSchema = z.object({
  operation_id: uuid,
  attachment_id: uuid,
});
export type AttachmentFinalizeReq = z.infer<typeof AttachmentFinalizeReqSchema>;

export const AttachmentFinalizeResSchema = z.object({
  attachment: AttachmentSchema,
});
export type AttachmentFinalizeRes = z.infer<typeof AttachmentFinalizeResSchema>;

export const AttachmentGetReqSchema = z.object({ attachment_id: uuid });
export type AttachmentGetReq = z.infer<typeof AttachmentGetReqSchema>;

export const AttachmentGetResSchema = z.object({
  attachment: AttachmentSchema,
});
export type AttachmentGetRes = z.infer<typeof AttachmentGetResSchema>;

export const AttachmentListReqSchema = z.object({
  task_id: uuid,
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});
export type AttachmentListReq = z.infer<typeof AttachmentListReqSchema>;

export const AttachmentListResSchema = z.object({
  attachments: z.array(AttachmentSchema),
});
export type AttachmentListRes = z.infer<typeof AttachmentListResSchema>;

export const PROTOCOL_VERSION = 'tessera/v0.1.5';
