// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Stream 3B: event-log integration tests.
 *
 * Covers two things:
 *   1) Concurrent updateTaskStatus from 4 actors → exactly one winner, three
 *      VersionMismatch losers, no torn writes. The winning event is logged;
 *      losers do NOT write events (failed updates throw before commit, so
 *      the event row rolls back with the rest of the tx).
 *   2) GET /api/events shape — joined with actor.display_name + actor.kind
 *      and task.title; project-scoped, ordered desc by created_at; 401 on
 *      missing auth; supports task_id filter and limit/offset.
 *
 *  Why integration (not pure unit): the version-check + lock semantics
 *  ONLY hold under a real Postgres transaction. Mocking Drizzle would test
 *  nothing useful.
 */

import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db/client.ts';
import { actors } from '../src/db/schema.ts';
import { createTask, updateTaskStatus, VersionMismatchError } from '../src/service/tasks.ts';
import { listEvents } from '../src/service/events.ts';
import {
  FIXTURE_ACTOR_ID,
  FIXTURE_PROJECT_ID,
  FIXTURE_TOKEN,
  FIXTURE_WORKSPACE_ID,
  buildTestApp,
} from './setup.ts';

async function seedAgent(id: string, displayName: string): Promise<void> {
  await db.insert(actors).values({
    id,
    kind: 'agent',
    displayName,
    agentRuntime: 'test-runtime',
    parentActorId: FIXTURE_ACTOR_ID,
  });
}

async function createOneTask(
  title = 'race target',
): Promise<{ id: string; version: number }> {
  const res = await createTask(db, {
    req: {
      operation_id: uuidv7(),
      project_id: FIXTURE_PROJECT_ID,
      title,
    },
    actorId: FIXTURE_ACTOR_ID,
    workspaceId: FIXTURE_WORKSPACE_ID,
  });
  return { id: res.task.id, version: res.task.version };
}

