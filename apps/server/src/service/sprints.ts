// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — Sprint Planning service (D4).
//
// Sprint lifecycle: planning → active → completed.
// At most one active sprint per project (service-enforced).
// Sprint-task: a task may only belong to one non-completed (planning or active) sprint.
//
// assignToSprint and removeFromSprint live here (not in tasks.ts) to avoid
// circular imports: service/sprints.ts imports rowToTask from service/tasks.ts;
// service/tasks.ts does NOT import from service/sprints.ts.

import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '../db/client.ts';
import { events, sprints, sprintTasks, tasks } from '../db/schema.ts';
import type { SprintRow } from '../db/schema.ts';
import {
  type AssignToSprintReq,
  type AssignToSprintRes,
  type BurndownPoint,
  type RemoveFromSprintReq,
  type Sprint,
  type SprintCreateReq,
  type SprintCreateRes,
  type SprintGetReq,
  type SprintGetRes,
  type SprintListReq,
  type SprintListRes,
  type SprintTransitionReq,
  type SprintTransitionRes,
} from '../domain/index.ts';
import { checkIdempotency, hashRequest, recordOperation } from './idempotency.ts';
import { rowToTask, TaskNotFoundError } from './tasks.ts';

// ── Error classes ─────────────────────────────────────────────────────────

export class SprintNotFoundError extends Error {
  constructor(public readonly sprintId: string) {
    super(`sprint ${sprintId} not found`);
    this.name = 'SprintNotFoundError';
  }
}

export class SprintAlreadyActiveError extends Error {
  constructor(public readonly existingSprintId: string) {
    super(`project already has an active sprint: ${existingSprintId}`);
    this.name = 'SprintAlreadyActiveError';
  }
}

export class InvalidSprintTransitionError extends Error {
  constructor(
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`invalid sprint transition: ${from} → ${to}`);
    this.name = 'InvalidSprintTransitionError';
  }
}

export class TaskAlreadyInActiveSprintError extends Error {
  constructor(public readonly taskId: string) {
    super(`task ${taskId} is already assigned to a non-completed sprint`);
    this.name = 'TaskAlreadyInActiveSprintError';
  }
}

export class CrossProjectSprintError extends Error {
  constructor() {
    super('task and sprint must belong to the same project');
    this.name = 'CrossProjectSprintError';
  }
}

// ── Row converter ─────────────────────────────────────────────────────────

function rowToSprint(r: SprintRow): Sprint {
  return {
    id: r.id,
    project_id: r.projectId,
    name: r.name,
    status: r.status,
    starts_on: r.startsOn,
    ends_on: r.endsOn,
    version: r.version,
    created_by: r.createdBy,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

const VALID_TRANSITIONS: Record<string, string[]> = {
  planning: ['active'],
  active: ['completed'],
};

// ── Verbs ─────────────────────────────────────────────────────────────────

export async function createSprint(
  db: Db,
  args: { req: SprintCreateReq; actorId: string },
): Promise<SprintCreateRes> {
  const requestHash = hashRequest(args.req);
  const cached = await checkIdempotency(db, args.req.operation_id, requestHash);
  if (cached) return cached as SprintCreateRes;

  const id = uuidv7();
  const now = new Date();

  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(sprints)
        .values({
          id,
          projectId: args.req.project_id,
          name: args.req.name,
          status: 'planning',
          startsOn: args.req.starts_on,
          endsOn: args.req.ends_on,
          version: 1,
          createdBy: args.actorId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      const response: SprintCreateRes = { sprint: rowToSprint(row!) };

      await recordOperation(tx, {
        operationId: args.req.operation_id,
        actorId: args.actorId,
        requestHash,
        responseBody: response,
      });

      return response;
    });
  } catch (err) {
    const raced = await checkIdempotency(db, args.req.operation_id, requestHash);
    if (raced) return raced as SprintCreateRes;
    throw err;
  }
}

export async function activateSprint(
  db: Db,
  args: { req: SprintTransitionReq; actorId: string },
): Promise<SprintTransitionRes> {
  const requestHash = hashRequest(args.req);
  const cached = await checkIdempotency(db, args.req.operation_id, requestHash);
  if (cached) return cached as SprintTransitionRes;

  const now = new Date();

  try {
    return await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(sprints)
        .where(eq(sprints.id, args.req.sprint_id))
        .for('update');
      const current = rows[0];
      if (!current) throw new SprintNotFoundError(args.req.sprint_id);
      if (current.version !== args.req.if_match) {
        throw new Error(`version mismatch: expected ${args.req.if_match}, got ${current.version}`);
      }

      const allowed = VALID_TRANSITIONS[current.status] ?? [];
      if (!allowed.includes(args.req.to_status)) {
        throw new InvalidSprintTransitionError(current.status, args.req.to_status);
      }

      const activeRows = await tx
        .select({ id: sprints.id })
        .from(sprints)
        .where(and(eq(sprints.projectId, current.projectId), eq(sprints.status, 'active')))
        .limit(1);
      if (activeRows[0]) throw new SprintAlreadyActiveError(activeRows[0].id);

      const [updated] = await tx
        .update(sprints)
        .set({ status: 'active', version: current.version + 1, updatedAt: now })
        .where(and(eq(sprints.id, args.req.sprint_id), eq(sprints.version, args.req.if_match)))
        .returning();

      const response: SprintTransitionRes = { sprint: rowToSprint(updated!) };

      await recordOperation(tx, {
        operationId: args.req.operation_id,
        actorId: args.actorId,
        requestHash,
        responseBody: response,
      });

      return response;
    });
  } catch (err) {
    const raced = await checkIdempotency(db, args.req.operation_id, requestHash);
    if (raced) return raced as SprintTransitionRes;
    throw err;
  }
}

