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
import { actors, projects } from '../src/db/schema.ts';
import {
  ActorRegisterReqSchema,
  type ActorRegisterReq,
} from '../src/domain/index.ts';
import { transitionAgentLifecycle } from '../src/service/actors.ts';
import {
  FIXTURE_ACTOR_ID,
  FIXTURE_AGENT_ID,
  FIXTURE_AGENT_TOKEN,
  FIXTURE_PROJECT_ID,
  FIXTURE_TASK_ID,
  FIXTURE_TOKEN,
  buildTestApp,
  seedDbActor,
  seedFixtureTask,
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

function expectAgentRegisterReq(
  req: ActorRegisterReq,
): asserts req is Extract<ActorRegisterReq, { kind: 'agent' }> {
  if (req.kind !== 'agent') {
    throw new Error('Expected agent registration fixture');
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
  it('tools/list exposes the heartbeat verb and actor.register distinguishes agent-specific required fields', async () => {
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
      'sprino.actor.deactivate',
      'sprino.actor.get',
      'sprino.actor.heartbeat',
      'sprino.actor.list',
      'sprino.actor.register',
      'sprino.actor.revoke_token',
      'sprino.attachment.create_upload',
      'sprino.attachment.finalize',
      'sprino.attachment.get',
      'sprino.attachment.list',
      'sprino.project.create',
      'sprino.project.get',
      'sprino.project.list',
      'sprino.task.create',
      'sprino.task.get',
      'sprino.task.transition_workflow',
      'sprino.task.update_status',
    ]);

    const actorRegister = body.result.tools.find(
      (tool) => tool.name === 'sprino.actor.register',
    ) as
      | {
          name: string;
          description: string;
          inputSchema: {
            oneOf: Array<{
              required: string[];
              properties: Record<string, { const?: string; type?: unknown }>;
            }>;
          };
        }
      | undefined;
    expect(actorRegister).toBeDefined();
    expect(actorRegister?.description).toContain("kind='agent'");
    expect(actorRegister?.inputSchema.oneOf).toHaveLength(2);
    expect(actorRegister?.inputSchema.oneOf[0]).toMatchObject({
      required: ['operation_id', 'display_name', 'kind'],
      properties: {
        kind: { const: 'human' },
      },
    });
    expect(actorRegister?.inputSchema.oneOf[1]).toMatchObject({
      required: [
        'operation_id',
        'display_name',
        'kind',
        'agent_runtime',
        'parent_actor_id',
      ],
      properties: {
        kind: { const: 'agent' },
        agent_runtime: {
          type: 'string',
          maxLength: 120,
        },
        parent_actor_id: {
          type: 'string',
        },
      },
    });
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
      Buffer.byteLength(JSON.stringify(body.agent_context), 'utf8'),
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
    // This fixture still carries the legacy filename, but its current
    // payload/response pair asserts the missing-agent-fields validation path.
    const req = readFixture(
      'actor-register-invalid-kind.req.json',
    ) as Record<string, unknown>;
    const expected = readFixture(
      'actor-register-invalid-kind.res.json',
    ) as {
      _error: {
        status: number;
        code: string;
        details: { field: string; reason: string };
      };
    };

    const r = await app.fetch(
      new Request('http://test/api/actors', bearer(req)),
    );
    expect(r.status).toBe(expected._error.status);
    const body = (await r.json()) as {
      _error: {
        status: number;
        code: string;
        details: { field: string; reason: string };
      };
    };
    expect(body._error.status).toBe(expected._error.status);
    expect(body._error.code).toBe(expected._error.code);
    expect(body._error.details.field).toBe(expected._error.details.field);
    expect(body._error.details.reason).toBe(expected._error.details.reason);
  });

  it('maps malformed MCP actor.register requests to JSON-RPC invalid params', async () => {
    const app = buildTestApp();
    const req = readFixture(
      'actor-register-invalid-kind.req.json',
    ) as Record<string, unknown>;

    const r = await app.fetch(
      new Request(
        'http://test/mcp',
        bearer({
          jsonrpc: '2.0',
          id: 132,
          method: 'tools/call',
          params: {
            name: 'sprino.actor.register',
            arguments: req,
          },
        }),
      ),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      jsonrpc: string;
      id: number;
      error: {
        code: number;
        message: string;
        data: Array<{ path?: string[]; message?: string }>;
      };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(132);
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toBe('Invalid params');
    expect(body.error.data[0]?.path).toEqual(['agent_runtime']);
    expect(body.error.data[0]?.message).toBe(
      'Agent registration requires both `agent_runtime` and `parent_actor_id`.',
    );
  });

  it('accepts complete agent register requests over HTTP and MCP with replay redaction parity', async () => {
    const app = buildTestApp();
    const parsedReq = ActorRegisterReqSchema.parse(
      readFixture('actor-register-agent-happy.req.json'),
    );

    expect(parsedReq.kind).toBe('agent');
    expectAgentRegisterReq(parsedReq);
    const req = parsedReq;

    const r = await app.fetch(
      new Request('http://test/api/actors', bearer(req)),
    );
    expect(r.status).toBe(201);
    const body = (await r.json()) as {
      actor: Record<string, unknown>;
      token?: string;
    };
    expect(body.actor.kind).toBe('agent');
    expect(body.actor.display_name).toBe(req.display_name);
    expect(body.actor.agent_runtime).toBe(req.agent_runtime);
    expect(body.actor.parent_actor_id).toBe(req.parent_actor_id);
    expect(body.actor.id).toMatch(UUID_RE);
    expect(body.actor.created_at).toMatch(ISO_DATETIME_RE);
    expect(typeof body.token).toBe('string');
    expect(body.token!.length).toBeGreaterThanOrEqual(32);

    const agentMeResp = await app.fetch(
      new Request(`http://test/api/actors/${body.actor.id as string}`, {
        headers: { authorization: `Bearer ${body.token!}` },
      }),
    );
    expect(agentMeResp.status).toBe(200);

    const replay = await app.fetch(
      new Request('http://test/api/actors', bearer(req)),
    );
    expect(replay.status).toBe(201);
    const replayBody = (await replay.json()) as { actor: Record<string, unknown> };
    expect(replayBody.actor).toEqual(body.actor);
    expect('token' in replayBody).toBe(false);

    const mcpReq = {
      ...req,
      operation_id: '018c3e7a-0005-7000-8000-000000000130',
      display_name: 'Claude Code MCP Session',
    };
    const mcpResp = await app.fetch(
      new Request(
        'http://test/mcp',
        bearer({
          jsonrpc: '2.0',
          id: 130,
          method: 'tools/call',
          params: {
            name: 'sprino.actor.register',
            arguments: mcpReq,
          },
        }),
      ),
    );
    expect(mcpResp.status).toBe(200);
    const mcpBody = (await mcpResp.json()) as {
      result: {
        content: Array<{ type: string; text: string }>;
        structuredContent: {
          actor: Record<string, unknown>;
          token?: string;
        };
      };
    };
    expect(mcpBody.result.structuredContent.actor.kind).toBe('agent');
    expect(mcpBody.result.structuredContent.actor.display_name).toBe(
      mcpReq.display_name,
    );
    expect(mcpBody.result.structuredContent.actor.agent_runtime).toBe(
      mcpReq.agent_runtime,
    );
    expect(mcpBody.result.structuredContent.actor.parent_actor_id).toBe(
      mcpReq.parent_actor_id,
    );
    expect(mcpBody.result.structuredContent.actor.id).toMatch(UUID_RE);
    expect(mcpBody.result.structuredContent.actor.created_at).toMatch(
      ISO_DATETIME_RE,
    );
    expect(typeof mcpBody.result.structuredContent.token).toBe('string');
    expect(
      mcpBody.result.structuredContent.token!.length,
    ).toBeGreaterThanOrEqual(32);
    expect(mcpBody.result.content[0]?.type).toBe('text');
    expect(mcpBody.result.content[0]?.text).toBe(
      JSON.stringify(mcpBody.result.structuredContent),
    );

    const mcpReplayResp = await app.fetch(
      new Request(
        'http://test/mcp',
        bearer({
          jsonrpc: '2.0',
          id: 131,
          method: 'tools/call',
          params: {
            name: 'sprino.actor.register',
            arguments: mcpReq,
          },
        }),
      ),
    );
    expect(mcpReplayResp.status).toBe(200);
    const mcpReplayBody = (await mcpReplayResp.json()) as {
      result: {
        content: Array<{ type: string; text: string }>;
        structuredContent: { actor: Record<string, unknown> };
      };
    };
    expect(mcpReplayBody.result.structuredContent.actor).toEqual(
      mcpBody.result.structuredContent.actor,
    );
    expect('token' in mcpReplayBody.result.structuredContent).toBe(false);
    expect(mcpReplayBody.result.content[0]?.type).toBe('text');
    expect(mcpReplayBody.result.content[0]?.text).toBe(
      JSON.stringify(mcpReplayBody.result.structuredContent),
    );
    expect(mcpReplayBody.result.content[0]?.text).not.toContain('token');
  });

  it('maps service-layer parent validation failures for actor.register to JSON-RPC invalid params', async () => {
    const app = buildTestApp();
    const req = {
      operation_id: '018c3e7a-0005-7000-8000-000000000132',
      display_name: 'Claude Code MCP Orphan Agent',
      kind: 'agent',
      agent_runtime: 'claude-code',
      parent_actor_id: '018c3e7a-ffff-7000-8000-000000000001',
    };

    const r = await app.fetch(
      new Request(
        'http://test/mcp',
        bearer({
          jsonrpc: '2.0',
          id: 133,
          method: 'tools/call',
          params: {
            name: 'sprino.actor.register',
            arguments: req,
          },
        }),
      ),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      jsonrpc: string;
      id: number;
      error: {
        code: number;
        message: string;
        data: { field: string; reason: string };
      };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(133);
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toBe('validation_error');
    expect(body.error.data).toEqual({
      field: 'parent_actor_id',
      reason: 'Parent actor does not exist.',
    });
  });

  it('maps non-human parent validation failures for actor.register over HTTP and JSON-RPC', async () => {
    const app = buildTestApp();
    const parent = await seedDbActor({
      displayName: 'Nested Agent Parent',
      kind: 'agent',
      agentRuntime: 'claude-code',
      parentActorId: FIXTURE_ACTOR_ID,
    });
    const req = {
      operation_id: '018c3e7a-0005-7000-8000-000000000134',
      display_name: 'Claude Code Nested Agent',
      kind: 'agent' as const,
      agent_runtime: 'claude-code',
      parent_actor_id: parent.actorId,
    };

    const httpResp = await app.fetch(
      new Request('http://test/api/actors', bearer(req)),
    );
    expect(httpResp.status).toBe(400);
    const httpBody = (await httpResp.json()) as {
      _error: {
        status: number;
        code: string;
        details: { field: string; reason: string };
      };
    };
    expect(httpBody._error.status).toBe(400);
    expect(httpBody._error.code).toBe('validation_error');
    expect(httpBody._error.details).toEqual({
      field: 'parent_actor_id',
      reason: 'Parent actor must reference a human actor.',
    });

    const mcpResp = await app.fetch(
      new Request(
        'http://test/mcp',
        bearer({
          jsonrpc: '2.0',
          id: 134,
          method: 'tools/call',
          params: {
            name: 'sprino.actor.register',
            arguments: req,
          },
        }),
      ),
    );
    expect(mcpResp.status).toBe(200);
    const mcpBody = (await mcpResp.json()) as {
      jsonrpc: string;
      id: number;
      error: {
        code: number;
        message: string;
        data: { field: string; reason: string };
      };
    };
    expect(mcpBody.jsonrpc).toBe('2.0');
    expect(mcpBody.id).toBe(134);
    expect(mcpBody.error.code).toBe(-32602);
    expect(mcpBody.error.message).toBe('validation_error');
    expect(mcpBody.error.data).toEqual({
      field: 'parent_actor_id',
      reason: 'Parent actor must reference a human actor.',
    });
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

  it('actor-heartbeat-happy fixture: HTTP and MCP heartbeat return the actor envelope without token', async () => {
    const app = buildTestApp();

    // Register an agent using the canonical fixture (parent_actor_id = FIXTURE_ACTOR_ID)
    const agentRegReq = readFixture(
      'actor-register-agent-happy.req.json',
    ) as Record<string, unknown>;
    const regResp = await app.fetch(
      new Request('http://test/api/actors', bearer(agentRegReq)),
    );
    expect(regResp.status).toBe(201);
    const regJson = (await regResp.json()) as {
      actor: Record<string, unknown>;
      token: string;
    };
    const agentId = regJson.actor.id as string;
    const agentToken = regJson.token;

    // Read the heartbeat fixtures for shape validation
    const heartbeatReq = readFixture(
      'actor-heartbeat-happy.req.json',
    ) as Record<string, unknown>;
    const heartbeatRes = readFixture(
      'actor-heartbeat-happy.res.json',
    ) as { actor: Record<string, unknown> };

    // HTTP heartbeat: agent calls its own heartbeat
    const httpRes = await app.fetch(
      new Request(
        `http://test/api/actors/${agentId}/heartbeat`,
        bearerForToken(agentToken, { ...heartbeatReq, actor_id: agentId }),
      ),
    );
    expect(httpRes.status).toBe(200);
    const httpBody = (await httpRes.json()) as {
      actor: Record<string, unknown>;
      token?: unknown;
    };
    // Fixture shape assertions
    expect(httpBody.actor.kind).toBe(heartbeatRes.actor.kind);
    expect(httpBody.actor.kind).toBe('agent');
    expect(httpBody.actor.display_name).toBe(heartbeatRes.actor.display_name);
    expect(httpBody.actor.agent_runtime).toBe(heartbeatRes.actor.agent_runtime);
    expect(httpBody.actor.parent_actor_id).toBe(agentRegReq.parent_actor_id);
    expect(httpBody.actor.id).toMatch(UUID_RE);
    expect(httpBody.actor.created_at).toMatch(ISO_DATETIME_RE);
    // No token in response
    expect('token' in httpBody).toBe(false);

    // MCP heartbeat
    const mcpRes = await app.fetch(
      new Request(
        'http://test/mcp',
        bearerForToken(agentToken, {
          jsonrpc: '2.0',
          id: 501,
          method: 'tools/call',
          params: {
            name: 'sprino.actor.heartbeat',
            arguments: { actor_id: agentId },
          },
        }),
      ),
    );
    expect(mcpRes.status).toBe(200);
    const mcpBody = (await mcpRes.json()) as {
      result: {
        content: Array<{ type: string; text: string }>;
        structuredContent: { actor: Record<string, unknown> };
      };
    };
    const mcpActor = mcpBody.result.structuredContent.actor;
    expect(mcpActor.kind).toBe('agent');
    expect(mcpActor.display_name).toBe(heartbeatRes.actor.display_name);
    expect(mcpActor.agent_runtime).toBe(heartbeatRes.actor.agent_runtime);
    expect(mcpActor.parent_actor_id).toBe(agentRegReq.parent_actor_id);
    expect(mcpActor.id).toMatch(UUID_RE);
    expect(mcpActor.created_at).toMatch(ISO_DATETIME_RE);
    // Verify no token in structuredContent
    expect('token' in mcpBody.result.structuredContent).toBe(false);
    // text/structuredContent parity
    expect(mcpBody.result.content[0]?.text).toBe(
      JSON.stringify(mcpBody.result.structuredContent),
    );
  });

  it('actor-deactivate-happy fixture: HTTP deactivation by a human returns actor envelope', async () => {
    const app = buildTestApp();

    // Register an agent first
    const agentRegReq = readFixture(
      'actor-register-agent-happy.req.json',
    ) as Record<string, unknown>;
    const regResp = await app.fetch(
      new Request('http://test/api/actors', bearer(agentRegReq)),
    );
    expect(regResp.status).toBe(201);
    const regJson = (await regResp.json()) as { actor: Record<string, unknown> };
    const agentId = regJson.actor.id as string;

    const deactivateReq = readFixture(
      'actor-deactivate-happy.req.json',
    ) as Record<string, unknown>;
    const expectedRes = readFixture(
      'actor-deactivate-happy.res.json',
    ) as { actor: Record<string, unknown> };

    // Human caller deactivates the agent
    const httpRes = await app.fetch(
      new Request(
        `http://test/api/actors/${agentId}/deactivate`,
        bearer({ ...deactivateReq, actor_id: agentId }),
      ),
    );
    expect(httpRes.status).toBe(200);
    const httpBody = (await httpRes.json()) as {
      actor: Record<string, unknown>;
      token?: unknown;
    };
    // Fixture shape assertions
    expect(httpBody.actor.kind).toBe(expectedRes.actor.kind);
    expect(httpBody.actor.kind).toBe('agent');
    expect(httpBody.actor.display_name).toBe(expectedRes.actor.display_name);
    expect(httpBody.actor.agent_runtime).toBe(expectedRes.actor.agent_runtime);
    expect(httpBody.actor.parent_actor_id).toBe(agentRegReq.parent_actor_id);
    expect(httpBody.actor.id).toMatch(UUID_RE);
    expect(httpBody.actor.created_at).toMatch(ISO_DATETIME_RE);
    // No token in response
    expect('token' in httpBody).toBe(false);
  });

  it('actor-deactivate-already-inactive fixture: deactivating inactive agent is domain-idempotent', async () => {
    const app = buildTestApp();

    // Register an agent
    const agentRegReq = readFixture(
      'actor-register-agent-happy.req.json',
    ) as Record<string, unknown>;
    const regResp = await app.fetch(
      new Request('http://test/api/actors', bearer(agentRegReq)),
    );
    expect(regResp.status).toBe(201);
    const regJson = (await regResp.json()) as { actor: Record<string, unknown> };
    const agentId = regJson.actor.id as string;

    const deactivateHappyReq = readFixture(
      'actor-deactivate-happy.req.json',
    ) as Record<string, unknown>;

    // First deactivation
    const first = await app.fetch(
      new Request(
        `http://test/api/actors/${agentId}/deactivate`,
        bearer({ ...deactivateHappyReq, actor_id: agentId }),
      ),
    );
    expect(first.status).toBe(200);

    // Second deactivation with a new operation_id — domain-idempotent, no error
    const alreadyInactiveReq = readFixture(
      'actor-deactivate-already-inactive.req.json',
    ) as Record<string, unknown>;
    const expectedRes = readFixture(
      'actor-deactivate-already-inactive.res.json',
    ) as { actor: Record<string, unknown> };

    const second = await app.fetch(
      new Request(
        `http://test/api/actors/${agentId}/deactivate`,
        bearer({ ...alreadyInactiveReq, actor_id: agentId }),
      ),
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      actor: Record<string, unknown>;
    };
    expect(secondBody.actor.kind).toBe(expectedRes.actor.kind);
    expect(secondBody.actor.id).toBe(agentId);
    expect('token' in secondBody).toBe(false);
  });

  it('actor-deactivate via MCP returns structuredContent actor envelope', async () => {
    const app = buildTestApp();

    // Register an agent
    const agentRegReq = readFixture(
      'actor-register-agent-happy.req.json',
    ) as Record<string, unknown>;
    const regResp = await app.fetch(
      new Request('http://test/api/actors', bearer(agentRegReq)),
    );
    expect(regResp.status).toBe(201);
    const regJson = (await regResp.json()) as { actor: Record<string, unknown> };
    const agentId = regJson.actor.id as string;

    // Human calls MCP deactivate
    const mcpRes = await app.fetch(
      new Request(
        'http://test/mcp',
        bearer({
          jsonrpc: '2.0',
          id: 502,
          method: 'tools/call',
          params: {
            name: 'sprino.actor.deactivate',
            arguments: {
              operation_id: '018c3e7a-0005-7000-8000-000000000532',
              actor_id: agentId,
            },
          },
        }),
      ),
    );
    expect(mcpRes.status).toBe(200);
    const mcpBody = (await mcpRes.json()) as {
      result: {
        content: Array<{ type: string; text: string }>;
        structuredContent: { actor: Record<string, unknown> };
      };
    };
    const mcpActor = mcpBody.result.structuredContent.actor;
    expect(mcpActor.kind).toBe('agent');
    expect(mcpActor.id).toBe(agentId);
    expect(mcpActor.id).toMatch(UUID_RE);
    expect(mcpActor.created_at).toMatch(ISO_DATETIME_RE);
    expect('token' in mcpBody.result.structuredContent).toBe(false);
    // text/structuredContent parity
    expect(mcpBody.result.content[0]?.text).toBe(
      JSON.stringify(mcpBody.result.structuredContent),
    );
  });

  it('rejects agent calling deactivate with 403 forbidden', async () => {
    const app = buildTestApp();

    // Register an agent
    const agentRegReq = readFixture(
      'actor-register-agent-happy.req.json',
    ) as Record<string, unknown>;
    const regResp = await app.fetch(
      new Request('http://test/api/actors', bearer(agentRegReq)),
    );
    expect(regResp.status).toBe(201);
    const regJson = (await regResp.json()) as {
      actor: Record<string, unknown>;
      token: string;
    };
    const agentId = regJson.actor.id as string;
    const agentToken = regJson.token;

    // Agent tries to deactivate via HTTP — must be rejected
    const httpRes = await app.fetch(
      new Request(
        `http://test/api/actors/${agentId}/deactivate`,
        bearerForToken(agentToken, {
          operation_id: '018c3e7a-0005-7000-8000-000000000533',
          actor_id: agentId,
        }),
      ),
    );
    expect(httpRes.status).toBe(403);
    const httpBody = (await httpRes.json()) as {
      _error: { code: string; details: { field: string; reason: string } };
    };
    expect(httpBody._error.code).toBe('forbidden');

    // Agent tries to deactivate via MCP — must be rejected
    const mcpRes = await app.fetch(
      new Request(
        'http://test/mcp',
        bearerForToken(agentToken, {
          jsonrpc: '2.0',
          id: 503,
          method: 'tools/call',
          params: {
            name: 'sprino.actor.deactivate',
            arguments: {
              operation_id: '018c3e7a-0005-7000-8000-000000000534',
              actor_id: agentId,
            },
          },
        }),
      ),
    );
    expect(mcpRes.status).toBe(200);
    const mcpBody = (await mcpRes.json()) as {
      error: { code: number; message: string };
    };
    expect(mcpBody.error.code).toBe(-32003);
    expect(mcpBody.error.message).toBe('forbidden');
  });

  it('actor-deactivate operation_id conflict returns 409 when same op_id is reused with a different actor_id', async () => {
    const app = buildTestApp();

    // Register two distinct agents
    const regReq1 = {
      operation_id: '018c3e7a-0005-7000-8000-000000000560',
      display_name: 'Deactivate Conflict Agent A',
      kind: 'agent' as const,
      agent_runtime: 'claude-code',
      parent_actor_id: FIXTURE_ACTOR_ID,
    };
    const regReq2 = {
      operation_id: '018c3e7a-0005-7000-8000-000000000561',
      display_name: 'Deactivate Conflict Agent B',
      kind: 'agent' as const,
      agent_runtime: 'claude-code',
      parent_actor_id: FIXTURE_ACTOR_ID,
    };
    const reg1 = await app.fetch(new Request('http://test/api/actors', bearer(regReq1)));
    const reg2 = await app.fetch(new Request('http://test/api/actors', bearer(regReq2)));
    expect(reg1.status).toBe(201);
    expect(reg2.status).toBe(201);
    const agentAId = ((await reg1.json()) as { actor: { id: string } }).actor.id;
    const agentBId = ((await reg2.json()) as { actor: { id: string } }).actor.id;

    const sharedOpId = '018c3e7a-0005-7000-8000-000000000562';

    // First deactivation with sharedOpId targeting agent A — succeeds
    const first = await app.fetch(
      new Request(
        `http://test/api/actors/${agentAId}/deactivate`,
        bearer({ operation_id: sharedOpId, actor_id: agentAId }),
      ),
    );
    expect(first.status).toBe(200);

    // Same operation_id reused with a different actor_id (agent B) — must 409
    const conflict = await app.fetch(
      new Request(
        `http://test/api/actors/${agentBId}/deactivate`,
        bearer({ operation_id: sharedOpId, actor_id: agentBId }),
      ),
    );
    expect(conflict.status).toBe(409);
    const conflictBody = (await conflict.json()) as {
      _error: { code: string; details: { field: string } };
      cached_response: unknown;
    };
    expect(conflictBody._error.code).toBe('operation_id_conflict');
    expect(conflictBody._error.details.field).toBe('operation_id');
    expect(conflictBody.cached_response).toBeDefined();
  });

  it('rejects deactivate of a human actor with validation error', async () => {
    const app = buildTestApp();

    // Try to deactivate a human actor — lifecycle transitions are agent-only
    const httpRes = await app.fetch(
      new Request(
        `http://test/api/actors/${FIXTURE_ACTOR_ID}/deactivate`,
        bearer({
          operation_id: '018c3e7a-0005-7000-8000-000000000535',
          actor_id: FIXTURE_ACTOR_ID,
        }),
      ),
    );
    expect(httpRes.status).toBe(409);
    const httpBody = (await httpRes.json()) as {
      _error: { code: string };
    };
    expect(httpBody._error.code).toBe('actor_kind_not_agent');
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

// ───────────────────────────────────────────────────────────────────────
// Tessera B6 — fixture gap coverage.
//
// Each test below wires a previously uncovered req/res fixture pair to
// the live server so that every fixture in tessera/conformance/fixtures/
// is exercised. Structural fields are asserted exactly; fields whose
// values depend on test-setup differences (display_name, created_at,
// repo_path) are validated by type or regex instead of exact equality.
// ───────────────────────────────────────────────────────────────────────

describe('Tessera B6 — fixture gap coverage', () => {
  it('project-list-happy: GET /api/projects returns {projects:[]} envelope with fixture-shape', async () => {
    const app = buildTestApp();
    await db.insert(projects).values({
      id: SECOND_PROJECT_ID,
      slug: 'tessera',
      displayName: 'Tessera',
      repoPath: SECOND_PROJECT_REPO,
    });

    const expectedRes = readFixture('project-list-happy.res.json') as {
      projects: Array<Record<string, unknown>>;
    };

    const resp = await app.fetch(
      new Request('http://test/api/projects', {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      projects: Array<Record<string, unknown>>;
    };

    expect(Array.isArray(body.projects)).toBe(true);
    expect(body.projects.length).toBeGreaterThanOrEqual(
      expectedRes.projects.length,
    );
    const fixtureKeys = Object.keys(expectedRes.projects[0]!);
    for (const project of body.projects) {
      for (const key of fixtureKeys) {
        expect(project).toHaveProperty(key);
      }
      expect(project.id).toMatch(UUID_RE);
      expect(project.created_at).toMatch(ISO_DATETIME_RE);
    }
    const slugs = body.projects.map((p) => p.slug);
    expect(slugs).toContain('sprino');
    expect(slugs).toContain('tessera');
  });

  it('project-get-by-repo-path-happy: GET /api/projects/resolve?repo_path returns {project} envelope', async () => {
    const app = buildTestApp();
    await db.insert(projects).values({
      id: SECOND_PROJECT_ID,
      slug: 'tessera',
      displayName: 'Tessera',
      repoPath: SECOND_PROJECT_REPO,
    });

    const req = readFixture(
      'project-get-by-repo-path-happy.req.json',
    ) as { repo_path: string };
    const expectedRes = readFixture(
      'project-get-by-repo-path-happy.res.json',
    ) as { project: Record<string, unknown> };

    const resp = await app.fetch(
      new Request(
        `http://test/api/projects/resolve?repo_path=${encodeURIComponent(req.repo_path)}`,
        { headers: { authorization: `Bearer ${FIXTURE_TOKEN}` } },
      ),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { project: Record<string, unknown> };

    expect(body.project.id).toBe(expectedRes.project.id);
    expect(body.project.slug).toBe(expectedRes.project.slug);
    expect(body.project.display_name).toBe(expectedRes.project.display_name);
    expect(body.project.repo_path).toBe(req.repo_path);
    expect(body.project.created_at).toMatch(ISO_DATETIME_RE);
  });

  it('actor-get-happy: GET /api/actors/:id returns fixture actor shape', async () => {
    const app = buildTestApp();

    const req = readFixture('actor-get-happy.req.json') as {
      actor_id: string;
    };
    const expectedRes = readFixture('actor-get-happy.res.json') as {
      actor: Record<string, unknown>;
    };

    const resp = await app.fetch(
      new Request(`http://test/api/actors/${req.actor_id}`, {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { actor: Record<string, unknown> };

    expect(body.actor.id).toBe(expectedRes.actor.id);
    expect(body.actor.kind).toBe(expectedRes.actor.kind);
    expect(body.actor.agent_runtime).toBe(expectedRes.actor.agent_runtime);
    expect(body.actor.parent_actor_id).toBe(expectedRes.actor.parent_actor_id);
    expect(body.actor.created_at).toMatch(ISO_DATETIME_RE);
    expect(typeof body.actor.display_name).toBe('string');
    expectNoAgentLifecycleFields(body.actor);
  });

  it('actor-list-happy: GET /api/actors returns {actors:[]} envelope with fixture-shape actors', async () => {
    const app = buildTestApp();

    const expectedRes = readFixture('actor-list-happy.res.json') as {
      actors: Array<Record<string, unknown>>;
    };
    const fixtureKeys = Object.keys(expectedRes.actors[0]!);

    const resp = await app.fetch(
      new Request('http://test/api/actors', {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      actors: Array<Record<string, unknown>>;
    };

    expect(Array.isArray(body.actors)).toBe(true);
    expect(body.actors.length).toBeGreaterThan(0);
    for (const actor of body.actors) {
      for (const key of fixtureKeys) {
        expect(actor).toHaveProperty(key);
      }
      expect(actor.id).toMatch(UUID_RE);
      expect(actor.created_at).toMatch(ISO_DATETIME_RE);
      expectNoAgentLifecycleFields(actor);
    }
  });

  it('actor-list-filtered-by-kind: GET /api/actors?kind=human returns only humans matching fixture shape', async () => {
    const app = buildTestApp();

    const req = readFixture('actor-list-filtered-by-kind.req.json') as {
      kind: string;
    };
    const expectedRes = readFixture(
      'actor-list-filtered-by-kind.res.json',
    ) as { actors: Array<{ id: string; display_name: string; [k: string]: unknown }> };
    const fixtureKeys = Object.keys(expectedRes.actors[0]!);

    // Seed all fixture humans so the >= length assertion is not vacuous.
    // The fixture _meta says "actor-register-happy already ran" — we replicate
    // that pre-condition by inserting the actors that aren't the default seed.
    for (const fixtureActor of expectedRes.actors) {
      if (fixtureActor.id !== FIXTURE_ACTOR_ID) {
        await db.insert(actors).values({
          id: fixtureActor.id,
          kind: 'human',
          role: 'member',
          displayName: fixtureActor.display_name,
          agentRuntime: null,
          parentActorId: null,
          source: 'db',
        }).onConflictDoNothing();
      }
    }

    const resp = await app.fetch(
      new Request(`http://test/api/actors?kind=${req.kind}`, {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      actors: Array<Record<string, unknown>>;
    };

    expect(body.actors.length).toBeGreaterThanOrEqual(expectedRes.actors.length);
    expect(body.actors.every((a) => a.kind === req.kind)).toBe(true);
    for (const actor of body.actors) {
      for (const key of fixtureKeys) {
        expect(actor).toHaveProperty(key);
      }
      expectNoAgentLifecycleFields(actor);
    }
  });

  it('actor-register-agent-invalid-parent: rejects agent with agent parent using fixture request', async () => {
    const app = buildTestApp();

    const req = readFixture(
      'actor-register-agent-invalid-parent.req.json',
    ) as Record<string, unknown>;
    const expectedRes = readFixture(
      'actor-register-agent-invalid-parent.res.json',
    ) as {
      _error: {
        status: number;
        code: string;
        details: { field: string; reason: string };
      };
    };

    // Seed the specific agent actor the fixture's parent_actor_id references.
    await db.insert(actors).values({
      id: req.parent_actor_id as string,
      kind: 'agent',
      role: 'member',
      displayName: 'Fixture Agent Parent',
      agentRuntime: 'claude-code',
      parentActorId: FIXTURE_ACTOR_ID,
      source: 'db',
    });

    const resp = await app.fetch(
      new Request('http://test/api/actors', bearer(req)),
    );
    expect(resp.status).toBe(expectedRes._error.status);
    const body = (await resp.json()) as {
      _error: {
        status: number;
        code: string;
        details: { field: string; reason: string };
      };
    };
    expect(body._error.status).toBe(expectedRes._error.status);
    expect(body._error.code).toBe(expectedRes._error.code);
    expect(body._error.details.field).toBe(expectedRes._error.details.field);
    expect(body._error.details.reason).toBe(expectedRes._error.details.reason);
  });

  it('actor-register-agent-operation-replay: agent register replay omits token and returns same actor', async () => {
    const app = buildTestApp();

    const req = readFixture(
      'actor-register-agent-operation-replay.req.json',
    ) as Record<string, unknown>;
    const expectedRes = readFixture(
      'actor-register-agent-operation-replay.res.json',
    ) as { actor: Record<string, unknown> };

    // First registration — should succeed and mint a token.
    const first = await app.fetch(
      new Request('http://test/api/actors', bearer(req)),
    );
    expect(first.status).toBe(201);
    const firstJson = (await first.json()) as {
      actor: Record<string, unknown>;
      token: string;
    };
    expect(firstJson.actor.kind).toBe(expectedRes.actor.kind);
    expect(firstJson.actor.display_name).toBe(expectedRes.actor.display_name);
    expect(firstJson.actor.agent_runtime).toBe(expectedRes.actor.agent_runtime);
    expect(firstJson.actor.parent_actor_id).toBe(req.parent_actor_id);
    expect(typeof firstJson.token).toBe('string');

    // Replay — same op_id, same payload: token MUST be omitted.
    const replay = await app.fetch(
      new Request('http://test/api/actors', bearer(req)),
    );
    expect(replay.status).toBe(201);
    const replayJson = (await replay.json()) as Record<string, unknown>;
    expect('token' in replayJson).toBe(false);
    expect((replayJson.actor as Record<string, unknown>).id).toBe(
      firstJson.actor.id,
    );
  });

  it('task-get-truncated: agent_context.truncated=true and next_page_tokens match fixture contract',
    // 21 sequential HTTP requests against a remote DB can take 12-14 s; give headroom.
    async () => {
    const app = buildTestApp();

    const expectedRes = readFixture('task-get-truncated.res.json') as {
      agent_context: {
        truncated: boolean;
        next_page_tokens: Record<string, string>;
      };
    };

    // Build state: create a task then flood it with events to exceed 32KB.
    const createResp = await app.fetch(
      new Request(
        'http://test/api/tasks',
        bearer({
          operation_id: '018c3e7a-b602-7000-8000-000000000001',
          project_id: FIXTURE_PROJECT_ID,
          title: 'Long-running task with extensive agent context',
        }),
      ),
    );
    expect(createResp.status).toBe(201);
    const { task } = (await createResp.json()) as { task: { id: string } };
    const taskId = task.id;

    const heavyNotes = 'lorem ipsum '.repeat(200);
    let prevStatus = 'todo';
    for (let i = 0; i < 20; i++) {
      const next = prevStatus === 'todo' ? 'doing' : 'todo';
      const flipResp = await app.fetch(
        new Request(
          `http://test/api/tasks/${taskId}/status`,
          bearer(
            {
              operation_id: `018c3e7a-b603-7000-8000-${i.toString(16).padStart(12, '0')}`,
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

    expect(body.agent_context.truncated).toBe(expectedRes.agent_context.truncated);
    expect(body.agent_context.next_page_tokens).toBeDefined();
    expect(
      Object.keys(body.agent_context.next_page_tokens ?? {}).length,
    ).toBeGreaterThan(0);
    expect(
      Buffer.byteLength(JSON.stringify(body.agent_context), 'utf8'),
    ).toBeLessThanOrEqual(32 * 1024);
    const tokenKeys = Object.keys(
      expectedRes.agent_context.next_page_tokens,
    );
    for (const key of tokenKeys) {
      expect(body.agent_context.next_page_tokens).toHaveProperty(key);
    }
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────
// Tessera v0.1.4 — attachment conformance.
//
// The fixture sequence is: create_upload → PUT binary → finalize → get → list.
// Fixture attachment.id and timestamps are relaxed (server generates them);
// all other fields including status, filename, task_id, created_by are exact.
// ───────────────────────────────────────────────────────────────────────

describe('Tessera v0.1.4 conformance — attachment happy path sequence', () => {
  it('runs create_upload → PUT binary → finalize → get → list against canonical fixtures', async () => {
    const app = buildTestApp();
    await seedFixtureTask();

    // ── step 1: attachment.create_upload ───────────────────────────────
    const createReq = readFixture(
      'attachment-create-upload-happy.req.json',
    ) as Record<string, unknown>;
    const expectedCreate = readFixture(
      'attachment-create-upload-happy.res.json',
    ) as {
      attachment: Record<string, unknown>;
      upload_url: string;
    };

    const createResp = await app.fetch(
      new Request('http://test/api/attachments', bearer(createReq)),
    );
    expect(createResp.status).toBe(201);
    const createJson = (await createResp.json()) as {
      attachment: Record<string, unknown>;
      upload_url: string;
    };

    // Server generates its own id — we capture it and use it throughout.
    const attId = createJson.attachment.id as string;
    expect(attId).toMatch(UUID_RE);
    expect(createJson.attachment.task_id).toBe(
      expectedCreate.attachment.task_id,
    );
    expect(createJson.attachment.filename).toBe(
      expectedCreate.attachment.filename,
    );
    expect(createJson.attachment.content_type).toBe(
      expectedCreate.attachment.content_type,
    );
    expect(createJson.attachment.size_bytes).toBe(
      expectedCreate.attachment.size_bytes,
    );
    expect(createJson.attachment.status).toBe('pending');
    expect(createJson.attachment.url).toBeNull();
    expect(createJson.attachment.created_by).toBe(FIXTURE_ACTOR_ID);
    expect(createJson.attachment.created_at).toMatch(ISO_DATETIME_RE);
    expect(createJson.upload_url).toBe(`/api/attachments/${attId}/upload`);

    // ── step 2: PUT binary to upload_url ───────────────────────────────
    const uploadResp = await app.fetch(
      new Request(`http://test${createJson.upload_url}`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${FIXTURE_TOKEN}`,
          'content-type': 'image/png',
        },
        body: new Uint8Array(42187).fill(0x00), // 42187 bytes to match size_bytes
      }),
    );
    expect(uploadResp.status).toBe(204);

    // ── step 3: attachment.finalize ────────────────────────────────────
    const finalizeReq = readFixture(
      'attachment-finalize-happy.req.json',
    ) as Record<string, unknown>;
    const expectedFinalize = readFixture(
      'attachment-finalize-happy.res.json',
    ) as { attachment: Record<string, unknown> };

    const finalizeResp = await app.fetch(
      new Request(
        `http://test/api/attachments/${attId}/finalize`,
        bearer({ operation_id: finalizeReq.operation_id }),
      ),
    );
    expect(finalizeResp.status).toBe(200);
    const finalizeJson = (await finalizeResp.json()) as {
      attachment: Record<string, unknown>;
    };

    expect(finalizeJson.attachment.id).toBe(attId);
    expect(finalizeJson.attachment.status).toBe(
      expectedFinalize.attachment.status,
    );
    expect(finalizeJson.attachment.status).toBe('ready');
    expect(finalizeJson.attachment.url).toBe(`/api/attachments/${attId}/download`);
    expect(finalizeJson.attachment.task_id).toBe(
      expectedFinalize.attachment.task_id,
    );
    expect(finalizeJson.attachment.filename).toBe(
      expectedFinalize.attachment.filename,
    );
    expect(finalizeJson.attachment.content_type).toBe(
      expectedFinalize.attachment.content_type,
    );
    expect(finalizeJson.attachment.size_bytes).toBe(
      expectedFinalize.attachment.size_bytes,
    );
    expect(finalizeJson.attachment.created_by).toBe(FIXTURE_ACTOR_ID);
    expect(finalizeJson.attachment.created_at).toMatch(ISO_DATETIME_RE);

    // ── step 4: attachment.get ─────────────────────────────────────────
    const expectedGet = readFixture(
      'attachment-get-happy.res.json',
    ) as { attachment: Record<string, unknown> };

    const getResp = await app.fetch(
      new Request(`http://test/api/attachments/${attId}`, {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(getResp.status).toBe(200);
    const getJson = (await getResp.json()) as {
      attachment: Record<string, unknown>;
    };

    expect(getJson.attachment.id).toBe(attId);
    expect(getJson.attachment.status).toBe(expectedGet.attachment.status);
    expect(getJson.attachment.url).toBe(`/api/attachments/${attId}/download`);
    expect(getJson.attachment.filename).toBe(expectedGet.attachment.filename);
    expect(getJson.attachment.task_id).toBe(expectedGet.attachment.task_id);
    expect(getJson.attachment.created_by).toBe(FIXTURE_ACTOR_ID);

    // ── step 5: attachment.list ────────────────────────────────────────
    const expectedList = readFixture(
      'attachment-list-happy.res.json',
    ) as { attachments: Array<Record<string, unknown>> };

    const listResp = await app.fetch(
      new Request(
        `http://test/api/tasks/${FIXTURE_TASK_ID}/attachments`,
        { headers: { authorization: `Bearer ${FIXTURE_TOKEN}` } },
      ),
    );
    expect(listResp.status).toBe(200);
    const listJson = (await listResp.json()) as {
      attachments: Array<Record<string, unknown>>;
    };

    expect(listJson.attachments).toHaveLength(expectedList.attachments.length);
    expect(listJson.attachments).toHaveLength(1);
    const listedAtt = listJson.attachments[0]!;
    expect(listedAtt.id).toBe(attId);
    expect(listedAtt.status).toBe('ready');
    expect(listedAtt.url).toBe(`/api/attachments/${attId}/download`);
    expect(listedAtt.filename).toBe(expectedList.attachments[0]!.filename);
    expect(listedAtt.task_id).toBe(FIXTURE_TASK_ID);
    expect(listedAtt.created_by).toBe(FIXTURE_ACTOR_ID);
    expect(listedAtt.created_at).toMatch(ISO_DATETIME_RE);
  });

  it('attachment.create_upload is idempotent via operation_id', async () => {
    const app = buildTestApp();
    await seedFixtureTask();
    const req = readFixture(
      'attachment-create-upload-happy.req.json',
    ) as Record<string, unknown>;

    const first = await app.fetch(
      new Request('http://test/api/attachments', bearer(req)),
    );
    expect(first.status).toBe(201);
    const firstJson = (await first.json()) as {
      attachment: { id: string };
      upload_url: string;
    };

    const second = await app.fetch(
      new Request('http://test/api/attachments', bearer(req)),
    );
    expect(second.status).toBe(201);
    const secondJson = (await second.json()) as {
      attachment: { id: string };
      upload_url: string;
    };

    // Idempotent replay returns the same attachment id and upload_url.
    expect(secondJson.attachment.id).toBe(firstJson.attachment.id);
    expect(secondJson.upload_url).toBe(firstJson.upload_url);
  });

  it('MCP attachment.create_upload and attachment.get return structured content', async () => {
    const app = buildTestApp();
    await seedFixtureTask();
    const req = readFixture(
      'attachment-create-upload-happy.req.json',
    ) as Record<string, unknown>;

    const createResp = await app.fetch(
      new Request(
        'http://test/mcp',
        bearer({
          jsonrpc: '2.0',
          id: 600,
          method: 'tools/call',
          params: { name: 'sprino.attachment.create_upload', arguments: req },
        }),
      ),
    );
    expect(createResp.status).toBe(200);
    const createBody = (await createResp.json()) as {
      result: {
        content: Array<{ type: string; text: string }>;
        structuredContent: {
          attachment: Record<string, unknown>;
          upload_url: string;
        };
      };
    };
    const sc = createBody.result.structuredContent;
    expect(sc.attachment.status).toBe('pending');
    expect(sc.attachment.task_id).toBe(FIXTURE_TASK_ID);
    expect(sc.upload_url).toMatch(/^\/api\/attachments\/.+\/upload$/);
    expect(createBody.result.content[0]?.text).toBe(JSON.stringify(sc));

    const attId = sc.attachment.id as string;

    const getResp = await app.fetch(
      new Request(
        'http://test/mcp',
        bearer({
          jsonrpc: '2.0',
          id: 601,
          method: 'tools/call',
          params: {
            name: 'sprino.attachment.get',
            arguments: { attachment_id: attId },
          },
        }),
      ),
    );
    expect(getResp.status).toBe(200);
    const getBody = (await getResp.json()) as {
      result: {
        structuredContent: { attachment: Record<string, unknown> };
      };
    };
    expect(getBody.result.structuredContent.attachment.id).toBe(attId);
    expect(getBody.result.structuredContent.attachment.status).toBe('pending');
  });
});

// ────────────────────────────────────────────────────────────────────────
// Tessera C5 — project.create conformance (v0.1.5)
// ────────────────────────────────────────────────────────────────────────

describe('Tessera C5 — project.create (v0.1.5)', () => {
  it('project-create-happy: POST /api/projects creates a project', async () => {
    const app = buildTestApp();
    const req = readFixture('project-create-happy.req.json') as {
      operation_id: string;
      slug: string;
      display_name: string;
      repo_path: string | null;
    };
    const expectedRes = readFixture('project-create-happy.res.json') as {
      project: Record<string, unknown>;
    };

    const resp = await app.fetch(
      new Request('http://test/api/projects', bearer(req)),
    );
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as { project: Record<string, unknown> };

    expect(body.project.slug).toBe(expectedRes.project.slug);
    expect(body.project.display_name).toBe(expectedRes.project.display_name);
    expect(body.project.repo_path).toBe(expectedRes.project.repo_path);
    expect(body.project.id).toMatch(UUID_RE);
    expect(body.project.created_at).toMatch(ISO_DATETIME_RE);
  });

  it('project-create-operation-replay: same operation_id returns cached response', async () => {
    const app = buildTestApp();
    const req = readFixture('project-create-operation-replay.req.json');

    const first = await app.fetch(
      new Request('http://test/api/projects', bearer(req)),
    );
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { project: Record<string, unknown> };

    const second = await app.fetch(
      new Request('http://test/api/projects', bearer(req)),
    );
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { project: Record<string, unknown> };

    expect(secondBody.project.id).toBe(firstBody.project.id);
    expect(secondBody.project.slug).toBe(firstBody.project.slug);
    expect(secondBody.project.created_at).toBe(firstBody.project.created_at);
  });

  it('project-create-slug-conflict: duplicate slug returns 409 slug_conflict', async () => {
    const app = buildTestApp();
    const req = readFixture('project-create-slug-conflict.req.json') as {
      slug: string;
    };
    const expectedRes = readFixture('project-create-slug-conflict.res.json') as {
      _error: { status: number; code: string; details: { slug: string } };
    };

    // slug 'sprino' is seeded by the test harness (FIXTURE_PROJECT_ID)
    const resp = await app.fetch(
      new Request('http://test/api/projects', bearer(req)),
    );
    expect(resp.status).toBe(expectedRes._error.status);
    expect(resp.status).toBe(409);
    const body = (await resp.json()) as { error: string; slug: string };
    expect(body.error).toBe('slug_conflict');
    expect(body.slug).toBe(req.slug);
  });

  it('project-create-validation-error: invalid slug returns 400', async () => {
    const app = buildTestApp();
    const req = readFixture('project-create-validation-error.req.json');
    const expectedRes = readFixture(
      'project-create-validation-error.res.json',
    ) as { _error: { status: number; code: string } };

    const resp = await app.fetch(
      new Request('http://test/api/projects', bearer(req)),
    );
    expect(resp.status).toBe(expectedRes._error.status);
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });
});
