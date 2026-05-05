// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera

import { mkdir, writeFile, unlink, stat } from 'node:fs/promises';
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
 *   PUT  /api/attachments/{id}/upload  → upload route calls write()
 *   GET  /api/attachments/{id}         → download route streams the file
 */
export class LocalStorageBackend implements StorageBackend {
  constructor(private readonly dir: string) {}

  uploadUrl(attachmentId: string): string {
    return `/api/attachments/${attachmentId}/upload`;
  }

  downloadUrl(attachmentId: string): string {
    return `/api/attachments/${attachmentId}`;
  }

  async write(attachmentId: string, data: Buffer): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.slotPath(attachmentId), data);
  }

  async exists(attachmentId: string): Promise<boolean> {
    try {
      const info = await stat(this.slotPath(attachmentId));
      return info.size > 0;
    } catch (err: any) {
      if (err?.code === 'ENOENT') return false;
      // Re-throw permission errors, I/O failures, broken mounts — these are
      // storage outages, not "file not uploaded" situations.
      throw err;
    }
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
