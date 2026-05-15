// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * C3 — Attachment service layer + HTTP adapter.
 *
 * P1: Service layer — direct calls with an injected temp-dir storage.
 *     Covers all four verbs: createUpload, finalize, getAttachment, listAttachments.
 * P2: HTTP adapter — five routes via buildTestApp() + the singleton storage dir
 *     set to /tmp/sprino-test-attachments via ATTACHMENT_STORAGE_DIR in env-setup.ts.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.ts';
import { attachments } from '../src/db/schema.ts';
import { LocalStorageBackend } from '../src/service/attachments/local-storage.ts';
import {
  AttachmentAlreadyFinalizedError,
  AttachmentNotFoundError,
  AttachmentNotReadyError,
  AttachmentTaskNotFoundError,
  createUpload,
  finalize,
  getAttachment,
  listAttachments,
  uploadBytes,
} from '../src/service/attachments.ts';
import {
  FIXTURE_ACTOR_ID,
  FIXTURE_PROJECT_ID,
  FIXTURE_TASK_ID,
  FIXTURE_TOKEN,
  buildTestApp,
  seedFixtureTask,
} from './setup.ts';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

// ──────────────────────────────────────────────────────────────────────────
// C3-P1 — Service layer
// ──────────────────────────────────────────────────────────────────────────

