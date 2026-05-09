// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — D1 Workflow State Machine tests.
// D1-P1: persistence, D1-P2: transition guards, D1-P3: HTTP adapter.
import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.ts';
import { workflowColumns } from '../src/db/schema.ts';
import {
  WorkflowColumnNotFoundError,
  WorkflowTransitionForbiddenError,
  VersionMismatchError,
  createTask,
  listWorkflowColumns,
  transitionTaskWorkflow,
} from '../src/service/tasks.ts';
import {
  FIXTURE_ACTOR_ID,
  FIXTURE_PROJECT_ID,
  FIXTURE_TOKEN,
  FIXTURE_WORKSPACE_ID,
  buildTestApp,
} from './setup.ts';

// ── D1-P1: persistence ───────────────────────────────────────────────────

describe('D1-P1: workflow state persistence', () => {
  it('fixture project has 4 default workflow columns after resetDb', async () => {
    const cols = await db
      .select()
      .from(workflowColumns)
      .where(eq(workflowColumns.projectId, FIXTURE_PROJECT_ID));
    expect(cols).toHaveLength(4);
  });

  it('exactly one column is the default (Backlog)', async () => {
    const cols = await db
      .select()
      .from(workflowColumns)
      .where(eq(workflowColumns.projectId, FIXTURE_PROJECT_ID));
    const defaults = cols.filter((c) => c.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.name).toBe('Backlog');
  });

  it('createTask sets workflow_column_id to the default column', async () => {
    const res = await createTask(db, {
      req: {
        operation_id: uuidv7(),
        project_id: FIXTURE_PROJECT_ID,
        title: 'Workflow column test task',
      },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });

    const cols = await db
      .select()
      .from(workflowColumns)
      .where(eq(workflowColumns.projectId, FIXTURE_PROJECT_ID));
    const defaultCol = cols.find((c) => c.isDefault)!;
    expect(res.task.workflow_column_id).toBe(defaultCol.id);
  });
});

// ── D1-P2: transition guards ─────────────────────────────────────────────

describe('D1-P2: transitionTaskWorkflow', () => {
  async function setupTask() {
    const res = await createTask(db, {
      req: {
        operation_id: uuidv7(),
        project_id: FIXTURE_PROJECT_ID,
        title: 'Transition test task',
      },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });
    return res.task;
  }

  it('listWorkflowColumns returns 4 columns and 4 transitions for fixture project', async () => {
    const { columns, transitions } = await listWorkflowColumns(db, {
      projectId: FIXTURE_PROJECT_ID,
    });
    expect(columns).toHaveLength(4);
    expect(transitions).toHaveLength(4);
    expect(columns.map((c) => c.name)).toEqual(
      expect.arrayContaining(['Backlog', 'In Progress', 'In Review', 'Done']),
    );
  });

  it('valid transition (Backlog → In Progress) succeeds', async () => {
    const task = await setupTask();
    const { columns } = await listWorkflowColumns(db, { projectId: FIXTURE_PROJECT_ID });
    const inProgress = columns.find((c) => c.name === 'In Progress')!;

    const res = await transitionTaskWorkflow(db, {
      req: {
        operation_id: uuidv7(),
        task_id: task.id,
        to_column_id: inProgress.id,
        if_match: task.version,
      },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });

    expect(res.task.workflow_column_id).toBe(inProgress.id);
    expect(res.task.status).toBe('doing');
    expect(res.task.version).toBe(task.version + 1);
    expect(res.event.kind).toBe('workflow_transitioned');
    expect((res.event.payload as { to_column_id: string }).to_column_id).toBe(inProgress.id);
  });

  it('invalid transition (Backlog → Done) throws WorkflowTransitionForbiddenError', async () => {
    const task = await setupTask();
    const { columns } = await listWorkflowColumns(db, { projectId: FIXTURE_PROJECT_ID });
    const done = columns.find((c) => c.name === 'Done')!;

    await expect(
      transitionTaskWorkflow(db, {
        req: {
          operation_id: uuidv7(),
          task_id: task.id,
          to_column_id: done.id,
          if_match: task.version,
        },
        actorId: FIXTURE_ACTOR_ID,
        workspaceId: FIXTURE_WORKSPACE_ID,
      }),
    ).rejects.toThrow(WorkflowTransitionForbiddenError);
  });

  it('unknown to_column_id throws WorkflowColumnNotFoundError', async () => {
    const task = await setupTask();
    await expect(
      transitionTaskWorkflow(db, {
        req: {
          operation_id: uuidv7(),
          task_id: task.id,
          to_column_id: uuidv7(),
          if_match: task.version,
        },
        actorId: FIXTURE_ACTOR_ID,
        workspaceId: FIXTURE_WORKSPACE_ID,
      }),
    ).rejects.toThrow(WorkflowColumnNotFoundError);
  });

  it('version mismatch throws VersionMismatchError', async () => {
    const task = await setupTask();
    const { columns } = await listWorkflowColumns(db, { projectId: FIXTURE_PROJECT_ID });
    const inProgress = columns.find((c) => c.name === 'In Progress')!;

    await expect(
      transitionTaskWorkflow(db, {
        req: {
          operation_id: uuidv7(),
          task_id: task.id,
          to_column_id: inProgress.id,
          if_match: task.version + 99,
        },
        actorId: FIXTURE_ACTOR_ID,
        workspaceId: FIXTURE_WORKSPACE_ID,
      }),
    ).rejects.toThrow(VersionMismatchError);
  });

  it('transition is idempotent via operation_id', async () => {
    const task = await setupTask();
    const { columns } = await listWorkflowColumns(db, { projectId: FIXTURE_PROJECT_ID });
    const inProgress = columns.find((c) => c.name === 'In Progress')!;
    const opId = uuidv7();

    const res1 = await transitionTaskWorkflow(db, {
      req: { operation_id: opId, task_id: task.id, to_column_id: inProgress.id, if_match: task.version },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });
    const res2 = await transitionTaskWorkflow(db, {
      req: { operation_id: opId, task_id: task.id, to_column_id: inProgress.id, if_match: task.version },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });

    expect(res1.task.id).toBe(res2.task.id);
    expect(res1.event.id).toBe(res2.event.id);
    expect(res2.task.version).toBe(res1.task.version);
    expect(res2.task.workflow_column_id).toBe(res1.task.workflow_column_id);
  });

  it('null current column (pre-D1 task) allows any target column', async () => {
    // Simulate a pre-D1 task by directly updating workflow_column_id to null
    const task = await setupTask();
    const { tasks: taskTable } = await import('../src/db/schema.ts');
    await db.update(taskTable).set({ workflowColumnId: null }).where(eq(taskTable.id, task.id));

    const { columns } = await listWorkflowColumns(db, { projectId: FIXTURE_PROJECT_ID });
    const done = columns.find((c) => c.name === 'Done')!;

    // Backlog→Done would normally be forbidden, but null current column bypasses guard
    const res = await transitionTaskWorkflow(db, {
      req: {
        operation_id: uuidv7(),
        task_id: task.id,
        to_column_id: done.id,
        if_match: task.version,
      },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });
    expect(res.task.workflow_column_id).toBe(done.id);
  });
});

