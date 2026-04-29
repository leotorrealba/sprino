// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Tessera v0.0.2 conformance: runs the canonical request/response fixtures
 * from `../tessera/conformance/fixtures/` against the actual server.
 *
 * The fixtures form a sequence: create → get → update_status. Each later
 * step assumes the prior state. Run-order matters; this whole verb chain
 * lives in a single `it` block.
 *
 * Fixture matching rules (from tessera/conformance/README.md):
 *   - Timestamps may differ; assert ISO-8601 and correct ordering.
 *   - event.id may differ; assert UUID and uniqueness.
 *   - All other fields including task.id MUST match exactly *across*
 *     responses in the sequence — captured from create and substituted
 *     into expected fixtures for subsequent steps.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db/client.ts';
import { projects } from '../src/db/schema.ts';
import { ActorRegisterReqSchema } from '../src/domain/index.ts';
import { transitionAgentLifecycle } from '../src/service/actors.ts';
import {
  FIXTURE_ACTOR_ID,
  FIXTURE_AGENT_ID,
  FIXTURE_AGENT_TOKEN,
  FIXTURE_PROJECT_ID,
  FIXTURE_TOKEN,
  buildTestApp,
  seedDbActor,
} from './setup.ts';

const FIXTURE_DIR = path.resolve(
  import.meta.dirname,
  '../../../../tessera/conformance/fixtures',
);

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECOND_PROJECT_ID = '018c3e7a-0002-7000-8000-000000000002';
const SECOND_PROJECT_REPO = '/Users/leotorrealba/Development/tessera';
const INTERNAL_AGENT_LIFECYCLE_FIELDS = [
  'lifecycle_state',
  'lifecycleState',
  'last_heartbeat_at',
  'lastHeartbeatAt',
  'deactivated_at',
  'deactivatedAt',
];

