// SPDX-License-Identifier: AGPL-3.0-or-later
// D4: Sprint and Iteration Planning — integration tests.
// TDD red phase (P1): imports from schema.ts will fail typecheck until P1 is done.

import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../src/db/client.ts';
import { sprints, sprintTasks, tasks } from '../src/db/schema.ts';
import { createTask, getTask } from '../src/service/tasks.ts';
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
