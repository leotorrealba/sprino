/**
 * Stream 4A: agent_context truncation + pagination endpoint tests.
 *
 *  Cap is 32KB (32768 bytes) on JSON-stringified agent_context. Beyond
 *  that we shed events oldest-first then related_tasks, set
 *  truncated=true, and emit opaque next_page_tokens that the new
 *  `/api/tasks/:id/events` and `/api/tasks/:id/related_tasks`
 *  endpoints accept (well — they accept `offset`, the token decodes
 *  to that). The contract: clients can keep walking the tail without
 *  re-parsing schema-private state.
 */

import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db/client.ts';
import {
  createTask,
  decodePageToken,
  updateTaskStatus,
} from '../src/service/tasks.ts';
import {
  FIXTURE_ACTOR_ID,
  FIXTURE_PROJECT_ID,
  FIXTURE_TOKEN,
  buildTestApp,
} from './setup.ts';

async function getJson<T>(
  app: ReturnType<typeof buildTestApp>,
  path: string,
): Promise<T> {
  const res = await app.fetch(
    new Request(`http://test${path}`, {
      headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
    }),
  );
  return (await res.json()) as T;
}

async function seedTaskWithManyEvents(
  count: number,
): Promise<{ taskId: string }> {
  const created = await createTask(db, {
    req: {
      operation_id: uuidv7(),
      project_id: FIXTURE_PROJECT_ID,
      title: 'pagination target',
      description: 'x'.repeat(200),
    },
    actorId: FIXTURE_ACTOR_ID,
  });
  const taskId = created.task.id;

  // Drive `count` status_changed events. Each requires a fresh if_match
  // because version increments on every successful update.
  let version = created.task.version;
  for (let i = 0; i < count; i++) {
    const next = i % 2 === 0 ? 'doing' : 'todo';
    const res = await updateTaskStatus(db, {
      req: {
        operation_id: uuidv7(),
        task_id: taskId,
        status: next,
        if_match: version,
        notes: `update #${i + 1} — ${'noise '.repeat(20)}`,
      },
      actorId: FIXTURE_ACTOR_ID,
    });
    version = res.task.version;
  }
  return { taskId };
}