// ── D1-P3: HTTP adapter ──────────────────────────────────────────────────

describe('D1-P3: HTTP adapter', () => {
  async function createTaskViaApi(app: ReturnType<typeof buildTestApp>) {
    const res = await app.fetch(
      new Request('http://test/api/tasks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${FIXTURE_TOKEN}`,
        },
        body: JSON.stringify({
          operation_id: uuidv7(),
          project_id: FIXTURE_PROJECT_ID,
          title: 'HTTP workflow test task',
        }),
      }),
    );
    return (await res.json()) as { task: { id: string; version: number; workflow_column_id: string } };
  }

  async function getColumns(app: ReturnType<typeof buildTestApp>) {
    const res = await app.fetch(
      new Request(`http://test/api/projects/${FIXTURE_PROJECT_ID}/workflow-columns`, {
        headers: { Authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    return (await res.json()) as { columns: { id: string; name: string }[]; transitions: { from_column_id: string; to_column_id: string }[] };
  }

  it('GET /api/projects/:id/workflow-columns returns 200 with columns and transitions', async () => {
    const app = buildTestApp();
    const res = await app.fetch(
      new Request(`http://test/api/projects/${FIXTURE_PROJECT_ID}/workflow-columns`, {
        headers: { Authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { columns: unknown[]; transitions: unknown[] };
    expect(body.columns).toHaveLength(4);
    expect(body.transitions).toHaveLength(4);
  });

  it('POST /api/tasks/:id/transition → 200 on valid move', async () => {
    const app = buildTestApp();
    const { task } = await createTaskViaApi(app);
    const { columns } = await getColumns(app);
    const inProgress = columns.find((c) => c.name === 'In Progress')!;

    const res = await app.fetch(
      new Request(`http://test/api/tasks/${task.id}/transition`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${FIXTURE_TOKEN}`,
        },
        body: JSON.stringify({
          operation_id: uuidv7(),
          to_column_id: inProgress.id,
          if_match: task.version,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { task: { workflow_column_id: string; status: string } };
    expect(body.task.workflow_column_id).toBe(inProgress.id);
    expect(body.task.status).toBe('doing');
  });

  it('POST /api/tasks/:id/transition → 422 on forbidden move', async () => {
    const app = buildTestApp();
    const { task } = await createTaskViaApi(app);
    const { columns } = await getColumns(app);
    const done = columns.find((c) => c.name === 'Done')!;

    const res = await app.fetch(
      new Request(`http://test/api/tasks/${task.id}/transition`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${FIXTURE_TOKEN}`,
        },
        body: JSON.stringify({
          operation_id: uuidv7(),
          to_column_id: done.id,
          if_match: task.version,
        }),
      }),
    );
    expect(res.status).toBe(422);
  });

  it('POST /api/tasks/:id/transition → 409 on version mismatch', async () => {
    const app = buildTestApp();
    const { task } = await createTaskViaApi(app);
    const { columns } = await getColumns(app);
    const inProgress = columns.find((c) => c.name === 'In Progress')!;

    const res = await app.fetch(
      new Request(`http://test/api/tasks/${task.id}/transition`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${FIXTURE_TOKEN}`,
        },
        body: JSON.stringify({
          operation_id: uuidv7(),
          to_column_id: inProgress.id,
          if_match: task.version + 99,
        }),
      }),
    );
    expect(res.status).toBe(409);
  });
});