export async function closeSprint(
  db: Db,
  args: { req: SprintTransitionReq; actorId: string },
): Promise<SprintTransitionRes & { carry_over_tasks: ReturnType<typeof rowToTask>[] }> {
  const requestHash = hashRequest(args.req);
  const cached = await checkIdempotency(db, args.req.operation_id, requestHash);
  if (cached) return cached as SprintTransitionRes & { carry_over_tasks: ReturnType<typeof rowToTask>[] };

  const now = new Date();

  try {
    return await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(sprints)
        .where(eq(sprints.id, args.req.sprint_id))
        .for('update');
      const current = rows[0];
      if (!current) throw new SprintNotFoundError(args.req.sprint_id);
      if (current.version !== args.req.if_match) {
        throw new Error(`version mismatch: expected ${args.req.if_match}, got ${current.version}`);
      }

      const allowed = VALID_TRANSITIONS[current.status] ?? [];
      if (!allowed.includes(args.req.to_status)) {
        throw new InvalidSprintTransitionError(current.status, args.req.to_status);
      }

      const stRows = await tx
        .select({ taskId: sprintTasks.taskId })
        .from(sprintTasks)
        .where(eq(sprintTasks.sprintId, args.req.sprint_id));

      const taskIds = stRows.map((r) => r.taskId);
      const carryOverRows =
        taskIds.length > 0
          ? await tx
              .select()
              .from(tasks)
              .where(and(inArray(tasks.id, taskIds), sql`${tasks.status} != 'done'`))
          : [];

      const [updated] = await tx
        .update(sprints)
        .set({ status: 'completed', version: current.version + 1, updatedAt: now })
        .where(and(eq(sprints.id, args.req.sprint_id), eq(sprints.version, args.req.if_match)))
        .returning();

      const response = {
        sprint: rowToSprint(updated!),
        carry_over_tasks: carryOverRows.map(rowToTask),
      };

      await recordOperation(tx, {
        operationId: args.req.operation_id,
        actorId: args.actorId,
        requestHash,
        responseBody: response,
      });

      return response;
    });
  } catch (err) {
    const raced = await checkIdempotency(db, args.req.operation_id, requestHash);
    if (raced) return raced as SprintTransitionRes & { carry_over_tasks: ReturnType<typeof rowToTask>[] };
    throw err;
  }
}

export async function listSprints(
  db: Db,
  args: { req: SprintListReq },
): Promise<SprintListRes> {
  const conditions: ReturnType<typeof eq>[] = [eq(sprints.projectId, args.req.project_id)];
  if (args.req.status) {
    conditions.push(eq(sprints.status, args.req.status));
  }
  const rows = await db.select().from(sprints).where(and(...conditions));
  return { sprints: rows.map(rowToSprint) };
}

