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
import {
  FIXTURE_ACTOR_ID,
  FIXTURE_PROJECT_ID,
  FIXTURE_TOKEN,
  buildTestApp,
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

  it('GET /api/tasks ignores malformed limit query values', async () => {
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

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { tasks: unknown[] };
    expect(body.tasks).toHaveLength(1);
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
 * Tessera v0.1.1 conformance: replay the new error and edge-case fixtures
 * shipped in the v0.1.0 stabilization milestone (with v0.1.1's _error.code
 * alignment). Each fixture is loaded from `tessera/conformance/fixtures/`,
 * the request is replayed against the live server, and the response is
 * asserted to match the fixture's `_error` envelope (status + code) per the
 * strict-match contract documented in `tessera/conformance/README.md`.
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
        new Request(`http://test/api/tasks/${taskId}/status`, {
          method: 'PATCH',
          headers: {
            authorization: `Bearer ${FIXTURE_TOKEN}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            operation_id: `018c3e7a-0009-7000-8000-${i.toString(16).padStart(12, '0')}`,
            status: next,
            if_match: i + 1,
            notes: heavyNotes,
          }),
        }),
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
