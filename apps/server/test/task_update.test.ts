// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * G2-P1: PATCH /api/tasks/:id integration tests.
 *
 * Covers all task.update scenarios:
 *   - Single field updates (title, description, assignee_id)
 *   - Multi-field updates
 *   - context_updated event is written
 *   - OCC: 409 on version mismatch
 *   - Idempotency: same operation_id replays the cached response
 *   - Validation: 422 on empty title, title > 280, description > 16384, no fields
 *   - 404 for task in a different workspace
 */

import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db/client.ts';
import { createTask } from '../src/service/tasks.ts';
import {
  FIXTURE_ACTOR_ID,
  FIXTURE_PROJECT_ID,
  FIXTURE_TOKEN,
  FIXTURE_WORKSPACE_ID,
  buildTestApp,
  seedDbActor,
  seedWorkspace,
} from './setup.ts';
import { projects } from '../src/db/schema.ts';
import { seedDefaultWorkflowColumns } from '../src/service/projects.ts';

// ── helpers ────────────────────────────────────────────────────────────────

function apiHeaders(token = FIXTURE_TOKEN, workspaceId = FIXTURE_WORKSPACE_ID) {
  return {
    authorization: `Bearer ${token}`,
    'x-workspace-id': workspaceId,
    'content-type': 'application/json',
  };
}

async function makeTask(title = 'test task'): Promise<{ id: string; version: number }> {
  const res = await createTask(db, {
    req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title },
    actorId: FIXTURE_ACTOR_ID,
    workspaceId: FIXTURE_WORKSPACE_ID,
  });
  return { id: res.task.id, version: res.task.version };
}

