// SPDX-License-Identifier: AGPL-3.0-or-later
// D4: Sprint and Iteration Planning — integration tests.
// TDD red phase (P1): imports from schema.ts will fail typecheck until P1 is done.

import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../src/db/client.ts';
import { sprints, sprintTasks, tasks } from '../src/db/schema.ts';
import { createTask, getTask, updateTaskPoints } from '../src/service/tasks.ts';
import {
  createSprint,
  activateSprint,
  closeSprint,
  listSprints,
  getSprint,
  assignToSprint,
  removeFromSprint,
  SprintAlreadyActiveError,
  TaskAlreadyInActiveSprintError,
} from '../src/service/sprints.ts';
import {
  FIXTURE_ACTOR_ID,
  FIXTURE_PROJECT_ID,
  FIXTURE_TOKEN,
  buildTestApp,
} from './setup.ts';

async function makeSprint(name: string): Promise<string> {
  const id = uuidv7();
  await db.insert(sprints).values({
    id,
    projectId: FIXTURE_PROJECT_ID,
    name,
    status: 'planning',
    startsOn: '2026-06-01',
    endsOn: '2026-06-14',
    version: 1,
    createdBy: FIXTURE_ACTOR_ID,
  });
  return id;
}

async function makeTask(title: string): Promise<string> {
  const res = await createTask(db, {
    req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title },
    actorId: FIXTURE_ACTOR_ID,
  });
  return res.task.id;
}

// ── D4-P1: schema persistence ─────────────────────────────────────────────

