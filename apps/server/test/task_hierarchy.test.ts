// SPDX-License-Identifier: AGPL-3.0-or-later
// D3: Hierarchy and Dependency Management — integration tests.
// TDD red phase: these tests fail until Tasks 5–9 are implemented.

import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.ts';
import { tasks, taskDependencies } from '../src/db/schema.ts';
import {
  HierarchyDepthExceededError,
  ParentCycleDetectedError,
  DependencyCycleDetectedError,
  DependencyNotResolvedError,
  ChildrenNotDoneError,
  CrossProjectRelationError,
  addDependency,
  createTask,
  getTask,
  listDependencies,
  removeDependency,
  setParent,
  updateTaskStatus,
} from '../src/service/tasks.ts';
import {
  FIXTURE_ACTOR_ID,
  FIXTURE_PROJECT_ID,
  FIXTURE_TOKEN,
  buildTestApp,
} from './setup.ts';

// ── helpers ──────────────────────────────────────────────────────────────────

async function makeTask(title: string): Promise<string> {
  const res = await createTask(db, {
    req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title },
    actorId: FIXTURE_ACTOR_ID,
  });
  return res.task.id;
}

// ── D3-P1: persistence ───────────────────────────────────────────────────────

describe('D3-P1: parent_task_id persists', () => {
  it('setParent stores parent_task_id on the task row', async () => {
    const parentId = await makeTask('parent task');
    const childId = await makeTask('child task');

    await setParent(db, { taskId: childId, parentTaskId: parentId, actorId: FIXTURE_ACTOR_ID });

    const rows = await db.select({ parentTaskId: tasks.parentTaskId })
      .from(tasks)
      .where(eq(tasks.id, childId));
    expect(rows[0]!.parentTaskId).toBe(parentId);
  });

  it('setParent(null) clears parent_task_id', async () => {
    const parentId = await makeTask('parent clear');
    const childId = await makeTask('child clear');
    await setParent(db, { taskId: childId, parentTaskId: parentId, actorId: FIXTURE_ACTOR_ID });
    await setParent(db, { taskId: childId, parentTaskId: null, actorId: FIXTURE_ACTOR_ID });

    const rows = await db.select({ parentTaskId: tasks.parentTaskId })
      .from(tasks)
      .where(eq(tasks.id, childId));
    expect(rows[0]!.parentTaskId).toBeNull();
  });

  it('addDependency inserts a row into task_dependencies', async () => {
    const fromId = await makeTask('from task');
    const toId = await makeTask('to task');

    await addDependency(db, { fromTaskId: fromId, toTaskId: toId, actorId: FIXTURE_ACTOR_ID });

    const rows = await db.select()
      .from(taskDependencies)
      .where(eq(taskDependencies.fromTaskId, fromId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.toTaskId).toBe(toId);
  });

  it('listDependencies returns tasks that block the given task', async () => {
    const fromId = await makeTask('list-from');
    const toId = await makeTask('list-to');
    await addDependency(db, { fromTaskId: fromId, toTaskId: toId, actorId: FIXTURE_ACTOR_ID });

    const { blocked_by } = await listDependencies(db, { taskId: fromId });
    expect(blocked_by).toHaveLength(1);
    expect(blocked_by[0]!.id).toBe(toId);
  });

  it('rowToTask includes parent_task_id field', async () => {
    const parentId = await makeTask('rowToTask parent');
    const childId = await makeTask('rowToTask child');
    await setParent(db, { taskId: childId, parentTaskId: parentId, actorId: FIXTURE_ACTOR_ID });

    const { task } = await getTask(db, { req: { task_id: childId } });
    expect(task).toHaveProperty('parent_task_id', parentId);
  });
});

// ── D3-P2: service guards ─────────────────────────────────────────────────────

describe('D3-P2: setParent guards', () => {
  it('throws ParentCycleDetectedError when setting parent creates a cycle', async () => {
    const aId = await makeTask('cycle A');
    const bId = await makeTask('cycle B');

    await setParent(db, { taskId: aId, parentTaskId: bId, actorId: FIXTURE_ACTOR_ID });

    await expect(
      setParent(db, { taskId: bId, parentTaskId: aId, actorId: FIXTURE_ACTOR_ID }),
    ).rejects.toBeInstanceOf(ParentCycleDetectedError);
  });

  it('throws HierarchyDepthExceededError at depth 4', async () => {
    const l1 = await makeTask('depth L1');
    const l2 = await makeTask('depth L2');
    const l3 = await makeTask('depth L3');
    const l4 = await makeTask('depth L4');

    await setParent(db, { taskId: l2, parentTaskId: l1, actorId: FIXTURE_ACTOR_ID });
    await setParent(db, { taskId: l3, parentTaskId: l2, actorId: FIXTURE_ACTOR_ID });

    await expect(
      setParent(db, { taskId: l4, parentTaskId: l3, actorId: FIXTURE_ACTOR_ID }),
    ).rejects.toBeInstanceOf(HierarchyDepthExceededError);
  });

  it('allows exactly 3 levels deep', async () => {
    const l1 = await makeTask('3-level L1');
    const l2 = await makeTask('3-level L2');
    const l3 = await makeTask('3-level L3');

    await setParent(db, { taskId: l2, parentTaskId: l1, actorId: FIXTURE_ACTOR_ID });
    await expect(
      setParent(db, { taskId: l3, parentTaskId: l2, actorId: FIXTURE_ACTOR_ID }),
    ).resolves.not.toThrow();
  });
});

describe('D3-P2: addDependency guards', () => {
  it('throws DependencyCycleDetectedError when cycle would be created', async () => {
    const aId = await makeTask('dep cycle A');
    const bId = await makeTask('dep cycle B');

    await addDependency(db, { fromTaskId: aId, toTaskId: bId, actorId: FIXTURE_ACTOR_ID });

    await expect(
      addDependency(db, { fromTaskId: bId, toTaskId: aId, actorId: FIXTURE_ACTOR_ID }),
    ).rejects.toBeInstanceOf(DependencyCycleDetectedError);
  });

  it('auto-sets from task status to blocked on addDependency', async () => {
    const fromId = await makeTask('auto-block from');
    const toId = await makeTask('auto-block to');

    await addDependency(db, { fromTaskId: fromId, toTaskId: toId, actorId: FIXTURE_ACTOR_ID });

    const rows = await db.select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, fromId));
    expect(rows[0]!.status).toBe('blocked');
  });
});

