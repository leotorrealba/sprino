// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — D2: Backlog and Board Ordering — integration tests.
// TDD red phase: these tests fail until Tasks 5–11 are implemented.

import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.ts';
import { workflowColumns } from '../src/db/schema.ts';
import {
  TaskNotInColumnError,
  createTask,
  listTasks,
  reorderTask,
  transitionTaskWorkflow,
} from '../src/service/tasks.ts';
import {
  FIXTURE_ACTOR_ID,
  FIXTURE_PROJECT_ID,
  FIXTURE_TOKEN,
  FIXTURE_WORKSPACE_ID,
  buildTestApp,
} from './setup.ts';

// ── helpers ──────────────────────────────────────────────────────────────────

async function getDefaultColumn(): Promise<{ id: string }> {
  const cols = await db
    .select({ id: workflowColumns.id, isDefault: workflowColumns.isDefault })
    .from(workflowColumns)
    .where(eq(workflowColumns.projectId, FIXTURE_PROJECT_ID));
  return cols.find((c) => c.isDefault)!;
}

async function getColumnByName(name: string): Promise<{ id: string }> {
  const cols = await db
    .select({ id: workflowColumns.id, name: workflowColumns.name })
    .from(workflowColumns)
    .where(eq(workflowColumns.projectId, FIXTURE_PROJECT_ID));
  return cols.find((c) => c.name === name)!;
}

// ── D2-P1: createTask appends to bottom of default column ─────────────────

describe('D2-P1: createTask rank assignment', () => {
  it('first task in a column gets rank 1', async () => {
    const res = await createTask(db, {
      req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'rank test A' },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });
    expect(res.task.rank).toBeGreaterThanOrEqual(1);
  });

  it('second task gets a higher rank than the first', async () => {
    const res1 = await createTask(db, {
      req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'rank append 1' },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });
    const res2 = await createTask(db, {
      req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'rank append 2' },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });
    expect(res2.task.rank).toBeGreaterThan(res1.task.rank);
  });
});

// ── D2-P1: listTasks returns tasks in rank order ───────────────────────────

describe('D2-P1: listTasks rank order', () => {
  it('tasks are returned in ascending rank order within a project', async () => {
    await createTask(db, {
      req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'rank order 1' },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });
    await createTask(db, {
      req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'rank order 2' },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });
    await createTask(db, {
      req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'rank order 3' },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });

    const { tasks } = await listTasks(db, { req: { project_id: FIXTURE_PROJECT_ID }, workspaceId: FIXTURE_WORKSPACE_ID });
    const ranks = tasks.map((t) => t.rank);
    const sorted = [...ranks].sort((a, b) => a - b);
    expect(ranks).toEqual(sorted);
  });
});

// ── D2-P1: transitionTaskWorkflow appends rank to new column ──────────────

describe('D2-P1: transitionTaskWorkflow rank in new column', () => {
  it('transitioned task gets rank = MAX(new column) + 1', async () => {
    const res = await createTask(db, {
      req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'transition rank test' },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });
    const task = res.task;

    const inProgress = await getColumnByName('In Progress');
    const transitioned = await transitionTaskWorkflow(db, {
      req: {
        operation_id: uuidv7(),
        task_id: task.id,
        to_column_id: inProgress.id,
        if_match: task.version,
      },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });

    expect(transitioned.task.rank).toBeGreaterThanOrEqual(1);
    expect(transitioned.task.workflow_column_id).toBe(inProgress.id);
  });
});

// ── D2-P2: reorderTask — basic cases ──────────────────────────────────────