describe('attachment service (C3-P1)', () => {
  const tmpDir = join(tmpdir(), `sprino-attach-svc-${Date.now()}`);
  const storage = new LocalStorageBackend(tmpDir);

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCreateReq(overrides: Record<string, unknown> = {}) {
    return {
      operation_id: uuidv7(),
      task_id: FIXTURE_TASK_ID,
      filename: 'photo.jpg',
      content_type: 'image/jpeg',
      size_bytes: 1024,
      ...overrides,
    };
  }

  it('createUpload inserts a pending attachment and returns upload_url', async () => {
    await seedFixtureTask();
    const req = makeCreateReq();
    const res = await createUpload(db, storage, { req, actorId: FIXTURE_ACTOR_ID });
    expect(res.attachment.id).toMatch(UUID_RE);
    expect(res.attachment.task_id).toBe(FIXTURE_TASK_ID);
    expect(res.attachment.filename).toBe('photo.jpg');
    expect(res.attachment.content_type).toBe('image/jpeg');
    expect(res.attachment.size_bytes).toBe(1024);
    expect(res.attachment.status).toBe('pending');
    expect(res.attachment.url).toBeNull();
    expect(res.attachment.created_by).toBe(FIXTURE_ACTOR_ID);
    expect(res.attachment.created_at).toMatch(ISO_DATETIME_RE);
    expect(res.upload_url).toBe(`/api/attachments/${res.attachment.id}/upload`);
  });

  it('createUpload throws AttachmentTaskNotFoundError for unknown task_id', async () => {
    const req = makeCreateReq({ task_id: uuidv7() });
    await expect(
      createUpload(db, storage, { req, actorId: FIXTURE_ACTOR_ID }),
    ).rejects.toThrow(AttachmentTaskNotFoundError);
  });

  it('createUpload is idempotent via operation_id', async () => {
    await seedFixtureTask();
    const req = makeCreateReq();
    const first = await createUpload(db, storage, { req, actorId: FIXTURE_ACTOR_ID });
    const second = await createUpload(db, storage, { req, actorId: FIXTURE_ACTOR_ID });
    expect(second.attachment.id).toBe(first.attachment.id);
    expect(second.upload_url).toBe(first.upload_url);
  });

  it('finalize transitions pending → ready when binary is present', async () => {
    await seedFixtureTask();
    const createReq = makeCreateReq();
    const { attachment } = await createUpload(db, storage, {
      req: createReq,
      actorId: FIXTURE_ACTOR_ID,
    });
    await storage.write(attachment.id, Buffer.from('fake-image-bytes'));

    const res = await finalize(db, storage, {
      req: { operation_id: uuidv7(), attachment_id: attachment.id },
      actorId: FIXTURE_ACTOR_ID,
    });
    expect(res.attachment.status).toBe('ready');
    expect(res.attachment.url).toBe(`/api/attachments/${attachment.id}/download`);
  });

  it('finalize throws AttachmentNotReadyError when binary is absent', async () => {
    await seedFixtureTask();
    const createReq = makeCreateReq();
    const { attachment } = await createUpload(db, storage, {
      req: createReq,
      actorId: FIXTURE_ACTOR_ID,
    });
    // Do NOT write the binary — storage slot is empty.
    await expect(
      finalize(db, storage, {
        req: { operation_id: uuidv7(), attachment_id: attachment.id },
        actorId: FIXTURE_ACTOR_ID,
      }),
    ).rejects.toThrow(AttachmentNotReadyError);
  });

  it('finalize is domain-idempotent for an already-ready attachment', async () => {
    await seedFixtureTask();
    const createReq = makeCreateReq();
    const { attachment } = await createUpload(db, storage, {
      req: createReq,
      actorId: FIXTURE_ACTOR_ID,
    });
    await storage.write(attachment.id, Buffer.from('bytes'));

    const op1 = uuidv7();
    const first = await finalize(db, storage, {
      req: { operation_id: op1, attachment_id: attachment.id },
      actorId: FIXTURE_ACTOR_ID,
    });
    expect(first.attachment.status).toBe('ready');

    // Same attachment, new operation_id — should return ready without error.
    const second = await finalize(db, storage, {
      req: { operation_id: uuidv7(), attachment_id: attachment.id },
      actorId: FIXTURE_ACTOR_ID,
    });
    expect(second.attachment.status).toBe('ready');
    expect(second.attachment.id).toBe(first.attachment.id);
  });

  it('finalize throws AttachmentNotFoundError for unknown attachment_id', async () => {
    await expect(
      finalize(db, storage, {
        req: { operation_id: uuidv7(), attachment_id: uuidv7() },
        actorId: FIXTURE_ACTOR_ID,
      }),
    ).rejects.toThrow(AttachmentNotFoundError);
  });

  it('getAttachment returns the attachment by id', async () => {
    await seedFixtureTask();
    const createReq = makeCreateReq();
    const { attachment } = await createUpload(db, storage, {
      req: createReq,
      actorId: FIXTURE_ACTOR_ID,
    });
    const res = await getAttachment(db, { req: { attachment_id: attachment.id } });
    expect(res.attachment.id).toBe(attachment.id);
    expect(res.attachment.status).toBe('pending');
  });

  it('getAttachment throws AttachmentNotFoundError for unknown id', async () => {
    await expect(
      getAttachment(db, { req: { attachment_id: uuidv7() } }),
    ).rejects.toThrow(AttachmentNotFoundError);
  });

  it('listAttachments returns empty array when no attachments exist', async () => {
    await seedFixtureTask();
    const res = await listAttachments(db, { req: { task_id: FIXTURE_TASK_ID } });
    expect(res.attachments).toEqual([]);
  });

  it('listAttachments excludes pending attachments', async () => {
    await seedFixtureTask();
    // Create a pending attachment (no binary upload, no finalize).
    await createUpload(db, storage, {
      req: makeCreateReq(),
      actorId: FIXTURE_ACTOR_ID,
    });
    const res = await listAttachments(db, { req: { task_id: FIXTURE_TASK_ID } });
    expect(res.attachments).toHaveLength(0);
  });

  it('listAttachments returns ready attachments ordered by created_at', async () => {
    await seedFixtureTask();
    const task2 = uuidv7();
    // Seed a second project + task so IDs don't clash with FIXTURE_PROJECT_ID.
    // Simpler: use FIXTURE_TASK_ID and create two attachments back-to-back.
    const r1 = await createUpload(db, storage, {
      req: makeCreateReq({ filename: 'a.jpg' }),
      actorId: FIXTURE_ACTOR_ID,
    });
    const r2 = await createUpload(db, storage, {
      req: makeCreateReq({ filename: 'b.jpg' }),
      actorId: FIXTURE_ACTOR_ID,
    });
    await storage.write(r1.attachment.id, Buffer.from('a'));
    await storage.write(r2.attachment.id, Buffer.from('b'));
    await finalize(db, storage, {
      req: { operation_id: uuidv7(), attachment_id: r1.attachment.id },
      actorId: FIXTURE_ACTOR_ID,
    });
    await finalize(db, storage, {
      req: { operation_id: uuidv7(), attachment_id: r2.attachment.id },
      actorId: FIXTURE_ACTOR_ID,
    });

    const res = await listAttachments(db, { req: { task_id: FIXTURE_TASK_ID } });
    expect(res.attachments).toHaveLength(2);
    expect(res.attachments[0]!.filename).toBe('a.jpg');
    expect(res.attachments[1]!.filename).toBe('b.jpg');
    // Both ready.
    expect(res.attachments.every((a) => a.status === 'ready')).toBe(true);
    void task2;
  });

  it('uploadBytes rejects with AttachmentAlreadyFinalizedError when row is locked by a concurrent upload', async () => {
    await seedFixtureTask();
    const { attachment } = await createUpload(db, storage, {
      req: makeCreateReq({ filename: 'locked.pdf' }),
      actorId: FIXTURE_ACTOR_ID,
    });

    // Simulate a concurrent upload in progress by holding a row lock.
    const lockAcquired = { resolve: () => {} };
    const lockAcquiredPromise = new Promise<void>((res) => {
      lockAcquired.resolve = res;
    });

    const lockHolder = db.transaction(async (tx) => {
      await tx
        .select({ id: attachments.id })
        .from(attachments)
        .where(eq(attachments.id, attachment.id))
        .for('update')
        .limit(1);
      lockAcquired.resolve();
      // Hold the lock long enough for the competing upload to try and fail.
      await new Promise<void>((r) => setTimeout(r, 300));
    }).catch(() => {});

    await lockAcquiredPromise;

    // uploadBytes must fail instantly (SKIP LOCKED) because the row is locked.
    await expect(
      uploadBytes(db, storage, { attachmentId: attachment.id, data: Buffer.from([1, 2, 3]) }),
    ).rejects.toBeInstanceOf(AttachmentAlreadyFinalizedError);

    await lockHolder;
  });
});

