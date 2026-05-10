// SPDX-License-Identifier: AGPL-3.0-or-later
// EC-3: removeDependency auto-unblock — integration tests.

import { describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../src/db/client.ts';
import { events } from '../src/db/schema.ts';
import {
  addDependency,
  createTask,
  getTask,
  removeDependency,
} from '../src/service/tasks.ts';
import {
  FIXTURE_ACTOR_ID,
  FIXTURE_PROJECT_ID,
  FIXTURE_WORKSPACE_ID,
} from './setup.ts';

async function makeTask(title: string): Promise<string> {
  const res = await createTask(db, {
    req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title },
    actorId: FIXTURE_ACTOR_ID,
    workspaceId: FIXTURE_WORKSPACE_ID,
  });
  return res.task.id;
}

describe('EC-3: removeDependency auto-unblock', () => {
  it('reverts blocked task to todo when last dependency is removed', async () => {
    const aId = await makeTask('EC-3 A last dep');
    const bId = await makeTask('EC-3 B blocker');
    await addDependency(db, { fromTaskId: aId, toTaskId: bId, actorId: FIXTURE_ACTOR_ID, workspaceId: FIXTURE_WORKSPACE_ID });
    const afterAdd = await getTask(db, { req: { task_id: aId }, workspaceId: FIXTURE_WORKSPACE_ID });
    expect(afterAdd.task.status).toBe('blocked');

    await removeDependency(db, { fromTaskId: aId, toTaskId: bId, actorId: FIXTURE_ACTOR_ID, workspaceId: FIXTURE_WORKSPACE_ID });

    const { task } = await getTask(db, { req: { task_id: aId }, workspaceId: FIXTURE_WORKSPACE_ID });
    expect(task.status).toBe('todo');
  });

  it('does not unblock task when other unresolved dependencies remain', async () => {
    const aId = await makeTask('EC-3 A multi');
    const bId = await makeTask('EC-3 B blocker multi');
    const cId = await makeTask('EC-3 C blocker multi');
    await addDependency(db, { fromTaskId: aId, toTaskId: bId, actorId: FIXTURE_ACTOR_ID, workspaceId: FIXTURE_WORKSPACE_ID });
    await addDependency(db, { fromTaskId: aId, toTaskId: cId, actorId: FIXTURE_ACTOR_ID, workspaceId: FIXTURE_WORKSPACE_ID });
    await removeDependency(db, { fromTaskId: aId, toTaskId: bId, actorId: FIXTURE_ACTOR_ID, workspaceId: FIXTURE_WORKSPACE_ID });

    const { task } = await getTask(db, { req: { task_id: aId }, workspaceId: FIXTURE_WORKSPACE_ID });
    expect(task.status).toBe('blocked');
  });

  it('emits status_changed event when auto-unblocking', async () => {
    const aId = await makeTask('EC-3 A event');
    const bId = await makeTask('EC-3 B event');
    await addDependency(db, { fromTaskId: aId, toTaskId: bId, actorId: FIXTURE_ACTOR_ID, workspaceId: FIXTURE_WORKSPACE_ID });

    await removeDependency(db, { fromTaskId: aId, toTaskId: bId, actorId: FIXTURE_ACTOR_ID, workspaceId: FIXTURE_WORKSPACE_ID });

    const statusEvents = await db
      .select()
      .from(events)
      .where(and(eq(events.taskId, aId), eq(events.kind, 'status_changed')))
      .orderBy(desc(events.createdAt));

    expect(statusEvents.length).toBeGreaterThanOrEqual(1);
    const latest = statusEvents[0]!;
    const payload = latest.payload as { from?: string; to?: string };
    expect(payload.from).toBe('blocked');
    expect(payload.to).toBe('todo');
  });
});