describe('D3-P2: updateTaskStatus guards', () => {
  it('rejects transition to doing when dependency is unresolved', async () => {
    const fromId = await makeTask('guard doing from');
    const toId = await makeTask('guard doing to');
    await addDependency(db, { fromTaskId: fromId, toTaskId: toId, actorId: FIXTURE_ACTOR_ID });

    const taskRow = (await db.select().from(tasks).where(eq(tasks.id, fromId)))[0]!;

    await expect(
      updateTaskStatus(db, {
        req: {
          operation_id: uuidv7(),
          task_id: fromId,
          status: 'doing',
          if_match: taskRow.version,
        },
        actorId: FIXTURE_ACTOR_ID,
      }),
    ).rejects.toBeInstanceOf(DependencyNotResolvedError);
  });

  it('rejects transition to done when dependency is unresolved', async () => {
    const fromId = await makeTask('guard done from');
    const toId = await makeTask('guard done to');
    await addDependency(db, { fromTaskId: fromId, toTaskId: toId, actorId: FIXTURE_ACTOR_ID });

    const taskRow = (await db.select().from(tasks).where(eq(tasks.id, fromId)))[0]!;

    await expect(
      updateTaskStatus(db, {
        req: {
          operation_id: uuidv7(),
          task_id: fromId,
          status: 'done',
          if_match: taskRow.version,
        },
        actorId: FIXTURE_ACTOR_ID,
      }),
    ).rejects.toBeInstanceOf(DependencyNotResolvedError);
  });

  it('rejects transition to done when children are not done', async () => {
    const parentId = await makeTask('parent not done');
    const childId = await makeTask('child not done');
    await setParent(db, { taskId: childId, parentTaskId: parentId, actorId: FIXTURE_ACTOR_ID });

    const parentRow = (await db.select().from(tasks).where(eq(tasks.id, parentId)))[0]!;

    await expect(
      updateTaskStatus(db, {
        req: {
          operation_id: uuidv7(),
          task_id: parentId,
          status: 'done',
          if_match: parentRow.version,
        },
        actorId: FIXTURE_ACTOR_ID,
      }),
    ).rejects.toBeInstanceOf(ChildrenNotDoneError);
  });
});