describe('D4-P1: sprints table exists', () => {
  it('can insert and select a sprint row', async () => {
    const id = await makeSprint('Sprint 1');
    const rows = await db.select().from(sprints).where(eq(sprints.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('Sprint 1');
    expect(rows[0]!.status).toBe('planning');
  });

  it('can link a task to a sprint via sprint_tasks', async () => {
    const sprintId = await makeSprint('Sprint 2');
    const taskId = await makeTask('task for sprint');
    await db.insert(sprintTasks).values({ sprintId, taskId });
    const rows = await db
      .select()
      .from(sprintTasks)
      .where(and(eq(sprintTasks.sprintId, sprintId), eq(sprintTasks.taskId, taskId)));
    expect(rows).toHaveLength(1);
  });

  it('tasks.points column exists and is nullable', async () => {
    const taskId = await makeTask('task with null points');
    const rows = await db.select({ points: tasks.points }).from(tasks).where(eq(tasks.id, taskId));
    expect(rows[0]!.points).toBeNull();
  });
});

// ── D4-P2: service layer ──────────────────────────────────────────────────
// These tests will fail until Task 12 (service/sprints.ts) is implemented.

describe('D4-P2: createSprint + activateSprint', () => {
  it('createSprint inserts a sprint with status planning', async () => {
    const res = await createSprint(db, {
      req: {
        operation_id: uuidv7(),
        project_id: FIXTURE_PROJECT_ID,
        name: 'Sprint A',
        starts_on: '2026-06-01',
        ends_on: '2026-06-14',
      },
      actorId: FIXTURE_ACTOR_ID,
    });
    expect(res.sprint.status).toBe('planning');
    expect(res.sprint.version).toBe(1);
  });

  it('activateSprint transitions planning → active', async () => {
    const created = await createSprint(db, {
      req: {
        operation_id: uuidv7(),
        project_id: FIXTURE_PROJECT_ID,
        name: 'Sprint B',
        starts_on: '2026-05-01',
        ends_on: '2026-05-14',
      },
      actorId: FIXTURE_ACTOR_ID,
    });
    const activated = await activateSprint(db, {
      req: {
        operation_id: uuidv7(),
        sprint_id: created.sprint.id,
        to_status: 'active',
        if_match: 1,
      },
      actorId: FIXTURE_ACTOR_ID,
    });
    expect(activated.sprint.status).toBe('active');
    expect(activated.sprint.version).toBe(2);
  });

  it('activateSprint throws SprintAlreadyActiveError when another sprint is active', async () => {
    const first = await createSprint(db, {
      req: {
        operation_id: uuidv7(),
        project_id: FIXTURE_PROJECT_ID,
        name: 'Sprint C1',
        starts_on: '2026-05-01',
        ends_on: '2026-05-14',
      },
      actorId: FIXTURE_ACTOR_ID,
    });
    await activateSprint(db, {
      req: {
        operation_id: uuidv7(),
        sprint_id: first.sprint.id,
        to_status: 'active',
        if_match: 1,
      },
      actorId: FIXTURE_ACTOR_ID,
    });
    const second = await createSprint(db, {
      req: {
        operation_id: uuidv7(),
        project_id: FIXTURE_PROJECT_ID,
        name: 'Sprint C2',
        starts_on: '2026-05-15',
        ends_on: '2026-05-28',
      },
      actorId: FIXTURE_ACTOR_ID,
    });
    await expect(
      activateSprint(db, {
        req: {
          operation_id: uuidv7(),
          sprint_id: second.sprint.id,
          to_status: 'active',
          if_match: 1,
        },
        actorId: FIXTURE_ACTOR_ID,
      }),
    ).rejects.toThrow(SprintAlreadyActiveError);
  });
});

describe('D4-P2: assignToSprint guards', () => {
  it('assignToSprint inserts a sprint_tasks row', async () => {
    const sprintId = await makeSprint('Sprint D');
    const taskId = await makeTask('task D');
    await assignToSprint(db, {
      req: { operation_id: uuidv7(), sprint_id: sprintId, task_id: taskId },
      actorId: FIXTURE_ACTOR_ID,
    });
    const rows = await db
      .select()
      .from(sprintTasks)
      .where(and(eq(sprintTasks.sprintId, sprintId), eq(sprintTasks.taskId, taskId)));
    expect(rows).toHaveLength(1);
  });

  it('assignToSprint throws TaskAlreadyInActiveSprintError if task is in an active sprint', async () => {
    const created = await createSprint(db, {
      req: {
        operation_id: uuidv7(),
        project_id: FIXTURE_PROJECT_ID,
        name: 'Sprint E',
        starts_on: '2026-05-01',
        ends_on: '2026-05-14',
      },
      actorId: FIXTURE_ACTOR_ID,
    });
    await activateSprint(db, {
      req: {
        operation_id: uuidv7(),
        sprint_id: created.sprint.id,
        to_status: 'active',
        if_match: 1,
      },
      actorId: FIXTURE_ACTOR_ID,
    });
    const taskId = await makeTask('task E');
    await assignToSprint(db, {
      req: { operation_id: uuidv7(), sprint_id: created.sprint.id, task_id: taskId },
      actorId: FIXTURE_ACTOR_ID,
    });
    const second = await createSprint(db, {
      req: {
        operation_id: uuidv7(),
        project_id: FIXTURE_PROJECT_ID,
        name: 'Sprint F (planning)',
        starts_on: '2026-06-01',
        ends_on: '2026-06-14',
      },
      actorId: FIXTURE_ACTOR_ID,
    });
    await expect(
      assignToSprint(db, {
        req: { operation_id: uuidv7(), sprint_id: second.sprint.id, task_id: taskId },
        actorId: FIXTURE_ACTOR_ID,
      }),
    ).rejects.toThrow(TaskAlreadyInActiveSprintError);
  });
});

describe('D4-P2: closeSprint carry-over', () => {
  it('closeSprint returns incomplete tasks as carry_over_tasks', async () => {
    const created = await createSprint(db, {
      req: {
        operation_id: uuidv7(),
        project_id: FIXTURE_PROJECT_ID,
        name: 'Sprint G',
        starts_on: '2026-05-01',
        ends_on: '2026-05-14',
      },
      actorId: FIXTURE_ACTOR_ID,
    });
    await activateSprint(db, {
      req: {
        operation_id: uuidv7(),
        sprint_id: created.sprint.id,
        to_status: 'active',
        if_match: 1,
      },
      actorId: FIXTURE_ACTOR_ID,
    });
    const taskId = await makeTask('unfinished task');
    await assignToSprint(db, {
      req: { operation_id: uuidv7(), sprint_id: created.sprint.id, task_id: taskId },
      actorId: FIXTURE_ACTOR_ID,
    });
    const closed = await closeSprint(db, {
      req: {
        operation_id: uuidv7(),
        sprint_id: created.sprint.id,
        to_status: 'completed',
        if_match: 2,
      },
      actorId: FIXTURE_ACTOR_ID,
    });
    expect(closed.sprint.status).toBe('completed');
    expect(closed.carry_over_tasks.map((t) => t.id)).toContain(taskId);
  });
});

describe('D4-P2: updateTaskPoints', () => {
  it('sets tasks.points field', async () => {
    const taskId = await makeTask('task with points');
    const taskRes = await getTask(db, { req: { task_id: taskId } });
    await updateTaskPoints(db, {
      req: {
        operation_id: uuidv7(),
        task_id: taskId,
        points: 5,
        if_match: taskRes.task.version,
      },
      actorId: FIXTURE_ACTOR_ID,
    });
    const rows = await db
      .select({ points: tasks.points })
      .from(tasks)
      .where(eq(tasks.id, taskId));
    expect(rows[0]!.points).toBe(5);
  });
});

describe('D4-P2: HTTP endpoints', () => {
  it('POST /projects/:id/sprints → 201', async () => {
    const app = buildTestApp();
    const res = await app.fetch(
      new Request(`http://localhost/api/projects/${FIXTURE_PROJECT_ID}/sprints`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${FIXTURE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation_id: uuidv7(),
          name: 'HTTP Sprint',
          starts_on: '2026-06-01',
          ends_on: '2026-06-14',
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { sprint: { status: string } };
    expect(body.sprint.status).toBe('planning');
  });

  it('PATCH /sprints/:id/status to active → 200', async () => {
    const app = buildTestApp();
    const createRes = await app.fetch(
      new Request(`http://localhost/api/projects/${FIXTURE_PROJECT_ID}/sprints`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${FIXTURE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation_id: uuidv7(),
          name: 'HTTP Sprint Activate',
          starts_on: '2026-05-01',
          ends_on: '2026-05-14',
        }),
      }),
    );
    const created = (await createRes.json()) as { sprint: { id: string; version: number } };
    const patchRes = await app.fetch(
      new Request(`http://localhost/api/sprints/${created.sprint.id}/status`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${FIXTURE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation_id: uuidv7(),
          to_status: 'active',
          if_match: created.sprint.version,
        }),
      }),
    );
    expect(patchRes.status).toBe(200);
    const body = (await patchRes.json()) as { sprint: { status: string } };
    expect(body.sprint.status).toBe('active');
  });

  it('PATCH /sprints/:id/status → 409 when another sprint already active', async () => {
    const app = buildTestApp();
    const f1 = await app.fetch(
      new Request(`http://localhost/api/projects/${FIXTURE_PROJECT_ID}/sprints`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${FIXTURE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation_id: uuidv7(),
          name: 'Conflict S1',
          starts_on: '2026-05-01',
          ends_on: '2026-05-14',
        }),
      }),
    );
    const s1 = (await f1.json()) as { sprint: { id: string; version: number } };
    await app.fetch(
      new Request(`http://localhost/api/sprints/${s1.sprint.id}/status`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${FIXTURE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation_id: uuidv7(),
          to_status: 'active',
          if_match: s1.sprint.version,
        }),
      }),
    );
    const f2 = await app.fetch(
      new Request(`http://localhost/api/projects/${FIXTURE_PROJECT_ID}/sprints`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${FIXTURE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation_id: uuidv7(),
          name: 'Conflict S2',
          starts_on: '2026-05-15',
          ends_on: '2026-05-28',
        }),
      }),
    );
    const s2 = (await f2.json()) as { sprint: { id: string; version: number } };
    const conflictRes = await app.fetch(
      new Request(`http://localhost/api/sprints/${s2.sprint.id}/status`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${FIXTURE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation_id: uuidv7(),
          to_status: 'active',
          if_match: s2.sprint.version,
        }),
      }),
    );
    expect(conflictRes.status).toBe(409);
  });

  it('POST /sprints/:id/tasks → 201, duplicate → 201 (idempotent, no duplicate row)', async () => {
    const app = buildTestApp();
    const sprintId = await makeSprint('HTTP Task Sprint');
    const taskId = await makeTask('task for HTTP sprint');
    const first = await app.fetch(
      new Request(`http://localhost/api/sprints/${sprintId}/tasks`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${FIXTURE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation_id: uuidv7(), task_id: taskId }),
      }),
    );
    expect(first.status).toBe(201);
    const second = await app.fetch(
      new Request(`http://localhost/api/sprints/${sprintId}/tasks`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${FIXTURE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation_id: uuidv7(), task_id: taskId }),
      }),
    );
    expect(second.status).toBe(201);
    const rows = await db
      .select()
      .from(sprintTasks)
      .where(and(eq(sprintTasks.sprintId, sprintId), eq(sprintTasks.taskId, taskId)));
    expect(rows).toHaveLength(1);
  });

  it('PATCH /tasks/:id/points → 200', async () => {
    const app = buildTestApp();
    const taskId = await makeTask('HTTP points task');
    const taskRes = await getTask(db, { req: { task_id: taskId } });
    const res = await app.fetch(
      new Request(`http://localhost/api/tasks/${taskId}/points`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${FIXTURE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation_id: uuidv7(),
          points: 8,
          if_match: taskRes.task.version,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: { points: number } };
    expect(body.task.points).toBe(8);
  });
});
