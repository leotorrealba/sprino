// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera

/**
 * StorageBackend — abstraction over binary file storage for attachments.
 *
 * Implementations:
 *   LocalStorageBackend — writes to the local filesystem (dev/test/single-host).
 *   Future: S3StorageBackend — presigned PUT URLs for cloud deploy.
 *
 * URL contract (Tessera v0.1.4):
 *   uploadUrl   — opaque URL the client PUTs binary data to. For local storage
 *                 this is the Sprino upload route; for S3 it is a presigned URL.
 *   downloadUrl — opaque URL returned in the ready attachment's `url` field.
 *                 The Tessera spec makes no guarantee about URL format beyond
 *                 "implementation-defined and non-null once ready."
 */
export interface StorageBackend {
  /** Opaque URL the client PUTs binary data to (returned by attachment.create_upload). */
  uploadUrl(attachmentId: string): string;

  /** Opaque download URL set on the attachment once finalized (returned by attachment.finalize). */
  downloadUrl(attachmentId: string): string;

  /** Persist binary data for this attachment. Called by the upload route handler. */
  write(attachmentId: string, data: Buffer): Promise<void>;

  /** True if binary data has been written and is non-empty for this attachment. */
  exists(attachmentId: string): Promise<boolean>;

  /** Read stored binary. Throws if the slot was never written. */
  read(attachmentId: string): Promise<Buffer>;

  /** Remove stored binary. Silently succeeds if the slot was never written. */
  remove(attachmentId: string): Promise<void>;
}
