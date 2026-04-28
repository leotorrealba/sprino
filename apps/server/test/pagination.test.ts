// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Phase 6B — pagination + resource limits.
 *
 * Each list endpoint declares a hard cap (events ≤1000, tasks ≤500,
 * agents ≤100) and a default of 50 (DEFAULT_LIMIT). Exceeding the cap
 * is a 400 validation_error, not a silent clamp — so client bugs surface
 * instead of returning unexpectedly truncated results.
 *
 * These tests exercise the contract at the HTTP boundary because that's
 * where the Zod schemas are enforced and where 400-mapping happens. Pure
 * service-level unit tests for an `Math.min` clamp would prove nothing.
 */

import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it } from 'vitest';
import {
  FIXTURE_ACTOR_ID,
  FIXTURE_PROJECT_ID,
  FIXTURE_TOKEN,
  buildTestApp,
} from './setup.ts';
import { createTask } from '../src/service/tasks.ts';
import { db } from '../src/db/client.ts';

function bearer(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: {
      authorization: `Bearer ${FIXTURE_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

function authGet(path: string): Request {
  return new Request(`http://t${path}`, {
    headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
  });
}

describe('Phase 6B — events.list pagination contract', () => {
  it('rejects limit > 1000 with 400 validation_error', async () => {
    const app = buildTestApp();
    const res = await app.fetch(
      authGet(`/api/events?project_id=${FIXTURE_PROJECT_ID}&limit=1001`),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });

  it('accepts limit at the boundary (1000) and (1)', async () => {
    const app = buildTestApp();
    const r1 = await app.fetch(
      authGet(`/api/events?project_id=${FIXTURE_PROJECT_ID}&limit=1000`),
    );
    expect(r1.status).toBe(200);
    const r2 = await app.fetch(
      authGet(`/api/events?project_id=${FIXTURE_PROJECT_ID}&limit=1`),
    );
    expect(r2.status).toBe(200);
  });

  it('rejects malformed limit (non-numeric) with 400', async () => {
    const app = buildTestApp();
    const res = await app.fetch(
      authGet(`/api/events?project_id=${FIXTURE_PROJECT_ID}&limit=abc`),
    );
    expect(res.status).toBe(400);
  });

  it('rejects negative offset with 400', async () => {
    const app = buildTestApp();
    const res = await app.fetch(
      authGet(`/api/events?project_id=${FIXTURE_PROJECT_ID}&offset=-1`),
    );
    expect(res.status).toBe(400);
  });
});

describe('Phase 6B — tasks.list pagination contract', () => {
  async function seedTasks(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await createTask(db, {
        req: {
          operation_id: uuidv7(),
          project_id: FIXTURE_PROJECT_ID,
          title: `pagination task ${i}`,
        },
        actorId: FIXTURE_ACTOR_ID,
      });
    }
  }

  it('rejects limit > 500 with 400 validation_error', async () => {
    const app = buildTestApp();
    const res = await app.fetch(
      authGet(`/api/tasks?project_id=${FIXTURE_PROJECT_ID}&limit=501`),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });

  it('accepts limit at the boundary (500)', async () => {
    const app = buildTestApp();
    const res = await app.fetch(
      authGet(`/api/tasks?project_id=${FIXTURE_PROJECT_ID}&limit=500`),
    );
    expect(res.status).toBe(200);
  });

  it('default limit = 50 (DEFAULT_LIMIT) when not provided', async () => {
    const app = buildTestApp();
    await seedTasks(55);
    const res = await app.fetch(
      authGet(`/api/tasks?project_id=${FIXTURE_PROJECT_ID}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: unknown[] };
    expect(body.tasks).toHaveLength(50);
  });

  it('offset paginates across the full set', async () => {
    const app = buildTestApp();
    await seedTasks(7);
    const r1 = await app.fetch(
      authGet(`/api/tasks?project_id=${FIXTURE_PROJECT_ID}&limit=3&offset=0`),
    );
    const r2 = await app.fetch(
      authGet(`/api/tasks?project_id=${FIXTURE_PROJECT_ID}&limit=3&offset=3`),
    );
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = (await r1.json()) as { tasks: { id: string }[] };
    const b2 = (await r2.json()) as { tasks: { id: string }[] };
    expect(b1.tasks).toHaveLength(3);
    expect(b2.tasks).toHaveLength(3);
    // Disjoint pages — no shared ids.
    const ids1 = new Set(b1.tasks.map((t) => t.id));
    for (const t of b2.tasks) expect(ids1.has(t.id)).toBe(false);
  });
});

describe('Phase 6B — agents.list', () => {
  it('rejects limit > 100 with 400 validation_error', async () => {
    const app = buildTestApp();
    const res = await app.fetch(authGet(`/api/agents?limit=101`));
    expect(res.status).toBe(400);
  });

  it('accepts limit at the boundary (100)', async () => {
    const app = buildTestApp();
    const res = await app.fetch(authGet(`/api/agents?limit=100`));
    expect(res.status).toBe(200);
  });

  it('returns only kind=agent entries from the registry, no tokens', async () => {
    const app = buildTestApp();
    const res = await app.fetch(authGet(`/api/agents`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agents: Array<Record<string, unknown>>;
    };
    expect(body.agents.length).toBeGreaterThanOrEqual(1);
    for (const a of body.agents) {
      expect(a.kind).toBe('agent');
      expect(a.token).toBeUndefined();
      expect(a.id).toBeDefined();
      expect(a.display_name).toBeDefined();
    }
  });

  it('requires authentication (401 without bearer token)', async () => {
    const app = buildTestApp();
    const res = await app.fetch(new Request('http://t/api/agents'));
    expect(res.status).toBe(401);
  });
});