describe('events: 4-actor concurrent updateTaskStatus race', () => {
  it('selects exactly one winner, rejects three with VersionMismatch, logs only the winner', async () => {
    const agentIds = [
      '018c3e7a-0001-7000-8000-000000000a01',
      '018c3e7a-0001-7000-8000-000000000a02',
      '018c3e7a-0001-7000-8000-000000000a03',
    ];
    await Promise.all(
      agentIds.map((id, i) => seedAgent(id, `Agent ${i + 1}`)),
    );
    const allActorIds = [FIXTURE_ACTOR_ID, ...agentIds];

    const { id: taskId, version } = await createOneTask();
    expect(version).toBe(1);

    // All four actors race to mark the task as 'doing' from version=1.
    // Postgres SELECT ... FOR UPDATE inside service/tasks.ts serializes them.
    const results = await Promise.allSettled(
      allActorIds.map((actorId, i) =>
        updateTaskStatus(db, {
          req: {
            operation_id: uuidv7(),
            task_id: taskId,
            // Vary the target status so a winner is observable in the final state.
            // todo→doing, then any subsequent must fail because version moved to 2.
            status: i === 0 ? 'doing' : 'done',
            if_match: 1,
          },
          actorId,
          workspaceId: FIXTURE_WORKSPACE_ID,
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(3);

    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(
        VersionMismatchError,
      );
    }

    // Event log should have exactly two events for this task: created + the
    // single winning status_changed. The three losers rolled back.
    const { events: list } = await listEvents(db, {
      req: { project_id: FIXTURE_PROJECT_ID, task_id: taskId },
    });
    expect(list.length).toBe(2);
    const kinds = list.map((e) => e.kind).sort();
    expect(kinds).toEqual(['created', 'status_changed']);

    // Task is now at version=2 — no torn write where two updates both
    // incremented version.
    const winner = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof updateTaskStatus>>>).value;
    expect(winner.task.version).toBe(2);
  });
});

describe('events: listEvents service', () => {
  it('returns project-scoped events ordered newest-first with actor + task fields denormalized', async () => {
    const { id: taskId } = await createOneTask('listEvents target');

    await updateTaskStatus(db, {
      req: {
        operation_id: uuidv7(),
        task_id: taskId,
        status: 'doing',
        if_match: 1,
      },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });

    const { events: list } = await listEvents(db, {
      req: { project_id: FIXTURE_PROJECT_ID },
    });

    expect(list.length).toBe(2);
    expect(list[0]!.kind).toBe('status_changed'); // newest first
    expect(list[1]!.kind).toBe('created');
    for (const e of list) {
      expect(e.actor.display_name).toBe('Leonardo');
      expect(e.actor.kind).toBe('human');
      expect(e.task.title).toBe('listEvents target');
    }
  });

  it('respects task_id filter', async () => {
    const a = await createOneTask('task A');
    const b = await createOneTask('task B');

    const { events: onlyA } = await listEvents(db, {
      req: { project_id: FIXTURE_PROJECT_ID, task_id: a.id },
    });
    expect(onlyA.length).toBe(1);
    expect(onlyA[0]!.task_id).toBe(a.id);

    const { events: all } = await listEvents(db, {
      req: { project_id: FIXTURE_PROJECT_ID },
    });
    expect(all.length).toBe(2);
    expect(new Set(all.map((e) => e.task_id))).toEqual(new Set([a.id, b.id]));
  });

  it('respects limit + offset for pagination', async () => {
    await createOneTask('p1');
    await createOneTask('p2');
    await createOneTask('p3');

    const { events: page1 } = await listEvents(db, {
      req: { project_id: FIXTURE_PROJECT_ID, limit: 2, offset: 0 },
    });
    const { events: page2 } = await listEvents(db, {
      req: { project_id: FIXTURE_PROJECT_ID, limit: 2, offset: 2 },
    });

    expect(page1.length).toBe(2);
    expect(page2.length).toBe(1);
    // Pages don't overlap.
    const ids = new Set([...page1, ...page2].map((e) => e.id));
    expect(ids.size).toBe(3);
  });
});

describe('GET /api/events endpoint', () => {
  it('returns 401 without Authorization', async () => {
    const app = buildTestApp();
    const res = await app.fetch(
      new Request(
        `http://t/api/events?project_id=${FIXTURE_PROJECT_ID}`,
        { method: 'GET' },
      ),
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 when project_id is missing or malformed', async () => {
    const app = buildTestApp();
    const noProject = await app.fetch(
      new Request('http://t/api/events', {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(noProject.status).toBe(400);

    const badProject = await app.fetch(
      new Request('http://t/api/events?project_id=not-a-uuid', {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(badProject.status).toBe(400);
  });

  it('returns 200 with denormalized actor + task fields', async () => {
    await createOneTask('endpoint target');
    const app = buildTestApp();

    const res = await app.fetch(
      new Request(
        `http://t/api/events?project_id=${FIXTURE_PROJECT_ID}`,
        { headers: { authorization: `Bearer ${FIXTURE_TOKEN}` } },
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<{
        kind: string;
        actor: { display_name: string; kind: string };
        task: { title: string };
      }>;
    };
    expect(body.events.length).toBe(1);
    expect(body.events[0]!.kind).toBe('created');
    expect(body.events[0]!.actor.display_name).toBe('Leonardo');
    expect(body.events[0]!.actor.kind).toBe('human');
    expect(body.events[0]!.task.title).toBe('endpoint target');
  });

  it('rejects limit > 1000 via Zod', async () => {
    const app = buildTestApp();
    const res = await app.fetch(
      new Request(
        `http://t/api/events?project_id=${FIXTURE_PROJECT_ID}&limit=1001`,
        { headers: { authorization: `Bearer ${FIXTURE_TOKEN}` } },
      ),
    );
    expect(res.status).toBe(400);
  });

  it('accepts limit at the max boundary (1000)', async () => {
    const app = buildTestApp();
    const res = await app.fetch(
      new Request(
        `http://t/api/events?project_id=${FIXTURE_PROJECT_ID}&limit=1000`,
        { headers: { authorization: `Bearer ${FIXTURE_TOKEN}` } },
      ),
    );
    expect(res.status).toBe(200);
  });
});