function bearer(body: unknown, method = 'POST'): RequestInit {
  return {
    method,
    headers: {
      authorization: `Bearer ${FIXTURE_TOKEN}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function bearerForToken(
  token: string,
  body: unknown,
  method = 'POST',
): RequestInit {
  return {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function expectNoAgentLifecycleFields(record: Record<string, unknown>): void {
  for (const field of INTERNAL_AGENT_LIFECYCLE_FIELDS) {
    expect(record).not.toHaveProperty(field);
  }
}

describe('Tessera v0.0.2 conformance — task happy path sequence', () => {
  it('runs create → get → update_status against the canonical fixtures', async () => {
    const app = buildTestApp();

    // ── step 1: task.create ─────────────────────────────────────────────
    const createReq = readFixture('task-create-happy.req.json') as Record<
      string,
      unknown
    >;
    const expectedCreate = readFixture(
      'task-create-happy.res.json',
    ) as Record<string, unknown>;

    const createResp = await app.fetch(
      new Request('http://test/api/tasks', bearer(createReq)),
    );
    expect(createResp.status).toBe(201);
    const createJson = (await createResp.json()) as {
      task: Record<string, unknown>;
      event: Record<string, unknown>;
      agent_context: Record<string, unknown>;
    };

    const expTask = expectedCreate.task as Record<string, unknown>;
    expect(createJson.task.title).toBe(expTask.title);
    expect(createJson.task.description).toBe(expTask.description);
    expect(createJson.task.status).toBe('todo');
    expect(createJson.task.assignee_id).toBe(null);
    expect(createJson.task.project_id).toBe(FIXTURE_PROJECT_ID);
    expect(createJson.task.created_by).toBe(FIXTURE_ACTOR_ID);
    expect(createJson.task.version).toBe(1);
    expect(createJson.task.id).toMatch(UUID_RE);
    expect(createJson.task.created_at).toMatch(ISO_DATETIME_RE);
    expect(createJson.task.updated_at).toMatch(ISO_DATETIME_RE);

    expect(createJson.event.kind).toBe('created');
    expect(createJson.event.actor_id).toBe(FIXTURE_ACTOR_ID);
    expect(createJson.event.task_id).toBe(createJson.task.id);
    expect(createJson.event.operation_id).toBe(createReq.operation_id);
    expect(createJson.event.payload).toEqual({
      title: createReq.title,
      status: 'todo',
    });
    expect(createJson.event.id).toMatch(UUID_RE);

    expect(createJson.agent_context.related_tasks).toEqual([]);
    expect(createJson.agent_context.repo_refs).toEqual([]);
    expect(createJson.agent_context.truncated).toBe(false);

    const taskId = createJson.task.id as string;

    // ── step 2: task.get ────────────────────────────────────────────────
    const expectedGet = readFixture('task-get-happy.res.json') as Record<
      string,
      unknown
    >;
    const getResp = await app.fetch(
      new Request(`http://test/api/tasks/${taskId}`, {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(getResp.status).toBe(200);
    const getJson = (await getResp.json()) as {
      task: Record<string, unknown>;
      agent_context: { recent_events: Array<Record<string, unknown>> };
    };

    expect(getJson.task.id).toBe(taskId);
    expect(getJson.task.version).toBe(1);
    expect(getJson.task.status).toBe('todo');
    expect(getJson.task.title).toBe(
      (expectedGet.task as Record<string, unknown>).title,
    );

    expect(getJson.agent_context.recent_events).toHaveLength(1);
    const recent = getJson.agent_context.recent_events[0]!;
    expect(recent.kind).toBe('created');
    expect(recent.task_id).toBe(taskId);

    // ── step 3: task.update_status ──────────────────────────────────────
    const updateReq: Record<string, unknown> = {
      ...(readFixture('task-update-status-happy.req.json') as Record<
        string,
        unknown
      >),
      task_id: taskId,
    };
    const updateResp = await app.fetch(
      new Request(
        `http://test/api/tasks/${taskId}/status`,
        bearer(updateReq, 'PATCH'),
      ),
    );
    expect(updateResp.status).toBe(200);
    const updateJson = (await updateResp.json()) as {
      task: Record<string, unknown>;
      event: Record<string, unknown>;
    };

    expect(updateJson.task.id).toBe(taskId);
    expect(updateJson.task.version).toBe(2);
    expect(updateJson.task.status).toBe('done');
    expect(updateJson.event.kind).toBe('status_changed');
    expect(updateJson.event.payload).toEqual({ from: 'todo', to: 'done' });
    expect(updateJson.event.task_id).toBe(taskId);
    expect(updateJson.event.operation_id).toBe(updateReq.operation_id);

    const createdAt = new Date(createJson.task.created_at as string).getTime();
    const updatedAt = new Date(updateJson.task.updated_at as string).getTime();
    expect(updatedAt).toBeGreaterThanOrEqual(createdAt);
  });

  it('idempotent retry of task.create returns the cached response and writes no new event', async () => {
    const app = buildTestApp();
    const req = readFixture('task-create-happy.req.json');

    const first = await app.fetch(
      new Request('http://test/api/tasks', bearer(req)),
    );
    expect(first.status).toBe(201);
    const firstJson = (await first.json()) as {
      task: { id: string };
      event: { id: string };
    };

    const second = await app.fetch(
      new Request('http://test/api/tasks', bearer(req)),
    );
    expect(second.status).toBe(201);
    const secondJson = (await second.json()) as {
      task: { id: string };
      event: { id: string };
    };

    expect(secondJson.task.id).toBe(firstJson.task.id);
    expect(secondJson.event.id).toBe(firstJson.event.id);

    // Verify only ONE event landed by reading via task.get.
    const getResp = await app.fetch(
      new Request(`http://test/api/tasks/${firstJson.task.id}`, {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    const getJson = (await getResp.json()) as {
      agent_context: { recent_events: unknown[] };
    };
    expect(getJson.agent_context.recent_events).toHaveLength(1);
  });

  it('concurrent task.create retries return one cached mutation', async () => {
    const app = buildTestApp();
    const req = readFixture('task-create-happy.req.json');

    const [first, second] = await Promise.all([
      app.fetch(new Request('http://test/api/tasks', bearer(req))),
      app.fetch(new Request('http://test/api/tasks', bearer(req))),
    ]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const firstJson = (await first.json()) as {
      task: { id: string };
      event: { id: string };
    };
    const secondJson = (await second.json()) as {
      task: { id: string };
      event: { id: string };
    };

    expect(secondJson.task.id).toBe(firstJson.task.id);
    expect(secondJson.event.id).toBe(firstJson.event.id);

    const getResp = await app.fetch(
      new Request(`http://test/api/tasks/${firstJson.task.id}`, {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    const getJson = (await getResp.json()) as {
      agent_context: { recent_events: unknown[] };
    };
    expect(getJson.agent_context.recent_events).toHaveLength(1);
  });

  it('reused operation_id with a different payload returns 409 with cached body', async () => {
    const app = buildTestApp();
    const req = readFixture('task-create-happy.req.json') as Record<
      string,
      unknown
    >;

    await app.fetch(new Request('http://test/api/tasks', bearer(req)));

    const conflicting = { ...req, title: 'A different title' };
    const resp = await app.fetch(
      new Request('http://test/api/tasks', bearer(conflicting)),
    );
    expect(resp.status).toBe(409);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.error).toBe('operation_id_conflict');
    expect(body.cached_response).toBeDefined();
  });

  it('stale if_match on update_status returns 409 with current task state', async () => {
    const app = buildTestApp();
    const createReq = readFixture('task-create-happy.req.json');

    const created = await app.fetch(
      new Request('http://test/api/tasks', bearer(createReq)),
    );
    const createdJson = (await created.json()) as { task: { id: string } };
    const taskId = createdJson.task.id;

    // First update bumps to version=2.
    const upd1 = {
      ...(readFixture('task-update-status-happy.req.json') as Record<
        string,
        unknown
      >),
      task_id: taskId,
    };
    const r1 = await app.fetch(
      new Request(
        `http://test/api/tasks/${taskId}/status`,
        bearer(upd1, 'PATCH'),
      ),
    );
    expect(r1.status).toBe(200);

    // Second update with stale if_match=1 must 409.
    const upd2 = {
      ...upd1,
      operation_id: '018c3e7a-0005-7000-8000-000000000099',
      status: 'doing',
      if_match: 1,
    };
    const r2 = await app.fetch(
      new Request(
        `http://test/api/tasks/${taskId}/status`,
        bearer(upd2, 'PATCH'),
      ),
    );
    expect(r2.status).toBe(409);
    const body = (await r2.json()) as {
      error: string;
      task: { version: number; status: string };
    };
    expect(body.error).toBe('version_mismatch');
    expect(body.task.version).toBe(2);
    expect(body.task.status).toBe('done');
  });
});

describe('MCP-over-HTTP adapter — same business logic, JSON-RPC envelope', () => {
  it('tools/list returns the Tessera task verbs and week 2 project verbs', async () => {
    const app = buildTestApp();
    const resp = await app.fetch(
      new Request(
        'http://test/mcp',
        bearer({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      ),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      jsonrpc: string;
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools.map((t) => t.name).sort()).toEqual([
      'sprino.actor.get',
      'sprino.actor.list',
      'sprino.actor.register',
      'sprino.actor.revoke_token',
      'sprino.project.get',
      'sprino.project.list',
      'sprino.task.create',
      'sprino.task.get',
      'sprino.task.update_status',
    ]);
  });

  it('tools/call sprino.task.create produces an identical task to the REST adapter', async () => {
    const app = buildTestApp();
    const req = readFixture('task-create-happy.req.json');

    const resp = await app.fetch(
      new Request(
        'http://test/mcp',
        bearer({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'sprino.task.create', arguments: req },
        }),
      ),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      result: {
        structuredContent: {
          task: { title: string; status: string; version: number };
          event: { kind: string };
        };
      };
    };
    const sc = body.result.structuredContent;
    expect(sc.task.title).toBe((req as Record<string, unknown>).title);
    expect(sc.task.status).toBe('todo');
    expect(sc.task.version).toBe(1);
    expect(sc.event.kind).toBe('created');
  });
});

describe('Tessera v0.0.2 project scoping', () => {
  async function seedSecondProject(): Promise<void> {
    await db.insert(projects).values({
      id: SECOND_PROJECT_ID,
      slug: 'tessera',
      displayName: 'Tessera',
      repoPath: SECOND_PROJECT_REPO,
    });
  }

  it('GET /api/projects lists available projects in stable slug order', async () => {
    const app = buildTestApp();
    await seedSecondProject();

    const resp = await app.fetch(
      new Request('http://test/api/projects', {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      projects: Array<{ id: string; slug: string; display_name: string }>;
    };
    expect(body.projects.map((p) => p.slug)).toEqual(['sprino', 'tessera']);
    expect(body.projects).toContainEqual(
      expect.objectContaining({
        id: SECOND_PROJECT_ID,
        slug: 'tessera',
        display_name: 'Tessera',
      }),
    );
  });

  it('GET /api/tasks rejects malformed limit query values with 400', async () => {
    const app = buildTestApp();
    const createReq = readFixture('task-create-happy.req.json');

    await app.fetch(new Request('http://test/api/tasks', bearer(createReq)));

    const resp = await app.fetch(
      new Request(
        `http://test/api/tasks?project_id=${FIXTURE_PROJECT_ID}&limit=foo`,
        {
          headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
        },
      ),
    );

    // Phase 6: silent clamping was replaced by a hard 400 so client bugs
    // surface instead of returning unexpectedly truncated data.
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });

  it('MCP task.create resolves project from repo_path when project_id is omitted', async () => {
    const app = buildTestApp();
    await seedSecondProject();

    const resp = await app.fetch(
      new Request(
        'http://test/mcp',
        bearer({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'sprino.task.create',
            arguments: {
              operation_id: '018c3e7a-0006-7000-8000-000000000001',
              repo_path: SECOND_PROJECT_REPO,
              title: 'Track Tessera schema bump',
            },
          },
        }),
      ),
    );

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      result: {
        structuredContent: { task: { project_id: string; title: string } };
      };
    };
    expect(body.result.structuredContent.task.project_id).toBe(
      SECOND_PROJECT_ID,
    );
    expect(body.result.structuredContent.task.title).toBe(
      'Track Tessera schema bump',
    );
  });
});

/**
 * Tessera v0.1.1 conformance: exercise the new error and edge-case coverage
 * shipped in the v0.1.0 stabilization milestone (with v0.1.1's _error.code
 * alignment). Most cases replay request fixtures loaded from
 * `tessera/conformance/fixtures/` against the live server and assert the
 * response matches the fixture contract; stateful edge-case flows may be
 * composed in-code when they require runtime ids or multi-step setup, while
 * still following the strict-match rules documented in
 * `tessera/conformance/README.md`.
 */
describe('Tessera v0.1.1 conformance — new fixtures', () => {
  it('task-create-operation-replay returns the same task and event ids as the first call', async () => {
    const app = buildTestApp();
    const replayReq = readFixture('task-create-operation-replay.req.json');

    const first = await app.fetch(
      new Request('http://test/api/tasks', bearer(replayReq)),
    );
    expect(first.status).toBe(201);
    const firstJson = (await first.json()) as {
      task: { id: string; version: number };
      event: { id: string };
    };

    const second = await app.fetch(
      new Request('http://test/api/tasks', bearer(replayReq)),
    );
    expect(second.status).toBe(201);
    const secondJson = (await second.json()) as {
      task: { id: string; version: number };
      event: { id: string };
    };

    expect(secondJson.task.id).toBe(firstJson.task.id);
    expect(secondJson.event.id).toBe(firstJson.event.id);
    expect(secondJson.task.version).toBe(1);
  });

  it('task-create-operation-conflict returns 409 with _error.code=operation_id_conflict', async () => {
    const app = buildTestApp();
    const baseReq = readFixture('task-create-operation-replay.req.json');
    const conflictReq = readFixture(
      'task-create-operation-conflict.req.json',
    );
    const expected = readFixture(
      'task-create-operation-conflict.res.json',
    ) as { _error: { status: number; code: string } };

    const first = await app.fetch(
      new Request('http://test/api/tasks', bearer(baseReq)),
    );
    expect(first.status).toBe(201);

    const conflicting = await app.fetch(
      new Request('http://test/api/tasks', bearer(conflictReq)),
    );
    expect(conflicting.status).toBe(expected._error.status);
    expect(conflicting.status).toBe(409);
    const body = (await conflicting.json()) as {
      error: string;
      cached_response: unknown;
    };
    expect(body.error).toBe(expected._error.code);
    expect(body.error).toBe('operation_id_conflict');
    expect(body.cached_response).toBeDefined();
  });

  it('task-update-status-version-conflict returns 409 with _error.code=version_mismatch and the current task', async () => {
    const app = buildTestApp();
    const createReq = readFixture('task-create-happy.req.json');
    const created = await app.fetch(
      new Request('http://test/api/tasks', bearer(createReq)),
    );
    const createdJson = (await created.json()) as { task: { id: string } };
    const taskId = createdJson.task.id;

    const upd1 = {
      ...(readFixture('task-update-status-happy.req.json') as Record<
        string,
        unknown
      >),
      task_id: taskId,
    };
    const r1 = await app.fetch(
      new Request(
        `http://test/api/tasks/${taskId}/status`,
        bearer(upd1, 'PATCH'),
      ),
    );
    expect(r1.status).toBe(200);

    const conflictReq = {
      ...(readFixture(
        'task-update-status-version-conflict.req.json',
      ) as Record<string, unknown>),
      task_id: taskId,
    };
    const expected = readFixture(
      'task-update-status-version-conflict.res.json',
    ) as { _error: { status: number; code: string } };

    const r2 = await app.fetch(
      new Request(
        `http://test/api/tasks/${taskId}/status`,
        bearer(conflictReq, 'PATCH'),
      ),
    );
    expect(r2.status).toBe(expected._error.status);
    expect(r2.status).toBe(409);
    const body = (await r2.json()) as {
      error: string;
      task: { id: string; version: number; status: string };
    };
    expect(body.error).toBe(expected._error.code);
    expect(body.error).toBe('version_mismatch');
    expect(body.task.version).toBe(2);
    expect(body.task.status).toBe('done');
    expect(body.task.id).toBe(taskId);
  });

  it('task-create-invalid-uuid returns 400 with _error.code=validation_error', async () => {
    const app = buildTestApp();
    const req = readFixture('task-create-invalid-uuid.req.json');
    const expected = readFixture(
      'task-create-invalid-uuid.res.json',
    ) as { _error: { status: number; code: string } };

    const resp = await app.fetch(
      new Request('http://test/api/tasks', bearer(req)),
    );
    expect(resp.status).toBe(expected._error.status);
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe(expected._error.code);
    expect(body.error).toBe('validation_error');
  });

  it('task-create-missing-required-field returns 400 with _error.code=validation_error', async () => {
    const app = buildTestApp();
    const req = readFixture('task-create-missing-required-field.req.json');
    const expected = readFixture(
      'task-create-missing-required-field.res.json',
    ) as { _error: { status: number; code: string } };

    const resp = await app.fetch(
      new Request('http://test/api/tasks', bearer(req)),
    );
    expect(resp.status).toBe(expected._error.status);
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe(expected._error.code);
    expect(body.error).toBe('validation_error');
  });

  it('task-get-truncated: oversized agent_context produces truncated:true with next_page_tokens under 32KB', async () => {
    const app = buildTestApp();
    const createReq = readFixture('task-create-happy.req.json');
    const created = await app.fetch(
      new Request('http://test/api/tasks', bearer(createReq)),
    );
    expect(created.status).toBe(201);
    const createdJson = (await created.json()) as { task: { id: string } };
    const taskId = createdJson.task.id;

    let prevStatus = 'todo';
    const heavyNotes = 'lorem ipsum '.repeat(200); // ~2.4KB per event
    for (let i = 0; i < 20; i++) {
      const next = prevStatus === 'todo' ? 'doing' : 'todo';
      const flipResp = await app.fetch(
        new Request(
          `http://test/api/tasks/${taskId}/status`,
          bearer(
            {
              operation_id: `018c3e7a-0009-7000-8000-${i.toString(16).padStart(12, '0')}`,
              status: next,
              if_match: i + 1,
              notes: heavyNotes,
            },
            'PATCH',
          ),
        ),
      );
      expect(flipResp.status).toBe(200);
      prevStatus = next;
    }

    const getResp = await app.fetch(
      new Request(`http://test/api/tasks/${taskId}`, {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(getResp.status).toBe(200);
    const body = (await getResp.json()) as {
      agent_context: {
        truncated: boolean;
        next_page_tokens?: Record<string, string>;
      };
    };

    expect(body.agent_context.truncated).toBe(true);
    expect(body.agent_context.next_page_tokens).toBeDefined();
    expect(
      Object.values(body.agent_context.next_page_tokens ?? {}).length,
    ).toBeGreaterThan(0);
    expect(
      JSON.stringify(body.agent_context).length,
    ).toBeLessThanOrEqual(32 * 1024);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Tessera v0.1.2 — actor lifecycle conformance.
// ───────────────────────────────────────────────────────────────────────

describe('Tessera v0.1.2 conformance — actor lifecycle', () => {
  it('runs register-happy → register-replay → revoke-happy → revoke-already-revoked', async () => {
    const app = buildTestApp();

    // ── register-happy ─────────────────────────────────────────────────
    const registerReq = readFixture(
      'actor-register-happy.req.json',
    ) as Record<string, unknown>;
    const expectedRegister = readFixture(
      'actor-register-happy.res.json',
    ) as Record<string, unknown>;

    const regResp = await app.fetch(
      new Request('http://test/api/actors', bearer(registerReq)),
    );
    expect(regResp.status).toBe(201);
    const regJson = (await regResp.json()) as {
      actor: Record<string, unknown>;
      token?: string;
    };
    const expActor = expectedRegister.actor as Record<string, unknown>;
    expect(regJson.actor.kind).toBe(expActor.kind);
    expect(regJson.actor.display_name).toBe(expActor.display_name);
    expect(regJson.actor.agent_runtime).toBe(null);
    expect(regJson.actor.parent_actor_id).toBe(null);
    // We mint with uuidv7 server-side; fixture uuid won't match exactly.
    expect(regJson.actor.id).toMatch(UUID_RE);
    expect(regJson.actor.created_at).toMatch(ISO_DATETIME_RE);
    expect(typeof regJson.token).toBe('string');
    expect(regJson.token!.length).toBeGreaterThanOrEqual(32);

    const mintedActorId = regJson.actor.id as string;
    const mintedToken = regJson.token!;

    // ── register-operation-replay (same op_id, same payload) ──────────
    const replayReq = readFixture(
      'actor-register-operation-replay.req.json',
    ) as Record<string, unknown>;
    expect(replayReq.operation_id).toBe(registerReq.operation_id);

    const replayResp = await app.fetch(
      new Request('http://test/api/actors', bearer(replayReq)),
    );
    expect(replayResp.status).toBe(201);
    const replayJson = (await replayResp.json()) as Record<string, unknown>;
    // Redaction is the load-bearing assertion: no `token` field on replay.
    expect('token' in replayJson).toBe(false);
    expect((replayJson.actor as Record<string, unknown>).id).toBe(
      mintedActorId,
    );

    // Newly minted credential authenticates.
    const meResp = await app.fetch(
      new Request(`http://test/api/actors/${mintedActorId}`, {
        headers: { authorization: `Bearer ${mintedToken}` },
      }),
    );
    expect(meResp.status).toBe(200);

    // ── revoke-happy ──────────────────────────────────────────────────
    const revokeReq = {
      ...(readFixture('actor-revoke-happy.req.json') as Record<string, unknown>),
      actor_id: mintedActorId,
    };
    const revokeResp = await app.fetch(
      new Request(
        `http://test/api/actors/${mintedActorId}/revoke_token`,
        bearer(revokeReq),
      ),
    );
    expect(revokeResp.status).toBe(200);
    const revokeJson = (await revokeResp.json()) as {
      actor: Record<string, unknown>;
    };
    expect('token' in revokeJson).toBe(false);
    expect(revokeJson.actor.id).toBe(mintedActorId);

    // The previously-minted credential now fails auth.
    const denied = await app.fetch(
      new Request('http://test/api/projects', {
        headers: { authorization: `Bearer ${mintedToken}` },
      }),
    );
    expect(denied.status).toBe(403);

    // ── revoke-already-revoked (different op_id, same actor) ──────────
    const replayRevokeReq: Record<string, unknown> = {
      ...(readFixture(
        'actor-revoke-already-revoked.req.json',
      ) as Record<string, unknown>),
      actor_id: mintedActorId,
    };
    expect(replayRevokeReq.operation_id).not.toBe(
      (revokeReq as Record<string, unknown>).operation_id,
    );

    const replayRevokeResp = await app.fetch(
      new Request(
        `http://test/api/actors/${mintedActorId}/revoke_token`,
        bearer(replayRevokeReq),
      ),
    );
    expect(replayRevokeResp.status).toBe(200);
    const replayRevokeJson = (await replayRevokeResp.json()) as {
      actor: Record<string, unknown>;
    };
    expect(replayRevokeJson.actor.id).toBe(mintedActorId);
  });

  it('rejects agent register requests missing required agent fields', async () => {
    const app = buildTestApp();
    const req = {
      operation_id: '018c3e7a-0005-7000-8000-000000000011',
      display_name: 'Claude Code (session)',
      kind: 'agent',
    };
    const r = await app.fetch(
      new Request('http://test/api/actors', bearer(req)),
    );
    expect(r.status).toBe(400);
    const body = (await r.json()) as {
      _error: {
        status: number;
        code: string;
        details: { field: string; reason: string };
      };
    };
    expect(body._error.status).toBe(400);
    expect(body._error.code).toBe('validation_error');
    expect(body._error.details.field).toBe('agent_runtime');
    expect(body._error.details.reason).toBe('Required field is missing.');
  });

  it('accepts complete agent register request validation before the temporary service guard rejects it', async () => {
    const app = buildTestApp();
    const req = readFixture(
      'actor-register-agent-happy.req.json',
    ) as Record<string, unknown>;

    expect(ActorRegisterReqSchema.parse(req)).toEqual(req);

    const r = await app.fetch(
      new Request('http://test/api/actors', bearer(req)),
    );
    expect(r.status).toBe(400);
    const body = (await r.json()) as {
      _error: {
        status: number;
        code: string;
        details: { field: string; reason: string };
      };
    };
    expect(body._error.status).toBe(400);
    expect(body._error.code).toBe('validation_error');
    expect(body._error.details.field).toBe('kind');
    expect(body._error.details.reason).toBe(
      'Only `human` is accepted in v0.1.2.',
    );
  });

  it('rejects register with missing display_name', async () => {
    const app = buildTestApp();
    const req = readFixture(
      'actor-register-validation-error.req.json',
    ) as Record<string, unknown>;
    const r = await app.fetch(
      new Request('http://test/api/actors', bearer(req)),
    );
    expect(r.status).toBe(400);
    const body = (await r.json()) as {
      _error: { details: { field: string; reason: string } };
    };
    expect(body._error.details.field).toBe('display_name');
    expect(body._error.details.reason).toBe('Required field is missing.');
  });

  it('returns 404 _error envelope for actor.get on unknown id', async () => {
    const app = buildTestApp();
    const req = readFixture(
      'actor-get-not-found.req.json',
    ) as Record<string, unknown>;
    const r = await app.fetch(
      new Request(`http://test/api/actors/${req.actor_id}`, {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(r.status).toBe(404);
    const body = (await r.json()) as {
      _error: { code: string; details: { field: string; reason: string } };
    };
    expect(body._error.code).toBe('not_found');
    expect(body._error.details.field).toBe('actor_id');
  });

  it('returns 404 _error envelope (and no operation row cached) for revoke on unknown id', async () => {
    const app = buildTestApp();
    const req = readFixture(
      'actor-revoke-not-found.req.json',
    ) as Record<string, unknown>;
    const unknownId = req.actor_id as string;
    const r = await app.fetch(
      new Request(
        `http://test/api/actors/${unknownId}/revoke_token`,
        bearer(req),
      ),
    );
    expect(r.status).toBe(404);

    // Same operation_id with a valid actor_id must NOT replay the cached
    // 404 — failed-precondition operations are not cached, per the
    // fixture's _meta.expected_behavior. We retry by posting against the
    // FIXTURE_ACTOR_ID with the same op_id; it should succeed (200).
    // (Last-admin guard would fire, but our test agent token still
    // satisfies the human-credential count if we revoke FIXTURE_ACTOR.
    // Instead, register a fresh human and revoke that one.)
    const newReg = await app.fetch(
      new Request(
        'http://test/api/actors',
        bearer({
          operation_id: '018c3e7a-9999-7000-8000-000000000001',
          display_name: 'Retryable',
          kind: 'human',
        }),
      ),
    );
    const newRegJson = (await newReg.json()) as { actor: { id: string } };
    const retried = await app.fetch(
      new Request(
        `http://test/api/actors/${newRegJson.actor.id}/revoke_token`,
        bearer({
          operation_id: req.operation_id,
          actor_id: newRegJson.actor.id,
        }),
      ),
    );
    expect(retried.status).toBe(200);
  });

  it('list-happy returns the {actors: [...]} envelope', async () => {
    const app = buildTestApp();
    const r = await app.fetch(
      new Request('http://test/api/actors', {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { actors: Array<Record<string, unknown>> };
    expect(Array.isArray(body.actors)).toBe(true);
    expect(body.actors.length).toBeGreaterThan(0);
  });

  it('list-filtered-by-kind returns only humans', async () => {
    const app = buildTestApp();
    const r = await app.fetch(
      new Request('http://test/api/actors?kind=human', {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { actors: Array<{ kind: string }> };
    expect(body.actors.every((a) => a.kind === 'human')).toBe(true);
  });

  it('returns 403 _error envelope for unauthorized actor.register over HTTP', async () => {
    const app = buildTestApp();
    const member = await seedDbActor({
      displayName: 'HTTP Member',
      role: 'member',
    });

    const r = await app.fetch(
      new Request(
        'http://test/api/actors',
        bearerForToken(member.token, {
          operation_id: '018c3e7a-aaaa-7000-8000-000000000101',
          display_name: 'Forbidden Register',
          kind: 'human',
        }),
      ),
    );
    expect(r.status).toBe(403);
    const body = (await r.json()) as {
      _error: { status: number; code: string; details: { field: string; reason: string } };
    };
    expect(body._error.status).toBe(403);
    expect(body._error.code).toBe('forbidden');
    expect(body._error.details.field).toBe('actor_id');
  });

  it('returns forbidden parity for actor admin verbs over MCP and HTTP', async () => {
    const app = buildTestApp();
    const member = await seedDbActor({
      displayName: 'MCP Member',
      role: 'member',
    });
    const target = await app.fetch(
      new Request(
        'http://test/api/actors',
        bearer({
          operation_id: '018c3e7a-aaaa-7000-8000-000000000102',
          display_name: 'Rotate Candidate',
          kind: 'human',
        }),
      ),
    );
    const targetJson = (await target.json()) as { actor: { id: string } };

    const revokeRpc = await app.fetch(
      new Request(
        'http://test/mcp',
        bearerForToken(member.token, {
          jsonrpc: '2.0',
          id: 99,
          method: 'tools/call',
          params: {
            name: 'sprino.actor.revoke_token',
            arguments: {
              operation_id: '018c3e7a-aaaa-7000-8000-000000000103',
              actor_id: targetJson.actor.id,
            },
          },
        }),
      ),
    );
    expect(revokeRpc.status).toBe(200);
    const revokeBody = (await revokeRpc.json()) as {
      error: { code: number; message: string };
    };
    expect(revokeBody.error.code).toBe(-32003);
    expect(revokeBody.error.message).toBe('forbidden');

    const rotateHttp = await app.fetch(
      new Request(
        `http://test/api/actors/${targetJson.actor.id}/rotate_token`,
        bearerForToken(member.token, {}, 'POST'),
      ),
    );
    expect(rotateHttp.status).toBe(403);

    const agentRegister = await app.fetch(
      new Request(
        'http://test/api/actors',
        bearerForToken(FIXTURE_AGENT_TOKEN, {
          operation_id: '018c3e7a-aaaa-7000-8000-000000000104',
          display_name: 'Agent Blocked',
          kind: 'human',
        }),
      ),
    );
    expect(agentRegister.status).toBe(403);
  });

  it('keeps internal agent lifecycle storage out of external actor and task contracts', async () => {
    const app = buildTestApp();

    await transitionAgentLifecycle(db, {
      actorId: FIXTURE_AGENT_ID,
      transition: 'heartbeat',
      now: new Date('2026-04-29T10:00:00.000Z'),
    });

    const createResp = await app.fetch(
      new Request(
        'http://test/api/tasks',
        bearerForToken(FIXTURE_AGENT_TOKEN, {
          operation_id: '018c3e7a-b203-7000-8000-000000000001',
          project_id: FIXTURE_PROJECT_ID,
          title: 'Verify lifecycle persistence stays internal',
        }),
      ),
    );
    expect(createResp.status).toBe(201);
    const createJson = (await createResp.json()) as {
      task: Record<string, unknown>;
      event: Record<string, unknown>;
    };
    expect(createJson.task.created_by).toBe(FIXTURE_AGENT_ID);
    expectNoAgentLifecycleFields(createJson.task);
    expectNoAgentLifecycleFields(createJson.event);

    const taskId = createJson.task.id as string;
    const getTaskResp = await app.fetch(
      new Request(`http://test/api/tasks/${taskId}`, {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(getTaskResp.status).toBe(200);
    const getTaskJson = (await getTaskResp.json()) as {
      task: Record<string, unknown>;
      agent_context: { recent_events: Array<Record<string, unknown>> };
    };
    expectNoAgentLifecycleFields(getTaskJson.task);
    for (const event of getTaskJson.agent_context.recent_events) {
      expectNoAgentLifecycleFields(event);
    }

    const eventListResp = await app.fetch(
      new Request(
        `http://test/api/events?project_id=${FIXTURE_PROJECT_ID}`,
        {
          headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
        },
      ),
    );
    expect(eventListResp.status).toBe(200);
    const eventListJson = (await eventListResp.json()) as {
      events: Array<{
        actor: Record<string, unknown>;
        task: Record<string, unknown>;
      }>;
    };
    const createdEvent = eventListJson.events.find(
      (event) => event.task.id === taskId,
    );
    expect(createdEvent).toBeDefined();
    expect(createdEvent!.actor.id).toBe(FIXTURE_AGENT_ID);
    expectNoAgentLifecycleFields(createdEvent!.actor);
    expectNoAgentLifecycleFields(createdEvent!.task);

    await transitionAgentLifecycle(db, {
      actorId: FIXTURE_AGENT_ID,
      transition: 'deactivate',
      now: new Date('2026-04-29T10:05:00.000Z'),
    });

    const getActorResp = await app.fetch(
      new Request(`http://test/api/actors/${FIXTURE_AGENT_ID}`, {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(getActorResp.status).toBe(200);
    const getActorJson = (await getActorResp.json()) as {
      actor: Record<string, unknown>;
    };
    expectNoAgentLifecycleFields(getActorJson.actor);

    const listActorsResp = await app.fetch(
      new Request('http://test/api/actors?kind=agent', {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(listActorsResp.status).toBe(200);
    const listActorsJson = (await listActorsResp.json()) as {
      actors: Array<Record<string, unknown>>;
    };
    const listedActor = listActorsJson.actors.find(
      (actor) => actor.id === FIXTURE_AGENT_ID,
    );
    expect(listedActor).toBeDefined();
    expectNoAgentLifecycleFields(listedActor!);

    const listAgentsResp = await app.fetch(
      new Request('http://test/api/agents', {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(listAgentsResp.status).toBe(200);
    const listAgentsJson = (await listAgentsResp.json()) as {
      agents: Array<Record<string, unknown>>;
    };
    const listedAgent = listAgentsJson.agents.find(
      (agent) => agent.id === FIXTURE_AGENT_ID,
    );
    expect(listedAgent).toBeDefined();
    expectNoAgentLifecycleFields(listedAgent!);

    const mcpGetActor = await app.fetch(
      new Request(
        'http://test/mcp',
        bearer({
          jsonrpc: '2.0',
          id: 200,
          method: 'tools/call',
          params: {
            name: 'sprino.actor.get',
            arguments: { actor_id: FIXTURE_AGENT_ID },
          },
        }),
      ),
    );
    expect(mcpGetActor.status).toBe(200);
    const mcpGetActorJson = (await mcpGetActor.json()) as {
      result: {
        content: Array<{ type: string; text: string }>;
        structuredContent: { actor: Record<string, unknown> };
      };
    };
    expectNoAgentLifecycleFields(
      mcpGetActorJson.result.structuredContent.actor,
    );
    const mcpGetActorText = JSON.parse(
      mcpGetActorJson.result.content[0]!.text,
    ) as { actor: Record<string, unknown> };
    expectNoAgentLifecycleFields(mcpGetActorText.actor);

    const mcpListActors = await app.fetch(
      new Request(
        'http://test/mcp',
        bearer({
          jsonrpc: '2.0',
          id: 201,
          method: 'tools/call',
          params: {
            name: 'sprino.actor.list',
            arguments: { kind: 'agent' },
          },
        }),
      ),
    );
    expect(mcpListActors.status).toBe(200);
    const mcpListActorsJson = (await mcpListActors.json()) as {
      result: {
        content: Array<{ type: string; text: string }>;
        structuredContent: { actors: Array<Record<string, unknown>> };
      };
    };
    const mcpActor =
      mcpListActorsJson.result.structuredContent.actors.find(
        (actor) => actor.id === FIXTURE_AGENT_ID,
    );
    expect(mcpActor).toBeDefined();
    expectNoAgentLifecycleFields(mcpActor!);
    const mcpListActorsText = JSON.parse(
      mcpListActorsJson.result.content[0]!.text,
    ) as { actors: Array<Record<string, unknown>> };
    const mcpTextActor = mcpListActorsText.actors.find(
      (actor) => actor.id === FIXTURE_AGENT_ID,
    );
    expect(mcpTextActor).toBeDefined();
    expectNoAgentLifecycleFields(mcpTextActor!);
  });
});