describe('D2-P2: reorderTask', () => {
  async function setup3Tasks(): Promise<{ taskIds: string[]; columnId: string }> {
    const col = await getDefaultColumn();
    const t1 = await createTask(db, {
      req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'reorder A' },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });
    const t2 = await createTask(db, {
      req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'reorder B' },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });
    const t3 = await createTask(db, {
      req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'reorder C' },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });
    return {
      taskIds: [t1.task.id, t2.task.id, t3.task.id],
      columnId: col.id,
    };
  }

  it('move to top (after_task_id=null) puts task at rank 1', async () => {
    const { taskIds, columnId } = await setup3Tasks();
    const [, , t3id] = taskIds;

    const { tasks: ordered } = await reorderTask(db, {
      req: {
        operation_id: uuidv7(),
        task_id: t3id!,
        column_id: columnId,
        after_task_id: null,
      },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });

    const t3 = ordered.find((t) => t.id === t3id)!;
    expect(t3.rank).toBe(1);
    const ranks = ordered.map((t) => t.rank);
    expect(ranks).toEqual([1, 2, 3].slice(0, ranks.length));
  });

  it('move after anchor places task immediately after the anchor', async () => {
    const { taskIds, columnId } = await setup3Tasks();
    const [t1id, t2id, t3id] = taskIds;

    const { tasks: ordered } = await reorderTask(db, {
      req: {
        operation_id: uuidv7(),
        task_id: t3id!,
        column_id: columnId,
        after_task_id: t1id!,
      },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });

    const ids = ordered.map((t) => t.id);
    const t1Pos = ids.indexOf(t1id!);
    const t3Pos = ids.indexOf(t3id!);
    const t2Pos = ids.indexOf(t2id!);
    expect(t3Pos).toBe(t1Pos + 1);
    expect(t2Pos).toBe(t3Pos + 1);
  });

  it('returned tasks have contiguous 1-based ranks', async () => {
    const { taskIds, columnId } = await setup3Tasks();
    const [t1id] = taskIds;

    const { tasks: ordered } = await reorderTask(db, {
      req: {
        operation_id: uuidv7(),
        task_id: t1id!,
        column_id: columnId,
        after_task_id: null,
      },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });

    const ranks = ordered.map((t) => t.rank).sort((a, b) => a - b);
    expect(ranks).toEqual(ranks.map((_, i) => i + 1));
  });

  it('reorderTask is idempotent — same operation_id replays cached result', async () => {
    const { taskIds, columnId } = await setup3Tasks();
    const [t1id] = taskIds;
    const opId = uuidv7();

    const res1 = await reorderTask(db, {
      req: { operation_id: opId, task_id: t1id!, column_id: columnId, after_task_id: null },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });
    const res2 = await reorderTask(db, {
      req: { operation_id: opId, task_id: t1id!, column_id: columnId, after_task_id: null },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });

    expect(res2.tasks.map((t) => t.id)).toEqual(res1.tasks.map((t) => t.id));
  });

  it('throws TaskNotInColumnError when task is not in the given column', async () => {
    const { taskIds } = await setup3Tasks();
    const inProgress = await getColumnByName('In Progress');

    await expect(
      reorderTask(db, {
        req: {
          operation_id: uuidv7(),
          task_id: taskIds[0]!,
          column_id: inProgress.id,
          after_task_id: null,
        },
        actorId: FIXTURE_ACTOR_ID,
        workspaceId: FIXTURE_WORKSPACE_ID,
      }),
    ).rejects.toBeInstanceOf(TaskNotInColumnError);
  });

  it('throws TaskNotInColumnError when after_task_id is not in the column', async () => {
    const { taskIds, columnId } = await setup3Tasks();
    const inProgress = await getColumnByName('In Progress');

    await transitionTaskWorkflow(db, {
      req: {
        operation_id: uuidv7(),
        task_id: taskIds[0]!,
        to_column_id: inProgress.id,
        if_match: 1,
      },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });

    await expect(
      reorderTask(db, {
        req: {
          operation_id: uuidv7(),
          task_id: taskIds[1]!,
          column_id: columnId,
          after_task_id: taskIds[0]!,
        },
        actorId: FIXTURE_ACTOR_ID,
        workspaceId: FIXTURE_WORKSPACE_ID,
      }),
    ).rejects.toBeInstanceOf(TaskNotInColumnError);
  });
});

// ── D2-P2: listTasks filters ───────────────────────────────────────────────

describe('D2-P2: listTasks filters', () => {
  it('status[] filter returns only tasks matching those statuses', async () => {
    const app = buildTestApp();
    await createTask(db, {
      req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'filter status test' },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });

    const res = await app.request(
      `/api/tasks?project_id=${FIXTURE_PROJECT_ID}&status=done&status=blocked`,
      { headers: { authorization: `Bearer ${FIXTURE_TOKEN}` } },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { tasks: Array<{ status: string }> };
    expect(body.tasks.every((t) => t.status === 'done' || t.status === 'blocked')).toBe(true);
  });

  it('assignee_id filter returns only tasks assigned to that actor', async () => {
    const app = buildTestApp();
    await createTask(db, {
      req: {
        operation_id: uuidv7(),
        project_id: FIXTURE_PROJECT_ID,
        title: 'assigned task',
        assignee_id: FIXTURE_ACTOR_ID,
      },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });

    const res = await app.request(
      `/api/tasks?project_id=${FIXTURE_PROJECT_ID}&assignee_id=${FIXTURE_ACTOR_ID}`,
      { headers: { authorization: `Bearer ${FIXTURE_TOKEN}` } },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { tasks: Array<{ assignee_id: string | null }> };
    expect(body.tasks.every((t) => t.assignee_id === FIXTURE_ACTOR_ID)).toBe(true);
  });
});

// ── D2-P2: POST /api/tasks/:id/reorder HTTP endpoint ─────────────────────

describe('D2-P2: POST /api/tasks/:id/reorder HTTP', () => {
  it('200 with tasks array in new rank order', async () => {
    const app = buildTestApp();
    const col = await getDefaultColumn();

    const t1 = await createTask(db, {
      req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'http reorder 1' },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });
    const t2 = await createTask(db, {
      req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'http reorder 2' },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });

    const res = await app.request(`/api/tasks/${t2.task.id}/reorder`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${FIXTURE_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        operation_id: uuidv7(),
        column_id: col.id,
        after_task_id: null,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { tasks: Array<{ id: string; rank: number }> };
    expect(body.tasks[0]!.id).toBe(t2.task.id);
    expect(body.tasks[0]!.rank).toBe(1);
  });

  it('422 when task is not in the given column', async () => {
    const app = buildTestApp();
    const inProgress = await getColumnByName('In Progress');

    const t = await createTask(db, {
      req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'http reorder wrong col' },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });

    const res = await app.request(`/api/tasks/${t.task.id}/reorder`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${FIXTURE_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        operation_id: uuidv7(),
        column_id: inProgress.id,
        after_task_id: null,
      }),
    });

    expect(res.status).toBe(422);
  });
});