describe('agent_context: small task fits without truncation', () => {
  it('returns truncated=false and no next_page_tokens for a tiny task', async () => {
    const created = await createTask(db, {
      req: {
        operation_id: uuidv7(),
        project_id: FIXTURE_PROJECT_ID,
        title: 'tiny',
      },
      actorId: FIXTURE_ACTOR_ID,
    });

    const app = buildTestApp();
    const res = await app.fetch(
      new Request(`http://test/api/tasks/${created.task.id}`, {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agent_context: {
        truncated: boolean;
        next_page_tokens?: { recent_events?: string | null };
      };
    };
    expect(body.agent_context.truncated).toBe(false);
    expect(body.agent_context.next_page_tokens).toBeUndefined();
  });
});

describe('agent_context: large event log triggers truncation', () => {
  it('caps payload at 32KB, sets truncated=true, emits a usable recent_events token', async () => {
    // 20 events × ~250 bytes each in JSON ≈ 5KB — fits easily.
    // The cap matters when an individual event has heavy notes. Bloat
    // notes with deterministic noise to push us past 32KB.
    const created = await createTask(db, {
      req: {
        operation_id: uuidv7(),
        project_id: FIXTURE_PROJECT_ID,
        title: 'bloat target',
      },
      actorId: FIXTURE_ACTOR_ID,
    });
    const taskId = created.task.id;
    let version = created.task.version;

    // Each note ≈ 2KB — 20 events × 2KB = 40KB raw, so truncation must kick in.
    const heavy = 'lorem ipsum '.repeat(200);
    for (let i = 0; i < 20; i++) {
      const res = await updateTaskStatus(db, {
        req: {
          operation_id: uuidv7(),
          task_id: taskId,
          status: i % 2 === 0 ? 'doing' : 'todo',
          if_match: version,
          notes: heavy,
        },
        actorId: FIXTURE_ACTOR_ID,
      });
      version = res.task.version;
    }

    const app = buildTestApp();
    const res = await app.fetch(
      new Request(`http://test/api/tasks/${taskId}`, {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agent_context: {
        recent_events: unknown[];
        truncated: boolean;
        next_page_tokens?: {
          recent_events?: string | null;
          related_tasks?: string | null;
        };
      };
    };

    expect(body.agent_context.truncated).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(body.agent_context), 'utf8'),
    ).toBeLessThanOrEqual(32 * 1024);
    expect(body.agent_context.recent_events.length).toBeGreaterThan(0);
    // token present and decodes to a positive offset
    const token = body.agent_context.next_page_tokens?.recent_events;
    expect(token).toBeTruthy();
    const decoded = decodePageToken(token as string);
    expect(decoded).not.toBeNull();
    expect(decoded!.offset).toBeGreaterThan(0);
  });
});

describe('GET /api/tasks/:id/events: pagination', () => {
  it('returns events newest-first with limit and a next_page_token chain that terminates', async () => {
    const { taskId } = await seedTaskWithManyEvents(15);
    const app = buildTestApp();

    type Page = {
      events: Array<{ id: string; kind: string }>;
      next_page_token: string | null;
    };

    const page1 = await getJson<Page>(
      app,
      `/api/tasks/${taskId}/events?limit=5&offset=0`,
    );
    expect(page1.events.length).toBe(5);
    expect(page1.next_page_token).not.toBeNull();
    expect(decodePageToken(page1.next_page_token!)?.offset).toBe(5);

    const page2 = await getJson<Page>(
      app,
      `/api/tasks/${taskId}/events?limit=5&offset=5`,
    );
    expect(page2.events.length).toBe(5);

    // Total events = 1 created + 15 status_changed = 16. After 10 we
    // expect 6 left on a 5-page request → next_page_token still set.
    const page3 = await getJson<Page>(
      app,
      `/api/tasks/${taskId}/events?limit=5&offset=10`,
    );
    expect(page3.events.length).toBe(5);
    expect(decodePageToken(page3.next_page_token!)?.offset).toBe(15);

    const page4 = await getJson<Page>(
      app,
      `/api/tasks/${taskId}/events?limit=5&offset=15`,
    );
    expect(page4.events.length).toBe(1);
    expect(page4.next_page_token).toBeNull();

    // Pages must not overlap.
    const ids = new Set([
      ...page1.events.map((e: { id: string }) => e.id),
      ...page2.events.map((e: { id: string }) => e.id),
      ...page3.events.map((e: { id: string }) => e.id),
      ...page4.events.map((e: { id: string }) => e.id),
    ]);
    expect(ids.size).toBe(16);
  });

  it('returns an empty page (no token) when offset is past the end', async () => {
    const { taskId } = await seedTaskWithManyEvents(2);
    const app = buildTestApp();
    const res = await getJson<{
      events: unknown[];
      next_page_token: string | null;
    }>(app, `/api/tasks/${taskId}/events?limit=10&offset=999`);
    expect(res.events).toEqual([]);
    expect(res.next_page_token).toBeNull();
  });
});

describe('GET /api/tasks/:id/related_tasks: stub returns empty', () => {
  it('returns empty list and null token (related-tasks discovery is Week 5+)', async () => {
    const created = await createTask(db, {
      req: {
        operation_id: uuidv7(),
        project_id: FIXTURE_PROJECT_ID,
        title: 'rel',
      },
      actorId: FIXTURE_ACTOR_ID,
    });
    const app = buildTestApp();
    const res = await getJson<{
      tasks: unknown[];
      next_page_token: string | null;
    }>(
      app,
      `/api/tasks/${created.task.id}/related_tasks?limit=10&offset=0`,
    );
    expect(res.tasks).toEqual([]);
    expect(res.next_page_token).toBeNull();
  });
});

describe('decodePageToken: malformed input', () => {
  it('returns null for non-base64, non-JSON, or wrong-shape tokens', () => {
    expect(decodePageToken('!!!not-base64!!!')).toBeNull();
    expect(decodePageToken(Buffer.from('plain text').toString('base64url'))).toBeNull();
    expect(
      decodePageToken(Buffer.from(JSON.stringify({ x: 1 })).toString('base64url')),
    ).toBeNull();
    expect(
      decodePageToken(Buffer.from(JSON.stringify({ o: -3 })).toString('base64url')),
    ).toBeNull();
  });
});