// ──────────────────────────────────────────────────────────────────────────
// C3-P2 — HTTP adapter
// ──────────────────────────────────────────────────────────────────────────

describe('attachment HTTP adapter (C3-P2)', () => {
  function bearer(body: unknown, method = 'POST'): RequestInit {
    return {
      method,
      headers: {
        authorization: `Bearer ${FIXTURE_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    };
  }

  function makeBody(overrides: Record<string, unknown> = {}) {
    return {
      operation_id: uuidv7(),
      task_id: FIXTURE_TASK_ID,
      filename: 'report.pdf',
      content_type: 'application/pdf',
      size_bytes: 2048,
      ...overrides,
    };
  }

  it('POST /api/attachments → 201 pending attachment', async () => {
    const app = buildTestApp();
    await seedFixtureTask();
    const resp = await app.fetch(
      new Request('http://test/api/attachments', bearer(makeBody())),
    );
    expect(resp.status).toBe(201);
    const json = (await resp.json()) as {
      attachment: Record<string, unknown>;
      upload_url: string;
    };
    expect(json.attachment.status).toBe('pending');
    expect(json.attachment.url).toBeNull();
    expect(json.attachment.task_id).toBe(FIXTURE_TASK_ID);
    expect(json.upload_url).toMatch(/^\/api\/attachments\/.+\/upload$/);
  });

  it('POST /api/attachments → 404 for unknown task_id', async () => {
    const app = buildTestApp();
    const resp = await app.fetch(
      new Request(
        'http://test/api/attachments',
        bearer(makeBody({ task_id: uuidv7() })),
      ),
    );
    expect(resp.status).toBe(404);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.error).toBe('task_not_found');
  });

  it('PUT /api/attachments/:id/upload → 204 stores binary', async () => {
    const app = buildTestApp();
    await seedFixtureTask();
    const createResp = await app.fetch(
      new Request('http://test/api/attachments', bearer(makeBody())),
    );
    const { attachment, upload_url } = (await createResp.json()) as {
      attachment: { id: string };
      upload_url: string;
    };

    const uploadResp = await app.fetch(
      new Request(`http://test${upload_url}`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${FIXTURE_TOKEN}`,
          'content-type': 'application/pdf',
        },
        body: new Uint8Array([0x25, 0x50, 0x44, 0x46]), // PDF magic bytes
      }),
    );
    expect(uploadResp.status).toBe(204);
    expect(attachment.id).toMatch(UUID_RE);
  });

  it('POST /api/attachments/:id/finalize → 200 ready attachment', async () => {
    const app = buildTestApp();
    await seedFixtureTask();
    const createResp = await app.fetch(
      new Request('http://test/api/attachments', bearer(makeBody())),
    );
    const { attachment, upload_url } = (await createResp.json()) as {
      attachment: { id: string };
      upload_url: string;
    };

    await app.fetch(
      new Request(`http://test${upload_url}`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${FIXTURE_TOKEN}`,
          'content-type': 'application/pdf',
        },
        body: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      }),
    );

    const finalizeResp = await app.fetch(
      new Request(
        `http://test/api/attachments/${attachment.id}/finalize`,
        bearer({ operation_id: uuidv7() }),
      ),
    );
    expect(finalizeResp.status).toBe(200);
    const json = (await finalizeResp.json()) as {
      attachment: Record<string, unknown>;
    };
    expect(json.attachment.status).toBe('ready');
    expect(json.attachment.url).toBe(`/api/attachments/${attachment.id}/download`);
  });

  it('POST /api/attachments/:id/finalize → 409 when binary absent', async () => {
    const app = buildTestApp();
    await seedFixtureTask();
    const createResp = await app.fetch(
      new Request('http://test/api/attachments', bearer(makeBody())),
    );
    const { attachment } = (await createResp.json()) as {
      attachment: { id: string };
    };

    const finalizeResp = await app.fetch(
      new Request(
        `http://test/api/attachments/${attachment.id}/finalize`,
        bearer({ operation_id: uuidv7() }),
      ),
    );
    expect(finalizeResp.status).toBe(409);
    const json = (await finalizeResp.json()) as Record<string, unknown>;
    expect(json.error).toBe('binary_not_uploaded');
  });

  it('GET /api/attachments/:id → 200 returns attachment', async () => {
    const app = buildTestApp();
    await seedFixtureTask();
    const createResp = await app.fetch(
      new Request('http://test/api/attachments', bearer(makeBody())),
    );
    const { attachment } = (await createResp.json()) as {
      attachment: { id: string };
    };

    const getResp = await app.fetch(
      new Request(`http://test/api/attachments/${attachment.id}`, {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(getResp.status).toBe(200);
    const json = (await getResp.json()) as {
      attachment: Record<string, unknown>;
    };
    expect(json.attachment.id).toBe(attachment.id);
    expect(json.attachment.status).toBe('pending');
  });

  it('GET /api/attachments/:id → 404 for unknown id', async () => {
    const app = buildTestApp();
    const getResp = await app.fetch(
      new Request(`http://test/api/attachments/${uuidv7()}`, {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(getResp.status).toBe(404);
    const json = (await getResp.json()) as Record<string, unknown>;
    expect(json.error).toBe('not_found');
  });

  it('GET /api/tasks/:id/attachments → 200 returns empty list initially', async () => {
    const app = buildTestApp();
    await seedFixtureTask();
    const resp = await app.fetch(
      new Request(`http://test/api/tasks/${FIXTURE_TASK_ID}/attachments`, {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { attachments: unknown[] };
    expect(json.attachments).toEqual([]);
  });

  it('GET /api/tasks/:id/attachments → 200 returns ready attachments only', async () => {
    const app = buildTestApp();
    await seedFixtureTask();

    // Create + upload + finalize one attachment.
    const createResp = await app.fetch(
      new Request('http://test/api/attachments', bearer(makeBody())),
    );
    const { attachment, upload_url } = (await createResp.json()) as {
      attachment: { id: string };
      upload_url: string;
    };
    await app.fetch(
      new Request(`http://test${upload_url}`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${FIXTURE_TOKEN}`,
          'content-type': 'application/pdf',
        },
        body: new Uint8Array([0x25]),
      }),
    );
    await app.fetch(
      new Request(
        `http://test/api/attachments/${attachment.id}/finalize`,
        bearer({ operation_id: uuidv7() }),
      ),
    );

    // Create a second pending attachment (not finalized).
    await app.fetch(
      new Request('http://test/api/attachments', bearer(makeBody({ filename: 'pending.txt' }))),
    );

    const listResp = await app.fetch(
      new Request(`http://test/api/tasks/${FIXTURE_TASK_ID}/attachments`, {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(listResp.status).toBe(200);
    const json = (await listResp.json()) as { attachments: Array<Record<string, unknown>> };
    expect(json.attachments).toHaveLength(1);
    expect(json.attachments[0]!.status).toBe('ready');
    expect(json.attachments[0]!.id).toBe(attachment.id);
  });

  it('GET /api/tasks/:id/attachments?limit=1 → returns at most 1 attachment', async () => {
    const app = buildTestApp();
    await seedFixtureTask();

    for (const filename of ['a.pdf', 'b.pdf']) {
      const createResp = await app.fetch(
        new Request('http://test/api/attachments', bearer(makeBody({ filename }))),
      );
      const { attachment, upload_url } = (await createResp.json()) as {
        attachment: { id: string };
        upload_url: string;
      };
      await app.fetch(
        new Request(`http://test${upload_url}`, {
          method: 'PUT',
          headers: { authorization: `Bearer ${FIXTURE_TOKEN}`, 'content-type': 'application/pdf' },
          body: new Uint8Array([0x25]),
        }),
      );
      await app.fetch(
        new Request(
          `http://test/api/attachments/${attachment.id}/finalize`,
          bearer({ operation_id: uuidv7() }),
        ),
      );
    }

    const resp = await app.fetch(
      new Request(`http://test/api/tasks/${FIXTURE_TASK_ID}/attachments?limit=1`, {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { attachments: unknown[] };
    expect(json.attachments).toHaveLength(1);
  });

  it('GET /api/tasks/:id/attachments?limit=0 → 400 validation_error', async () => {
    const app = buildTestApp();
    await seedFixtureTask();
    const resp = await app.fetch(
      new Request(`http://test/api/tasks/${FIXTURE_TASK_ID}/attachments?limit=0`, {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(resp.status).toBe(400);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.error).toBe('validation_error');
  });

  it('GET /api/tasks/:id/attachments → 404 for unknown task_id', async () => {
    const app = buildTestApp();
    const resp = await app.fetch(
      new Request(`http://test/api/tasks/${uuidv7()}/attachments`, {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(resp.status).toBe(404);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.error).toBe('task_not_found');
  });

  it('PUT /api/attachments/:id/upload → 409 when attachment already finalized', async () => {
    const app = buildTestApp();
    await seedFixtureTask();

    const createResp = await app.fetch(
      new Request('http://test/api/attachments', bearer(makeBody())),
    );
    const { attachment, upload_url } = (await createResp.json()) as {
      attachment: { id: string };
      upload_url: string;
    };

    await app.fetch(
      new Request(`http://test${upload_url}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}`, 'content-type': 'application/pdf' },
        body: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      }),
    );
    await app.fetch(
      new Request(
        `http://test/api/attachments/${attachment.id}/finalize`,
        bearer({ operation_id: uuidv7() }),
      ),
    );

    const retryUpload = await app.fetch(
      new Request(`http://test${upload_url}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}`, 'content-type': 'application/pdf' },
        body: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      }),
    );
    expect(retryUpload.status).toBe(409);
    const json = (await retryUpload.json()) as Record<string, unknown>;
    expect(json.error).toBe('attachment_already_finalized');
  });

  it('GET /api/attachments/:id/download → 200 streams binary for ready attachment', async () => {
    const app = buildTestApp();
    await seedFixtureTask();

    const createResp = await app.fetch(
      new Request('http://test/api/attachments', bearer(makeBody())),
    );
    const { attachment, upload_url } = (await createResp.json()) as {
      attachment: { id: string; content_type: string };
      upload_url: string;
    };

    const payload = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    await app.fetch(
      new Request(`http://test${upload_url}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}`, 'content-type': 'application/pdf' },
        body: payload,
      }),
    );
    await app.fetch(
      new Request(
        `http://test/api/attachments/${attachment.id}/finalize`,
        bearer({ operation_id: uuidv7() }),
      ),
    );

    const dlResp = await app.fetch(
      new Request(`http://test/api/attachments/${attachment.id}/download`, {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(dlResp.status).toBe(200);
    expect(dlResp.headers.get('content-type')).toBe('application/pdf');
    const body = new Uint8Array(await dlResp.arrayBuffer());
    expect(body).toEqual(payload);
  });

  it('GET /api/attachments/:id/download → 409 when attachment is still pending', async () => {
    const app = buildTestApp();
    await seedFixtureTask();

    const createResp = await app.fetch(
      new Request('http://test/api/attachments', bearer(makeBody())),
    );
    const { attachment } = (await createResp.json()) as { attachment: { id: string } };

    const dlResp = await app.fetch(
      new Request(`http://test/api/attachments/${attachment.id}/download`, {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(dlResp.status).toBe(409);
    const json = (await dlResp.json()) as Record<string, unknown>;
    expect(json.error).toBe('binary_not_uploaded');
  });

  it('PUT /api/attachments/:id/upload → 409 attachment_already_finalized when slot is locked by concurrent upload', async () => {
    const app = buildTestApp();
    await seedFixtureTask();

    const createResp = await app.fetch(
      new Request('http://test/api/attachments', bearer(makeBody())),
    );
    const { attachment, upload_url } = (await createResp.json()) as {
      attachment: { id: string };
      upload_url: string;
    };

    // Hold the row lock to simulate a concurrent upload in progress.
    const lockAcquired = { resolve: () => {} };
    const lockAcquiredPromise = new Promise<void>((res) => {
      lockAcquired.resolve = res;
    });
    const lockHolder = db.transaction(async (tx) => {
      await tx
        .select({ id: attachments.id })
        .from(attachments)
        .where(eq(attachments.id, attachment.id))
        .for('update')
        .limit(1);
      lockAcquired.resolve();
      await new Promise<void>((r) => setTimeout(r, 300));
    }).catch(() => {});

    await lockAcquiredPromise;

    const uploadResp = await app.fetch(
      new Request(`http://test${upload_url}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}`, 'content-type': 'application/pdf' },
        body: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      }),
    );

    expect(uploadResp.status).toBe(409);
    const body = (await uploadResp.json()) as Record<string, unknown>;
    expect(body.error).toBe('attachment_already_finalized');
    expect(body.attachment_id).toBe(attachment.id);

    await lockHolder;
  });
});