export async function getSprint(
  db: Db,
  args: { req: SprintGetReq },
): Promise<SprintGetRes> {
  const rows = await db.select().from(sprints).where(eq(sprints.id, args.req.sprint_id));
  const sprint = rows[0];
  if (!sprint) throw new SprintNotFoundError(args.req.sprint_id);

  const stRows = await db
    .select({ taskId: sprintTasks.taskId })
    .from(sprintTasks)
    .where(eq(sprintTasks.sprintId, args.req.sprint_id));

  const taskIds = stRows.map((r) => r.taskId);
  const sprintTaskRows =
    taskIds.length > 0
      ? await db.select().from(tasks).where(inArray(tasks.id, taskIds))
      : [];

  const allHavePoints =
    sprintTaskRows.length > 0 && sprintTaskRows.every((t) => t.points !== null);
  const burndownMetric: 'tasks' | 'points' = allHavePoints ? 'points' : 'tasks';

  // V1 simplification: uses current task status for all days (no event replay).
  const startsOn = new Date(sprint.startsOn);
  const endsOn = new Date(sprint.endsOn);
  const today = new Date();
  const endDate = today < endsOn ? today : endsOn;

  const burndownSeries: BurndownPoint[] = [];
  const cursor = new Date(startsOn);
  while (cursor <= endDate) {
    const dateStr = cursor.toISOString().slice(0, 10);
    const remaining = allHavePoints
      ? sprintTaskRows
          .filter((t) => t.status !== 'done')
          .reduce((sum, t) => sum + (t.points ?? 0), 0)
      : sprintTaskRows.filter((t) => t.status !== 'done').length;
    burndownSeries.push({ date: dateStr, remaining });
    cursor.setDate(cursor.getDate() + 1);
  }

  return {
    sprint: rowToSprint(sprint),
    tasks: sprintTaskRows.map(rowToTask),
    burndown_series: burndownSeries,
    burndown_metric: burndownMetric,
  };
}

export async function assignToSprint(
  db: Db,
  args: { req: AssignToSprintReq; actorId: string },
): Promise<AssignToSprintRes> {
  return await db.transaction(async (tx) => {
    const now = new Date();

    const sprintRows = await tx.select().from(sprints).where(eq(sprints.id, args.req.sprint_id));
    const sprint = sprintRows[0];
    if (!sprint) throw new SprintNotFoundError(args.req.sprint_id);

    const taskRows = await tx.select().from(tasks).where(eq(tasks.id, args.req.task_id));
    const task = taskRows[0];
    if (!task) throw new TaskNotFoundError(args.req.task_id);

    if (sprint.projectId !== task.projectId) throw new CrossProjectSprintError();

    const existingNonCompleted = await tx
      .select({ sprintId: sprintTasks.sprintId })
      .from(sprintTasks)
      .innerJoin(sprints, eq(sprints.id, sprintTasks.sprintId))
      .where(
        and(
          eq(sprintTasks.taskId, args.req.task_id),
          ne(sprintTasks.sprintId, args.req.sprint_id),
          inArray(sprints.status, ['active', 'planning']),
        ),
      );
    if (existingNonCompleted.length > 0) {
      throw new TaskAlreadyInActiveSprintError(args.req.task_id);
    }

    await tx
      .insert(sprintTasks)
      .values({ sprintId: args.req.sprint_id, taskId: args.req.task_id, addedAt: now })
      .onConflictDoNothing();

    await tx.insert(events).values({
      id: uuidv7(),
      taskId: args.req.task_id,
      actorId: args.actorId,
      kind: 'context_updated',
      payload: { field: 'sprint_id', new: args.req.sprint_id },
      operationId: uuidv7(),
      createdAt: now,
    });

    return { task: rowToTask(task) };
  });
}

export async function removeFromSprint(
  db: Db,
  args: { req: RemoveFromSprintReq; actorId: string },
): Promise<void> {
  const now = new Date();

  await db
    .delete(sprintTasks)
    .where(
      and(
        eq(sprintTasks.sprintId, args.req.sprint_id),
        eq(sprintTasks.taskId, args.req.task_id),
      ),
    );

  const taskRows = await db.select().from(tasks).where(eq(tasks.id, args.req.task_id));
  if (taskRows[0]) {
    await db.insert(events).values({
      id: uuidv7(),
      taskId: args.req.task_id,
      actorId: args.actorId,
      kind: 'context_updated',
      payload: { field: 'sprint_id', new: null },
      operationId: uuidv7(),
      createdAt: now,
    });
  }
}
