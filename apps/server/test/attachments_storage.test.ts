// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * C2 — Attachment storage foundation.
 *
 * P1: DB metadata — confirms the migration ran and Drizzle types match.
 * P2: StorageBackend integrity — exercises LocalStorageBackend in isolation
 *     using a temp directory; no DB required for the storage suite.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm, readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../src/db/client.ts';
import { attachments } from '../src/db/schema.ts';
import type { AttachmentRow } from '../src/db/schema.ts';
import { LocalStorageBackend } from '../src/service/attachments/local-storage.ts';

// ──────────────────────────────────────────────────────────────────────────
// C2-P1 — DB metadata
// ──────────────────────────────────────────────────────────────────────────

describe('attachments DB metadata (C2-P1)', () => {
  it('attachments table exists', async () => {
    const result = await db.execute<{ t: string | null }>(
      sql`SELECT to_regclass('public.attachments') AS t`,
    );
    expect(result.rows[0]?.t).toBe('attachments');
  });

  it('attachment_status enum has exactly pending and ready', async () => {
    const result = await db.execute<{ enumlabel: string }>(sql`
      SELECT enumlabel
      FROM pg_enum
      JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
      WHERE pg_type.typname = 'attachment_status'
      ORDER BY enumlabel
    `);
    expect(result.rows.map((r) => r.enumlabel)).toEqual(['pending', 'ready']);
  });

  it('Drizzle infers AttachmentRow with all required fields', () => {
    // If schema.ts is wrong this block fails to compile — caught by typecheck.
    const _row: AttachmentRow = {
      id: uuidv7(),
      taskId: uuidv7(),
      filename: 'design-review.png',
      contentType: 'image/png',
      sizeBytes: 42187,
      status: 'pending',
      url: null,
      storageKey: null,
      createdBy: uuidv7(),
      createdAt: new Date(),
      finalizedAt: null,
      deletedAt: null,
    };
    expect(_row.status).toBe('pending');
  });

  it('attachments table has a task_id foreign key to tasks', async () => {
    const result = await db.execute<{ conname: string }>(sql`
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class src ON c.conrelid = src.oid
      WHERE src.relname = 'attachments'
        AND c.contype = 'f'
        AND c.confrelid = 'tasks'::regclass
    `);
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('DB enforces pending invariant (url and finalized_at must be NULL when pending)', async () => {
    const result = await db.execute<{ conname: string }>(sql`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'attachments'::regclass
        AND contype = 'c'
        AND conname = 'attachments_pending_invariant'
    `);
    expect(result.rows.length).toBe(1);
  });

  it('DB enforces ready invariant (url and finalized_at must be non-NULL when ready)', async () => {
    const result = await db.execute<{ conname: string }>(sql`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'attachments'::regclass
        AND contype = 'c'
        AND conname = 'attachments_ready_invariant'
    `);
    expect(result.rows.length).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// C2-P2 — StorageBackend integrity (LocalStorageBackend)
// ──────────────────────────────────────────────────────────────────────────

describe('LocalStorageBackend (C2-P2)', () => {
  const tmpDir = join(tmpdir(), `sprino-storage-test-${Date.now()}`);
  const storage = new LocalStorageBackend(tmpDir);

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('uploadUrl returns the Sprino upload route for the attachment id', () => {
    const id = uuidv7();
    expect(storage.uploadUrl(id)).toBe(`/api/attachments/${id}/upload`);
  });

  it('downloadUrl returns the Sprino download route for the attachment id', () => {
    const id = uuidv7();
    expect(storage.downloadUrl(id)).toBe(`/api/attachments/${id}`);
  });

  it('exists returns false before any write', async () => {
    expect(await storage.exists(uuidv7())).toBe(false);
  });

  it('write then exists returns true', async () => {
    const id = uuidv7();
    await storage.write(id, Buffer.from('hello attachment'));
    expect(await storage.exists(id)).toBe(true);
  });

  it('write creates the storage directory if it does not exist', async () => {
    const nested = new LocalStorageBackend(join(tmpDir, 'deep', 'nested'));
    const id = uuidv7();
    await nested.write(id, Buffer.from('data'));
    expect(await nested.exists(id)).toBe(true);
  });

  it('write preserves binary content exactly', async () => {
    const id = uuidv7();
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]); // PNG header bytes
    await storage.write(id, data);
    // Read back directly from disk so any in-memory caching cannot mask corruption.
    const stored = await readFile(join(tmpDir, id));
    expect(stored).toEqual(data);
  });

  it('remove deletes the stored binary', async () => {
    const id = uuidv7();
    await storage.write(id, Buffer.from('data'));
    await storage.remove(id);
    expect(await storage.exists(id)).toBe(false);
  });

  it('remove is idempotent when the slot was never written', async () => {
    await expect(storage.remove(uuidv7())).resolves.toBeUndefined();
  });

  it('remove is idempotent when called twice', async () => {
    const id = uuidv7();
    await storage.write(id, Buffer.from('data'));
    await storage.remove(id);
    await expect(storage.remove(id)).resolves.toBeUndefined();
  });

  it('exists returns false for empty file (zero-byte write)', async () => {
    const id = uuidv7();
    await storage.write(id, Buffer.alloc(0));
    // An empty slot is not a valid upload — exists() guards against it.
    expect(await storage.exists(id)).toBe(false);
  });

  it('rejects non-UUID attachment ids to prevent path traversal', async () => {
    await expect(storage.write('../escape', Buffer.from('x'))).rejects.toThrow(
      'Invalid attachment id',
    );
    await expect(storage.exists('../escape')).rejects.toThrow(
      'Invalid attachment id',
    );
    await expect(storage.remove('../escape')).rejects.toThrow(
      'Invalid attachment id',
    );
  });

  it('two distinct attachment ids do not collide in the same dir', async () => {
    const a = uuidv7();
    const b = uuidv7();
    await storage.write(a, Buffer.from('alpha'));
    await storage.write(b, Buffer.from('beta'));
    expect(await storage.exists(a)).toBe(true);
    expect(await storage.exists(b)).toBe(true);
    await storage.remove(a);
    expect(await storage.exists(a)).toBe(false);
    expect(await storage.exists(b)).toBe(true);
  });
});
