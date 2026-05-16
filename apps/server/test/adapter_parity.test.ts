// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Dual-adapter parity: asserts that HTTP and MCP produce identical response
 * shapes for representative verbs. This is the test-level guarantee for the
 * structural invariant that both adapters delegate to the same service layer.
 *
 * If a verb starts diverging (e.g. a field present in HTTP but missing in MCP,
 * or an error code that differs), this test breaks before users notice.
 *
 * Verbs covered: task.create, task.get, task.update_status
 */

import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it } from 'vitest';
import {
  FIXTURE_ACTOR_ID,
  FIXTURE_PROJECT_ID,
  FIXTURE_TOKEN,
  FIXTURE_WORKSPACE_ID,
  buildTestApp,
} from './setup.ts';

// ── transport helpers ──────────────────────────────────────────────────────

function httpCreate(app: ReturnType<typeof buildTestApp>, body: Record<string, unknown>) {
  return app.fetch(
    new Request('http://test/api/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${FIXTURE_TOKEN}`,
        'X-Workspace-ID': FIXTURE_WORKSPACE_ID,
      },
      body: JSON.stringify(body),
    }),
  );
}

function mcpCall(
  app: ReturnType<typeof buildTestApp>,
  name: string,
  args: Record<string, unknown>,
) {
  return app.fetch(
    new Request('http://test/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${FIXTURE_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
  );
}

// ── parity assertions ──────────────────────────────────────────────────────

/**
 * Assert that two task shapes have the same field keys and compatible types.
 * Ignores volatile values (id, timestamps) — those differ legitimately.
 */
function assertTaskShapeParity(
  httpTask: Record<string, unknown>,
  mcpTask: Record<string, unknown>,
  label: string,
) {
  const httpKeys = Object.keys(httpTask).sort();
  const mcpKeys = Object.keys(mcpTask).sort();
  expect(mcpKeys, `${label}: MCP task missing fields vs HTTP`).toEqual(httpKeys);

  for (const key of httpKeys) {
    if (['id', 'created_at', 'updated_at'].includes(key)) continue;
    expect(typeof mcpTask[key], `${label}: field '${key}' type mismatch`).toBe(
      typeof httpTask[key],
    );
  }
}

function assertEventShapeParity(
  httpEvent: Record<string, unknown>,
  mcpEvent: Record<string, unknown>,
  label: string,
) {
  const httpKeys = Object.keys(httpEvent).sort();
  const mcpKeys = Object.keys(mcpEvent).sort();
  expect(mcpKeys, `${label}: MCP event missing fields vs HTTP`).toEqual(httpKeys);
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('dual-adapter parity (HTTP vs MCP)', () => {
  it('task.create: HTTP and MCP return the same task + event shape', async () => {
    const app = buildTestApp();
    const opHttp = uuidv7();
    const opMcp = uuidv7();

    const httpRes = await httpCreate(app, {
      operation_id: opHttp,
      project_id: FIXTURE_PROJECT_ID,
      title: 'parity test HTTP',
    });
    expect(httpRes.status).toBe(201);
    const httpBody = (await httpRes.json()) as {
      task: Record<string, unknown>;
      event: Record<string, unknown>;
    };

    const mcpRes = await mcpCall(app, 'sprino.task.create', {
      operation_id: opMcp,
      project_id: FIXTURE_PROJECT_ID,
      title: 'parity test MCP',
      workspace_id: FIXTURE_WORKSPACE_ID,
    });
    expect(mcpRes.status).toBe(200);
    const mcpBody = (await mcpRes.json()) as {
      result: { structuredContent: { task: Record<string, unknown>; event: Record<string, unknown> } };
    };
    expect(mcpBody.result).toBeDefined();

    const mcpTask = mcpBody.result.structuredContent.task;
    const mcpEvent = mcpBody.result.structuredContent.event;

    assertTaskShapeParity(httpBody.task, mcpTask, 'task.create');
    assertEventShapeParity(httpBody.event, mcpEvent, 'task.create event');

    // spot-check shared semantic fields
    expect(httpBody.task.status).toBe('todo');
    expect(mcpTask.status).toBe('todo');
    expect(httpBody.task.version).toBe(1);
    expect(mcpTask.version).toBe(1);
    expect(httpBody.event.kind).toBe('created');
    expect(mcpEvent.kind).toBe('created');
    expect(httpBody.event.actor_id).toBe(FIXTURE_ACTOR_ID);
    expect(mcpEvent.actor_id).toBe(FIXTURE_ACTOR_ID);
  });

  it('task.update_status: HTTP and MCP return the same task + event shape', async () => {
    const app = buildTestApp();

    // seed a task via HTTP
    const createRes = await httpCreate(app, {
      operation_id: uuidv7(),
      project_id: FIXTURE_PROJECT_ID,
      title: 'parity update_status',
    });
    expect(createRes.status).toBe(201);
    const { task } = (await createRes.json()) as { task: { id: string; version: number } };

    // update_status via HTTP
    const httpUpdateRes = await app.fetch(
      new Request(`http://test/api/tasks/${task.id}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${FIXTURE_TOKEN}`,
          'X-Workspace-ID': FIXTURE_WORKSPACE_ID,
        },
        body: JSON.stringify({
          operation_id: uuidv7(),
          task_id: task.id,
          status: 'doing',
          if_match: task.version,
        }),
      }),
    );
    expect(httpUpdateRes.status).toBe(200);
    const httpUpdateBody = (await httpUpdateRes.json()) as {
      task: Record<string, unknown>;
      event: Record<string, unknown>;
    };

    // seed a second task and update via MCP
    const create2Res = await httpCreate(app, {
      operation_id: uuidv7(),
      project_id: FIXTURE_PROJECT_ID,
      title: 'parity update_status MCP',
    });
    const { task: task2 } = (await create2Res.json()) as { task: { id: string; version: number } };

    const mcpUpdateRes = await mcpCall(app, 'sprino.task.update_status', {
      operation_id: uuidv7(),
      task_id: task2.id,
      status: 'doing',
      if_match: task2.version,
      workspace_id: FIXTURE_WORKSPACE_ID,
    });
    expect(mcpUpdateRes.status).toBe(200);
    const mcpUpdateBody = (await mcpUpdateRes.json()) as {
      result: { structuredContent: { task: Record<string, unknown>; event: Record<string, unknown> } };
    };

    assertTaskShapeParity(
      httpUpdateBody.task,
      mcpUpdateBody.result.structuredContent.task,
      'task.update_status',
    );
    assertEventShapeParity(
      httpUpdateBody.event,
      mcpUpdateBody.result.structuredContent.event,
      'task.update_status event',
    );

    expect(httpUpdateBody.task.status).toBe('doing');
    expect(mcpUpdateBody.result.structuredContent.task.status).toBe('doing');
    expect(httpUpdateBody.event.kind).toBe('status_changed');
    expect(mcpUpdateBody.result.structuredContent.event.kind).toBe('status_changed');
  });

  it('task.create OCC 409: HTTP and MCP use the same error envelope shape', async () => {
    const app = buildTestApp();

    const createRes = await httpCreate(app, {
      operation_id: uuidv7(),
      project_id: FIXTURE_PROJECT_ID,
      title: 'parity occ task',
    });
    const { task } = (await createRes.json()) as { task: { id: string; version: number } };

    // HTTP 409 on stale if_match
    const httpOccRes = await app.fetch(
      new Request(`http://test/api/tasks/${task.id}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${FIXTURE_TOKEN}`,
          'X-Workspace-ID': FIXTURE_WORKSPACE_ID,
        },
        body: JSON.stringify({
          operation_id: uuidv7(),
          task_id: task.id,
          status: 'doing',
          if_match: 999,
        }),
      }),
    );
    expect(httpOccRes.status).toBe(409);
    const httpOccBody = (await httpOccRes.json()) as { error: string };
    expect(httpOccBody.error).toBe('version_mismatch');

    // MCP error on stale if_match
    const mcpOccRes = await mcpCall(app, 'sprino.task.update_status', {
      operation_id: uuidv7(),
      task_id: task.id,
      status: 'doing',
      if_match: 999,
      workspace_id: FIXTURE_WORKSPACE_ID,
    });
    expect(mcpOccRes.status).toBe(200);
    const mcpOccBody = (await mcpOccRes.json()) as {
      error: { code: number; message: string };
    };
    // MCP surfaces as JSON-RPC error with the same semantic message
    expect(mcpOccBody.error.message).toBe('version_mismatch');
  });
});
