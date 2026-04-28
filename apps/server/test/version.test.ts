/**
 * Stream 4B: optimistic concurrency tests for task.update_status.
 *
 * The mechanism (version column, if_match check, SELECT FOR UPDATE,
 * VersionMismatchError → 409 with current task in body) was implemented
 * in earlier weeks. This file is the explicit conformance harness:
 *
 *  1) happy path: matching if_match returns 200, version increments.
 *  2) stale if_match: 409 with `task` body carrying current state.
 *  3) missing if_match: 400 (Zod validation).
 *  4) sequential retry: stale → re-fetch → retry with fresh version → 200.
 *
 *  The 4-actor concurrent race lives in events.test.ts — this file
 *  deliberately covers the *single-client* version semantics so a
 *  regression in either surface is caught independently.
 */

import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db/client.ts';
import { VersionMismatchError, createTask, updateTaskStatus } from '../src/service/tasks.ts';
import {
  FIXTURE_ACTOR_ID,
  FIXTURE_PROJECT_ID,
  FIXTURE_TOKEN,
  buildTestApp,
} from './setup.ts';

async function newTask(): Promise<{ taskId: string; version: number }> {
  const res = await createTask(db, {
    req: {
      operation_id: uuidv7(),
      project_id: FIXTURE_PROJECT_ID,
      title: 'version test target',
    },
    actorId: FIXTURE_ACTOR_ID,
  });
  return { taskId: res.task.id, version: res.task.version };
}

describe('task.update_status: version + if_match (HTTP)', () => {
  it('happy path — matching if_match returns 200, version increments to 2', async () => {
    const { taskId } = await newTask();
    const app = buildTestApp();
    const res = await app.fetch(
      new Request(`http://test/api/tasks/${taskId}/status`, {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${FIXTURE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          operation_id: uuidv7(),
          status: 'doing',
          if_match: 1,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: { version: number; status: string } };
    expect(body.task.version).toBe(2);
    expect(body.task.status).toBe('doing');
  });

  it('stale if_match — returns 409 with current task in body', async () => {
    const { taskId } = await newTask();
    const app = buildTestApp();

    // First update succeeds, bumping version to 2.
    await app.fetch(
      new Request(`http://test/api/tasks/${taskId}/status`, {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${FIXTURE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          operation_id: uuidv7(),
          status: 'doing',
          if_match: 1,
        }),
      }),
    );

    // Second update with stale if_match=1 (server is at version=2).
    const stale = await app.fetch(
      new Request(`http://test/api/tasks/${taskId}/status`, {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${FIXTURE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          operation_id: uuidv7(),
          status: 'done',
          if_match: 1,
        }),
      }),
    );
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as {
      error: string;
      task: { id: string; version: number; status: string };
    };
    expect(body.error).toBe('version_mismatch');
    expect(body.task.id).toBe(taskId);
    expect(body.task.version).toBe(2);
    expect(body.task.status).toBe('doing');
  });

  it('missing if_match — returns 400 (Zod validation)', async () => {
    const { taskId } = await newTask();
    const app = buildTestApp();
    const res = await app.fetch(
      new Request(`http://test/api/tasks/${taskId}/status`, {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${FIXTURE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          operation_id: uuidv7(),
          status: 'doing',
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });

  it('sequential retry — stale → re-read → retry with fresh version succeeds', async () => {
    const { taskId } = await newTask();
    const app = buildTestApp();

    // Race partner A updates first.
    await app.fetch(
      new Request(`http://test/api/tasks/${taskId}/status`, {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${FIXTURE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          operation_id: uuidv7(),
          status: 'doing',
          if_match: 1,
        }),
      }),
    );

    // Client B is still holding stale version=1; first attempt fails 409.
    const failed = await app.fetch(
      new Request(`http://test/api/tasks/${taskId}/status`, {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${FIXTURE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          operation_id: uuidv7(),
          status: 'done',
          if_match: 1,
        }),
      }),
    );
    expect(failed.status).toBe(409);
    const failedBody = (await failed.json()) as { task: { version: number } };
    const freshVersion = failedBody.task.version;
    expect(freshVersion).toBe(2);

    // Client B retries with the fresh version it just learned about.
    const retry = await app.fetch(
      new Request(`http://test/api/tasks/${taskId}/status`, {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${FIXTURE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          operation_id: uuidv7(),
          status: 'done',
          if_match: freshVersion,
        }),
      }),
    );
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as { task: { version: number; status: string } };
    expect(retryBody.task.version).toBe(3);
    expect(retryBody.task.status).toBe('done');
  });
});

describe('task.update_status: version + if_match (service)', () => {
  it('rejects an if_match=0 via the service version check', async () => {
    const { taskId } = await newTask();
    // This call goes through the service directly, not the HTTP/Zod
    // boundary, so we assert that if_match=0 is rejected by the service's
    // version mismatch check — and specifically by VersionMismatchError
    // (not some unrelated failure like TaskNotFoundError or DB connectivity).
    await expect(
      updateTaskStatus(db, {
        req: {
          operation_id: uuidv7(),
          task_id: taskId,
          status: 'doing',
          if_match: 0,
        },
        actorId: FIXTURE_ACTOR_ID,
      }),
    ).rejects.toThrow(VersionMismatchError);
  });
});