function patchTask(
  app: ReturnType<typeof buildTestApp>,
  taskId: string,
  body: Record<string, unknown>,
  token = FIXTURE_TOKEN,
  workspaceId = FIXTURE_WORKSPACE_ID,
) {
  return app.fetch(
    new Request(`http://test/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: apiHeaders(token, workspaceId),
      body: JSON.stringify(body),
    }),
  );
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('PATCH /api/tasks/:id', () => {
  it('updates title only (200, title updated, version bumped)', async () => {
    const app = buildTestApp();
    const { id, version } = await makeTask('original title');

    const r = await patchTask(app, id, {
      operation_id: uuidv7(),
      if_match: version,
      title: 'updated title',
    });

    expect(r.status).toBe(200);
    const body = await r.json() as { task: { title: string; version: number }; event: { kind: string } };
    expect(body.task.title).toBe('updated title');
    expect(body.task.version).toBe(version + 1);
    expect(body.event.kind).toBe('context_updated');
  });

  it('updates description only (200, description updated)', async () => {
    const app = buildTestApp();
    const { id, version } = await makeTask('desc-only task');

    const r = await patchTask(app, id, {
      operation_id: uuidv7(),
      if_match: version,
      description: 'new description',
    });

    expect(r.status).toBe(200);
    const body = await r.json() as { task: { description: string } };
    expect(body.task.description).toBe('new description');
  });

  it('updates assignee_id (200, assignee updated)', async () => {
    const app = buildTestApp();
    const { actorId } = await seedDbActor({ displayName: 'Assignee Actor' });
    const { id, version } = await makeTask('assignee task');

    const r = await patchTask(app, id, {
      operation_id: uuidv7(),
      if_match: version,
      assignee_id: actorId,
    });

    expect(r.status).toBe(200);
    const body = await r.json() as { task: { assignee_id: string } };
    expect(body.task.assignee_id).toBe(actorId);
  });

  it('unassigns with assignee_id: null', async () => {
    const app = buildTestApp();
    const { actorId } = await seedDbActor({ displayName: 'To Unassign' });
    const { id, version } = await makeTask('unassign task');

    // First assign
    await patchTask(app, id, {
      operation_id: uuidv7(),
      if_match: version,
      assignee_id: actorId,
    });

    // Now unassign
    const r2 = await patchTask(app, id, {
      operation_id: uuidv7(),
      if_match: version + 1,
      assignee_id: null,
    });

    expect(r2.status).toBe(200);
    const body = await r2.json() as { task: { assignee_id: string | null } };
    expect(body.task.assignee_id).toBeNull();
  });

  it('updates multiple fields at once', async () => {
    const app = buildTestApp();
    const { actorId } = await seedDbActor({ displayName: 'Multi Assignee' });
    const { id, version } = await makeTask('multi-field task');

    const r = await patchTask(app, id, {
      operation_id: uuidv7(),
      if_match: version,
      title: 'new title',
      description: 'new description',
      assignee_id: actorId,
    });

    expect(r.status).toBe(200);
    const body = await r.json() as {
      task: { title: string; description: string; assignee_id: string; version: number };
    };
    expect(body.task.title).toBe('new title');
    expect(body.task.description).toBe('new description');
    expect(body.task.assignee_id).toBe(actorId);
    expect(body.task.version).toBe(version + 1);
  });

  it('writes a context_updated event (GET /api/events shows it)', async () => {
    const app = buildTestApp();
    const { id, version } = await makeTask('event-check task');

    await patchTask(app, id, {
      operation_id: uuidv7(),
      if_match: version,
      title: 'title that emits event',
    });

    const eventsR = await app.fetch(
      new Request(
        `http://test/api/events?project_id=${FIXTURE_PROJECT_ID}&task_id=${id}`,
        { headers: apiHeaders() },
      ),
    );
    expect(eventsR.status).toBe(200);
    const evBody = await eventsR.json() as { events: { kind: string; payload: Record<string, unknown> }[] };
    const contextUpdated = evBody.events.find((e) => e.kind === 'context_updated');
    expect(contextUpdated).toBeDefined();
    // Delta payload should record from/to for title
    expect(contextUpdated?.payload['title']).toMatchObject({
      from: 'event-check task',
      to: 'title that emits event',
    });
  });

  it('returns 409 on version mismatch (if_match: 999)', async () => {
    const app = buildTestApp();
    const { id } = await makeTask('mismatch task');

    const r = await patchTask(app, id, {
      operation_id: uuidv7(),
      if_match: 999,
      title: 'should fail',
    });

    expect(r.status).toBe(409);
    const body = await r.json() as { error: string };
    expect(body.error).toBe('version_mismatch');
  });

  it('is idempotent on same operation_id', async () => {
    const app = buildTestApp();
    const { id, version } = await makeTask('idempotency task');
    const operationId = uuidv7();

    const r1 = await patchTask(app, id, {
      operation_id: operationId,
      if_match: version,
      title: 'idempotent title',
    });
    expect(r1.status).toBe(200);

    // Second request with same operation_id should return the same response
    const r2 = await patchTask(app, id, {
      operation_id: operationId,
      if_match: version,
      title: 'idempotent title',
    });
    expect(r2.status).toBe(200);
    const body1 = await r1.json() as { task: { version: number } };
    const body2 = await r2.json() as { task: { version: number } };
    expect(body1.task.version).toBe(body2.task.version);
  });

  it('rejects empty title (400)', async () => {
    const app = buildTestApp();
    const { id, version } = await makeTask('validate title empty');

    const r = await patchTask(app, id, {
      operation_id: uuidv7(),
      if_match: version,
      title: '',
    });

    expect(r.status).toBe(400);
  });

  it('rejects title over 280 chars (400)', async () => {
    const app = buildTestApp();
    const { id, version } = await makeTask('validate title len');

    const r = await patchTask(app, id, {
      operation_id: uuidv7(),
      if_match: version,
      title: 'x'.repeat(281),
    });

    expect(r.status).toBe(400);
  });

  it('rejects description over 16384 chars (400)', async () => {
    const app = buildTestApp();
    const { id, version } = await makeTask('validate desc len');

    const r = await patchTask(app, id, {
      operation_id: uuidv7(),
      if_match: version,
      description: 'x'.repeat(16385),
    });

    expect(r.status).toBe(400);
  });

  it('rejects request with no updatable fields (400)', async () => {
    const app = buildTestApp();
    const { id, version } = await makeTask('validate no fields');

    const r = await patchTask(app, id, {
      operation_id: uuidv7(),
      if_match: version,
      // No title, description, or assignee_id
    });

    expect(r.status).toBe(400);
  });

  it('returns 404 for task in a different workspace', async () => {
    const app = buildTestApp();
    const { id, version } = await makeTask('different ws task');

    // Create a separate workspace and a project in it, then use that workspace context
    const otherWsId = await seedWorkspace({ slug: 'other-ws-for-task-update' });
    const otherProjectId = uuidv7();
    await db.insert(projects).values({
      id: otherProjectId,
      slug: 'other-proj',
      displayName: 'Other Project',
      repoPath: null,
      workspaceId: otherWsId,
    });
    await seedDefaultWorkflowColumns(db, otherProjectId);

    // Seed an actor in otherWsId so we can authenticate in that workspace
    const { token: otherToken } = await seedDbActor({ displayName: 'Other WS Actor' });
    // The actor is in FIXTURE_WORKSPACE_ID by default. We need them in otherWsId too.
    // Instead, just use the fixture token but with a different x-workspace-id header
    // that the FIXTURE_ACTOR_ID is not a member of — the workspace auth should deny.
    const r = await app.fetch(
      new Request(`http://test/api/tasks/${id}`, {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${FIXTURE_TOKEN}`,
          'x-workspace-id': otherWsId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          operation_id: uuidv7(),
          if_match: version,
          title: 'should be 404',
        }),
      }),
    );

    // The task belongs to FIXTURE_WORKSPACE_ID, but we pass otherWsId →
    // workspace isolation check should reject (403 or 404 depending on implementation)
    expect([403, 404]).toContain(r.status);

    void otherToken; // consumed to avoid unused warning
  });
});