describe('D3-P2: removeDependency', () => {
  it('removes the dependency row and does NOT auto-change status', async () => {
    const fromId = await makeTask('remove from');
    const toId = await makeTask('remove to');
    await addDependency(db, { fromTaskId: fromId, toTaskId: toId, actorId: FIXTURE_ACTOR_ID });

    await removeDependency(db, { fromTaskId: fromId, toTaskId: toId, actorId: FIXTURE_ACTOR_ID });

    const depRows = await db.select()
      .from(taskDependencies)
      .where(eq(taskDependencies.fromTaskId, fromId));
    expect(depRows).toHaveLength(0);

    // Status stays 'blocked' — must be manually updated by actor.
    const taskRow = (await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, fromId)))[0]!;
    expect(taskRow.status).toBe('blocked');
  });
});

// ── D3-P2: HTTP endpoints ────────────────────────────────────────────────────

describe('D3-P2: HTTP PATCH /api/tasks/:id/parent', () => {
  it('200 sets parent_task_id', async () => {
    const app = buildTestApp();
    const parentId = await makeTask('http parent');
    const childId = await makeTask('http child');

    const res = await app.request(`/api/tasks/${childId}/parent`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${FIXTURE_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ parent_task_id: parentId }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { task: { parent_task_id: string } };
    expect(body.task.parent_task_id).toBe(parentId);
  });

  it('422 when hierarchy would exceed 3 levels', async () => {
    const app = buildTestApp();
    const l1 = await makeTask('http depth L1');
    const l2 = await makeTask('http depth L2');
    const l3 = await makeTask('http depth L3');
    const l4 = await makeTask('http depth L4');
    await setParent(db, { taskId: l2, parentTaskId: l1, actorId: FIXTURE_ACTOR_ID });
    await setParent(db, { taskId: l3, parentTaskId: l2, actorId: FIXTURE_ACTOR_ID });

    const res = await app.request(`/api/tasks/${l4}/parent`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${FIXTURE_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ parent_task_id: l3 }),
    });

    expect(res.status).toBe(422);
  });
});

describe('D3-P2: HTTP POST /api/tasks/:id/dependencies', () => {
  it('200 adds dependency and returns updated task', async () => {
    const app = buildTestApp();
    const fromId = await makeTask('http dep from');
    const toId = await makeTask('http dep to');

    const res = await app.request(`/api/tasks/${fromId}/dependencies`, {
      method: 'POST',
      headers: { authorization: `Bearer ${FIXTURE_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ blocked_by_task_id: toId }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { task: { status: string } };
    expect(body.task.status).toBe('blocked');
  });
});

describe('D3-P2: HTTP DELETE /api/tasks/:id/dependencies/:depId', () => {
  it('204 removes dependency', async () => {
    const app = buildTestApp();
    const fromId = await makeTask('http del from');
    const toId = await makeTask('http del to');
    await addDependency(db, { fromTaskId: fromId, toTaskId: toId, actorId: FIXTURE_ACTOR_ID });

    const res = await app.request(`/api/tasks/${fromId}/dependencies/${toId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
    });

    expect(res.status).toBe(204);
  });
});

describe('D3-P2: HTTP GET /api/tasks/:id/dependencies', () => {
  it('returns blocked_by array', async () => {
    const app = buildTestApp();
    const fromId = await makeTask('http list from');
    const toId = await makeTask('http list to');
    await addDependency(db, { fromTaskId: fromId, toTaskId: toId, actorId: FIXTURE_ACTOR_ID });

    const res = await app.request(`/api/tasks/${fromId}/dependencies`, {
      headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { blocked_by: Array<{ id: string }> };
    expect(body.blocked_by[0]!.id).toBe(toId);
  });
});
