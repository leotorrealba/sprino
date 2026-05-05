// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Attachment service — implements Tessera v0.1.4 attachment verbs.
 *
 *   attachment.create_upload  ── INSERT attachments (pending) + reserve upload slot
 *   attachment.finalize       ── UPDATE attachments (pending → ready) if binary present
 *   attachment.get            ── SELECT attachment by id (any status)
 *   attachment.list           ── SELECT ready, non-deleted attachments for task
 *
 * Architectural rules (locked):
 *   1. Business logic lives here. Adapters parse → call → translate errors.
 *   2. Idempotency checks happen before the transaction; operation row is
 *      written inside the same transaction as the attachment mutation.
 *   3. StorageBackend is injected so the service is storage-agnostic
 *      (local FS in dev/CI, S3 presigned URLs in cloud deploy).
 *
 * Errors (translated to HTTP status at the adapter layer):
 *   AttachmentNotFoundError       → 404 not_found
 *   AttachmentNotReadyError       → 409 binary_not_uploaded
 *   AttachmentTaskNotFoundError   → 404 task_not_found
 */

import { and, asc, eq, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '../db/client.ts';
import { attachments, tasks } from '../db/schema.ts';
import type { AttachmentRow } from '../db/schema.ts';
import type {
  Attachment,
  AttachmentCreateUploadReq,
  AttachmentCreateUploadRes,
  AttachmentFinalizeReq,
  AttachmentFinalizeRes,
  AttachmentGetReq,
  AttachmentGetRes,
  AttachmentListReq,
  AttachmentListRes,
} from '../domain/index.ts';
import type { StorageBackend } from './attachments/storage.ts';
import {
  checkIdempotency,
  hashRequest,
  recordOperation,
} from './idempotency.ts';

// ────────────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────────────

export class AttachmentNotFoundError extends Error {
  constructor(public readonly attachmentId: string) {
    super(`attachment ${attachmentId} not found`);
    this.name = 'AttachmentNotFoundError';
  }
}

export class AttachmentNotReadyError extends Error {
  constructor(public readonly attachmentId: string) {
    super(`attachment ${attachmentId}: binary has not been uploaded yet`);
    this.name = 'AttachmentNotReadyError';
  }
}

export class AttachmentTaskNotFoundError extends Error {
  constructor(public readonly taskId: string) {
    super(`task ${taskId} not found`);
    this.name = 'AttachmentTaskNotFoundError';
  }
}

// ────────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────────

function rowToAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    task_id: row.taskId,
    filename: row.filename,
    content_type: row.contentType,
    size_bytes: row.sizeBytes,
    status: row.status,
    url: row.url,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
  };
}

// ────────────────────────────────────────────────────────────────────────
// Verbs
// ────────────────────────────────────────────────────────────────────────

/**
 * attachment.create_upload — reserve an upload slot and return the pending
 * attachment + opaque upload URL. Idempotent via operation_id.
 */
export async function createUpload(
  db: Db,
  storage: StorageBackend,
  { req, actorId }: { req: AttachmentCreateUploadReq; actorId: string },
): Promise<AttachmentCreateUploadRes> {
  const requestHash = hashRequest(req);
  const cached = await checkIdempotency(db, req.operation_id, requestHash);
  if (cached !== null) return cached as AttachmentCreateUploadRes;

  const taskRows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.id, req.task_id))
    .limit(1);
  if (!taskRows[0]) throw new AttachmentTaskNotFoundError(req.task_id);

  const attachmentId = uuidv7();
  const uploadUrl = storage.uploadUrl(attachmentId);

  const response = await db.transaction(async (tx) => {
    await tx.insert(attachments).values({
      id: attachmentId,
      taskId: req.task_id,
      filename: req.filename,
      contentType: req.content_type,
      sizeBytes: req.size_bytes,
      status: 'pending',
      url: null,
      storageKey: attachmentId,
      createdBy: actorId,
    });
    const [inserted] = await tx
      .select()
      .from(attachments)
      .where(eq(attachments.id, attachmentId))
      .limit(1);
    const res: AttachmentCreateUploadRes = {
      attachment: rowToAttachment(inserted!),
      upload_url: uploadUrl,
    };
    await recordOperation(tx, {
      operationId: req.operation_id,
      actorId,
      requestHash,
      responseBody: res,
    });
    return res;
  });

  return response;
}

/**
 * attachment.finalize — confirm the binary upload, transition to ready, set url.
 * Idempotent via operation_id. Domain-idempotent: already-ready attachments
 * return the current state without error.
 */
export async function finalize(
  db: Db,
  storage: StorageBackend,
  { req, actorId }: { req: AttachmentFinalizeReq; actorId: string },
): Promise<AttachmentFinalizeRes> {
  const requestHash = hashRequest(req);
  const cached = await checkIdempotency(db, req.operation_id, requestHash);
  if (cached !== null) return cached as AttachmentFinalizeRes;

  const [row] = await db
    .select()
    .from(attachments)
    .where(eq(attachments.id, req.attachment_id))
    .limit(1);
  if (!row) throw new AttachmentNotFoundError(req.attachment_id);

  // Domain idempotent: already finalized — record operation and return as-is.
  if (row.status === 'ready') {
    const res: AttachmentFinalizeRes = { attachment: rowToAttachment(row) };
    await recordOperation(db, {
      operationId: req.operation_id,
      actorId,
      requestHash,
      responseBody: res,
    });
    return res;
  }

  const storageKey = row.storageKey ?? row.id;
  const uploaded = await storage.exists(storageKey);
  if (!uploaded) throw new AttachmentNotReadyError(req.attachment_id);

  const now = new Date();
  const downloadUrl = storage.downloadUrl(row.id);

  const response = await db.transaction(async (tx) => {
    await tx
      .update(attachments)
      .set({ status: 'ready', url: downloadUrl, finalizedAt: now })
      .where(eq(attachments.id, req.attachment_id));
    const [updated] = await tx
      .select()
      .from(attachments)
      .where(eq(attachments.id, req.attachment_id))
      .limit(1);
    const res: AttachmentFinalizeRes = { attachment: rowToAttachment(updated!) };
    await recordOperation(tx, {
      operationId: req.operation_id,
      actorId,
      requestHash,
      responseBody: res,
    });
    return res;
  });

  return response;
}

/**
 * attachment.get — fetch a single attachment by id.
 * Returns any status (pending or ready). Does NOT expose upload_url.
 */
export async function getAttachment(
  db: Db,
  { req }: { req: AttachmentGetReq },
): Promise<AttachmentGetRes> {
  const [row] = await db
    .select()
    .from(attachments)
    .where(eq(attachments.id, req.attachment_id))
    .limit(1);
  if (!row) throw new AttachmentNotFoundError(req.attachment_id);
  return { attachment: rowToAttachment(row) };
}

/**
 * attachment.list — list all non-deleted ready attachments for a task,
 * ordered by created_at ascending. Pending attachments are excluded.
 */
export async function listAttachments(
  db: Db,
  { req }: { req: AttachmentListReq },
): Promise<AttachmentListRes> {
  const rows = await db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.taskId, req.task_id),
        eq(attachments.status, 'ready'),
        isNull(attachments.deletedAt),
      ),
    )
    .orderBy(asc(attachments.createdAt));
  return { attachments: rows.map(rowToAttachment) };
}
