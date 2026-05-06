// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera

import { mkdir, writeFile, readFile, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { StorageBackend } from './storage.ts';

// Validates UUID format to prevent path traversal via attachmentId.
// join() accepts '..' and absolute paths, so an unvalidated id could escape
// the storage root. UUIDs are hex + hyphens only, making this the only
// valid attachment id shape.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * LocalStorageBackend — writes attachment binaries to the local filesystem.
 *
 * Each attachment is stored as a single file named by its UUID under `dir`.
 * Suitable for dev, CI, and single-host deployments. Cloud deployments should
 * swap this for an S3StorageBackend that returns presigned PUT/GET URLs.
 *
 * Upload and download URLs are served by Sprino's own HTTP layer:
 *   PUT  /api/attachments/{id}/upload    → upload route calls write()
 *   GET  /api/attachments/{id}/download  → download route calls read()
 */
export class LocalStorageBackend implements StorageBackend {
  constructor(private readonly dir: string) {}

  uploadUrl(attachmentId: string): string {
    return `/api/attachments/${attachmentId}/upload`;
  }

  downloadUrl(attachmentId: string): string {
    return `/api/attachments/${attachmentId}/download`;
  }

  async write(attachmentId: string, data: Buffer): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.slotPath(attachmentId);
    // Guard against symlink-based escapes: if the slot path already exists,
    // it must be a regular file. writeFile() follows symlinks, so a
    // pre-planted symlink named after a UUID could overwrite arbitrary files.
    try {
      const info = await lstat(target);
      if (!info.isFile()) {
        throw new Error(`Attachment slot ${attachmentId} is not a regular file`);
      }
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
      // ENOENT is expected for a new slot — proceed to create.
    }
    await writeFile(target, data);
  }

  async exists(attachmentId: string): Promise<boolean> {
    try {
      // lstat (not stat) so symlinks report as symlinks, not as their targets.
      // Returning true only for regular files prevents directories and symlinks
      // from being misread as uploaded binaries.
      const info = await lstat(this.slotPath(attachmentId));
      return info.isFile() && info.size > 0;
    } catch (err: any) {
      if (err?.code === 'ENOENT') return false;
      // Re-throw permission errors, I/O failures, broken mounts — these are
      // storage outages, not "file not uploaded" situations.
      throw err;
    }
  }

  async read(attachmentId: string): Promise<Buffer> {
    return readFile(this.slotPath(attachmentId));
  }

  async remove(attachmentId: string): Promise<void> {
    try {
      await unlink(this.slotPath(attachmentId));
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }

  private slotPath(attachmentId: string): string {
    if (!UUID_RE.test(attachmentId)) {
      throw new Error(`Invalid attachment id: ${attachmentId}`);
    }
    return join(this.dir, attachmentId);
  }
}
