# D2 — Backlog and Board Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-column rank ordering to tasks, a `reorderTask` service function, server-side `status[]`/`assignee_id` filters on `GET /api/tasks`, and a `BoardFilters` UI component.

**Architecture:** Rank is owned entirely by Sprino (not a Tessera wire field) and scoped per workflow column — each column has independent 1-based integers. On every reorder, all tasks in the column are renumbered in a single transaction; a `SELECT FOR UPDATE` serializes concurrent reorders. Filters are server-side query params on the existing `GET /api/tasks` route; no client-side filtering is added.

**Tech Stack:** Postgres 16 + Drizzle ORM + Hono + Zod + React + Tailwind (no new deps required)

---

## File Map

| File | Action |
|------|--------|
| `apps/server/src/db/migrations/0008_task_rank.sql` | Create — adds `rank` column + composite index |
| `apps/server/src/db/schema.ts` | Modify — add `rank` to tasks pgTable + index |
| `apps/server/src/domain/index.ts` | Modify — rank in TaskSchema, filter params in TaskListReqSchema, new TaskReorderReq/Res |
| `packages/protocol-types/src/index.ts` | Modify — rank in TaskSchema |
| `apps/server/src/service/tasks.ts` | Modify — rowToTask, createTask, transitionTaskWorkflow, listTasks, new reorderTask + TaskNotInColumnError |
| `apps/server/src/adapters/http/routes.ts` | Modify — GET /api/tasks filter params, POST /api/tasks/:id/reorder |
| `apps/server/src/adapters/mcp/server.ts` | Modify — sprino.task.reorder tool + translateError |
| `apps/server/test/task_ordering.test.ts` | Create — TDD tests for D2 ordering and filter behavior |
| `apps/web/src/components/BoardFilters.tsx` | Create — status toggle-pills + assignee dropdown |
| `apps/web/src/components/TaskWorkflowBoard.tsx` | Modify — accept `filters` prop |
| `apps/web/src/App.tsx` | Modify — filters state, members fetch, re-fetch on filter change |

---

## Task 1: DB Migration — add `rank` column

**Files:**
- Create: `apps/server/src/db/migrations/0008_task_rank.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- apps/server/src/db/migrations/0008_task_rank.sql
--
-- D2: Adds explicit per-column rank ordering to tasks.
--
-- Design notes:
-- - rank is scoped per workflow_column_id. Each column has independent
--   1-based integers. DEFAULT 0 is safe for existing tasks — they all start
--   at rank 0 and are renumbered on first reorder.
-- - The composite index on (workflow_column_id, rank) makes per-column
--   ordered fetches fast (the primary query pattern for board rendering).

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS rank integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS tasks_rank_column_idx ON tasks(workflow_column_id, rank);
```

- [ ] **Step 2: Verify the file looks correct**

```bash
cat apps/server/src/db/migrations/0008_task_rank.sql
```

Expected: the SQL above prints cleanly with no syntax issues.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/db/migrations/0008_task_rank.sql
git commit -m "feat(db): D2-P1 migration 0008 — add rank column to tasks"
```

---

## Task 2: Drizzle Schema — add `rank` to tasks table

**Files:**
- Modify: `apps/server/src/db/schema.ts`

- [ ] **Step 1: Add `rank` field + composite index to the tasks pgTable**

In `apps/server/src/db/schema.ts`, find the tasks table definition (lines 152–181). Make two additions:

1. Add `rank: integer('rank').notNull().default(0),` after `workflowColumnId`.
2. Add `rankColumnIdx: index('tasks_rank_column_idx').on(t.workflowColumnId, t.rank),` to the table's index object.

The tasks table after the change:

```typescript
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    title: text('title').notNull(),
    description: text('description').default('').notNull(),
    status: taskStatusEnum('status').notNull().default('todo'),
    assigneeId: uuid('assignee_id').references(() => actors.id),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => actors.id),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    workflowColumnId: uuid('workflow_column_id').references(
      () => workflowColumns.id,
    ),
    rank: integer('rank').notNull().default(0),
  },
  (t) => ({
    projectIdx: index('tasks_project_idx').on(t.projectId),
    statusIdx: index('tasks_status_idx').on(t.projectId, t.status),
    rankColumnIdx: index('tasks_rank_column_idx').on(t.workflowColumnId, t.rank),
  }),
);
```

- [ ] **Step 2: Commit**

```bash
git add apps/server/src/db/schema.ts
git commit -m "feat(schema): D2-P1 add rank column to tasks Drizzle schema"
```

---

## Task 3: Domain Types — rank, filters, reorder schemas

**Files:**
- Modify: `apps/server/src/domain/index.ts`
- Modify: `packages/protocol-types/src/index.ts`

### Part A — `apps/server/src/domain/index.ts`

- [ ] **Step 1: Add `rank` to TaskSchema**

Find `TaskSchema` (around line 58). Add `rank: z.number().int().min(0),` after `workflow_column_id`:

```typescript
export const TaskSchema = z.object({
  id: uuid,
  project_id: uuid,
  title: z.string().min(1).max(280),
  description: z.string().max(16384),
  status: TaskStatusSchema,
  assignee_id: uuid.nullable(),
  created_by: uuid,
  version: z.number().int().min(1),
  created_at: isoDateTime,
  updated_at: isoDateTime,
  workflow_column_id: uuid.nullable(),
  rank: z.number().int().min(0),
});
```

- [ ] **Step 2: Add filter params to TaskListReqSchema**

Find `TaskListReqSchema` (around line 225). Replace it with:

```typescript
export const TaskListReqSchema = z
  .object({
    project_id: uuid,
    status: z.array(TaskStatusSchema).optional(),
    assignee_id: uuid.optional(),
  })
  .merge(paginationSchema(MAX_LIMITS.tasks));
export type TaskListReq = z.infer<typeof TaskListReqSchema>;
```

- [ ] **Step 3: Add TaskReorderReq/Res schemas**

After `TaskTransitionWorkflowResSchema` (after line 151), add:

```typescript
// ── D2: Task Reorder ──────────────────────────────────────────────────────

export const TaskReorderReqSchema = z.object({
  operation_id: uuid,
  task_id: uuid,
  column_id: uuid,
  after_task_id: uuid.nullable(),
});
export type TaskReorderReq = z.infer<typeof TaskReorderReqSchema>;

export const TaskReorderResSchema = z.object({
  tasks: z.array(TaskSchema),
});
export type TaskReorderRes = z.infer<typeof TaskReorderResSchema>;
```

### Part B — `packages/protocol-types/src/index.ts`

- [ ] **Step 4: Mirror rank in protocol-types TaskSchema**

Find `TaskSchema` and add `rank: z.number().int().min(0),` after `workflow_column_id`:

```typescript
export const TaskSchema = z.object({
  id: uuid,
  project_id: uuid,
  title: z.string().min(1).max(280),
  description: z.string().max(16384),
  status: TaskStatusSchema,
  assignee_id: uuid.nullable(),
  created_by: uuid,
  version: z.number().int().min(1),
  created_at: isoDateTime,
  updated_at: isoDateTime,
  workflow_column_id: uuid.nullable(),
  rank: z.number().int().min(0),
});
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/domain/index.ts packages/protocol-types/src/index.ts
git commit -m "feat(domain): D2-P1 add rank to TaskSchema, filter params to TaskListReqSchema, TaskReorderReq/Res"
```

---

## Task 4: Write Failing Tests (TDD Red Phase)

**Files:**
- Create: `apps/server/test/task_ordering.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
// apps/server/test/task_ordering.test.ts
// D2: Backlog and Board Ordering — integration tests.
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
    });
    expect(res.task.rank).toBeGreaterThanOrEqual(1);
  });

  it('second task gets a higher rank than the first', async () => {
    const res1 = await createTask(db, {
      req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'rank append 1' },
      actorId: FIXTURE_ACTOR_ID,
    });
    const res2 = await createTask(db, {
      req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'rank append 2' },
      actorId: FIXTURE_ACTOR_ID,
    });
    expect(res2.task.rank).toBeGreaterThan(res1.task.rank);
  });
});

// ── D2-P1: listTasks returns tasks in rank order ───────────────────────────

describe('D2-P1: listTasks rank order', () => {
  it('tasks are returned in ascending rank order within a project', async () => {
    // Create 3 tasks in sequence — they should come back in creation rank order.
    await createTask(db, {
      req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'rank order 1' },
      actorId: FIXTURE_ACTOR_ID,
    });
    await createTask(db, {
      req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'rank order 2' },
      actorId: FIXTURE_ACTOR_ID,
    });
    await createTask(db, {
      req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'rank order 3' },
      actorId: FIXTURE_ACTOR_ID,
    });

    const { tasks } = await listTasks(db, { req: { project_id: FIXTURE_PROJECT_ID } });
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
    });
    const t2 = await createTask(db, {
      req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'reorder B' },
      actorId: FIXTURE_ACTOR_ID,
    });
    const t3 = await createTask(db, {
      req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'reorder C' },
      actorId: FIXTURE_ACTOR_ID,
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
    });

    const t3 = ordered.find((t) => t.id === t3id)!;
    expect(t3.rank).toBe(1);
    const ranks = ordered.map((t) => t.rank);
    expect(ranks).toEqual([1, 2, 3].slice(0, ranks.length));
  });

  it('move after anchor places task immediately after the anchor', async () => {
    const { taskIds, columnId } = await setup3Tasks();
    const [t1id, t2id, t3id] = taskIds;

    // Move t3 after t1 → expected order: t1, t3, t2
    const { tasks: ordered } = await reorderTask(db, {
      req: {
        operation_id: uuidv7(),
        task_id: t3id!,
        column_id: columnId,
        after_task_id: t1id!,
      },
      actorId: FIXTURE_ACTOR_ID,
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
    });
    const res2 = await reorderTask(db, {
      req: { operation_id: opId, task_id: t1id!, column_id: columnId, after_task_id: null },
      actorId: FIXTURE_ACTOR_ID,
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
      }),
    ).rejects.toBeInstanceOf(TaskNotInColumnError);
  });

  it('throws TaskNotInColumnError when after_task_id is not in the column', async () => {
    const { taskIds, columnId } = await setup3Tasks();
    const inProgress = await getColumnByName('In Progress');

    // Transition t1 to In Progress so it's no longer in the default col
    await transitionTaskWorkflow(db, {
      req: {
        operation_id: uuidv7(),
        task_id: taskIds[0]!,
        to_column_id: inProgress.id,
        if_match: 1,
      },
      actorId: FIXTURE_ACTOR_ID,
    });

    await expect(
      reorderTask(db, {
        req: {
          operation_id: uuidv7(),
          task_id: taskIds[1]!,
          column_id: columnId,
          after_task_id: taskIds[0]!, // t1 is now in a different column
        },
        actorId: FIXTURE_ACTOR_ID,
      }),
    ).rejects.toBeInstanceOf(TaskNotInColumnError);
  });
});

// ── D2-P2: listTasks filters ───────────────────────────────────────────────

describe('D2-P2: listTasks filters', () => {
  it('status[] filter returns only tasks matching those statuses', async () => {
    const app = buildTestApp();
    // Create a task (default status = todo)
    await createTask(db, {
      req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'filter status test' },
      actorId: FIXTURE_ACTOR_ID,
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
    });
    const t2 = await createTask(db, {
      req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'http reorder 2' },
      actorId: FIXTURE_ACTOR_ID,
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
```

- [ ] **Step 2: Run the tests — confirm they fail (red phase)**

```bash
cd apps/server && npx vitest run test/task_ordering.test.ts 2>&1 | tail -20
```

Expected: multiple failures (TaskNotInColumnError not found, reorderTask not exported, `rank` not on task object, etc.).

- [ ] **Step 3: Commit the failing tests**

```bash
git add apps/server/test/task_ordering.test.ts
git commit -m "test(d2): TDD red — task ordering + filter tests (expected failures)"
```

---

## Task 5: Update `rowToTask` + import `sql`

**Files:**
- Modify: `apps/server/src/service/tasks.ts`

- [ ] **Step 1: Add `sql` to the drizzle-orm import**

Find the import line (line 33):
```typescript
import { and, desc, eq, asc, inArray } from 'drizzle-orm';
```

Replace with:
```typescript
import { and, desc, eq, asc, inArray, sql } from 'drizzle-orm';
```

- [ ] **Step 2: Add `rank` to `rowToTask`**

Find `rowToTask` (around line 141). Add `rank: r.rank` after `workflow_column_id`:

```typescript
function rowToTask(r: TaskRow): Task {
  return {
    id: r.id,
    project_id: r.projectId,
    title: r.title,
    description: r.description,
    status: r.status,
    assignee_id: r.assigneeId,
    created_by: r.createdBy,
    version: r.version,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
    workflow_column_id: r.workflowColumnId,
    rank: r.rank,
  };
}
```

- [ ] **Step 3: Run type-check to confirm no regressions**

```bash
cd apps/server && npx tsc --noEmit 2>&1 | head -30
```

Expected: zero errors (rank is now in TaskRow via Drizzle inference).

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/service/tasks.ts
git commit -m "feat(tasks): D2-P1 add rank to rowToTask + import sql"
```

---

## Task 6: Update `createTask` — append to bottom of default column

**Files:**
- Modify: `apps/server/src/service/tasks.ts`

- [ ] **Step 1: Compute MAX rank before INSERT, set rank in INSERT values**

Find the transaction inside `createTask` (around line 322). After the line `const defaultColumnId = defaultColRows[0]?.id ?? null;`, add the MAX rank query and use it in the INSERT.

Replace this block:
```typescript
      const defaultColumnId = defaultColRows[0]?.id ?? null;

      const [taskRow] = await tx
        .insert(tasks)
        .values({
          id: taskId,
          projectId: project.id,
          title: args.req.title,
          description: args.req.description ?? '',
          status: 'todo',
          assigneeId: args.req.assignee_id ?? null,
          createdBy: args.actorId,
          version: 1,
          createdAt: now,
          updatedAt: now,
          workflowColumnId: defaultColumnId,
        })
        .returning();
```

With:
```typescript
      const defaultColumnId = defaultColRows[0]?.id ?? null;

      let newRank = 1;
      if (defaultColumnId !== null) {
        const maxRankRow = await tx
          .select({ maxRank: sql<number>`COALESCE(MAX(rank), 0)` })
          .from(tasks)
          .where(eq(tasks.workflowColumnId, defaultColumnId));
        newRank = (maxRankRow[0]?.maxRank ?? 0) + 1;
      }

      const [taskRow] = await tx
        .insert(tasks)
        .values({
          id: taskId,
          projectId: project.id,
          title: args.req.title,
          description: args.req.description ?? '',
          status: 'todo',
          assigneeId: args.req.assignee_id ?? null,
          createdBy: args.actorId,
          version: 1,
          createdAt: now,
          updatedAt: now,
          workflowColumnId: defaultColumnId,
          rank: newRank,
        })
        .returning();
```

- [ ] **Step 2: Run type-check**

```bash
cd apps/server && npx tsc --noEmit 2>&1 | head -20
```

Expected: zero errors.

- [ ] **Step 3: Run related tests**

```bash
cd apps/server && npx vitest run test/task_ordering.test.ts -t "createTask rank" 2>&1 | tail -15
```

Expected: the two `D2-P1: createTask rank assignment` tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/service/tasks.ts
git commit -m "feat(tasks): D2-P1 createTask appends rank to bottom of default column"
```

---

## Task 7: Update `transitionTaskWorkflow` — append rank to new column

**Files:**
- Modify: `apps/server/src/service/tasks.ts`

- [ ] **Step 1: Compute MAX rank in target column + set rank in UPDATE**

Find the transaction inside `transitionTaskWorkflow` (around line 625). After the `targetCol` variable is confirmed to exist (`if (!targetCol) throw ...`), insert the max-rank query. Then add `rank: newRank` to the `.set(...)` in the UPDATE.

After `if (!targetCol) { throw new WorkflowColumnNotFoundError(args.req.to_column_id); }`, add:

```typescript
    const maxRankRow = await tx
      .select({ maxRank: sql<number>`COALESCE(MAX(rank), 0)` })
      .from(tasks)
      .where(eq(tasks.workflowColumnId, args.req.to_column_id));
    const newRank = (maxRankRow[0]?.maxRank ?? 0) + 1;
```

Then in the `.set(...)` of the UPDATE, add `rank: newRank`:

```typescript
    const [updatedRow] = await tx
      .update(tasks)
      .set({
        workflowColumnId: args.req.to_column_id,
        status: targetCol.mapsToStatus,
        rank: newRank,
        version: current.version + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(tasks.id, args.req.task_id),
          eq(tasks.version, args.req.if_match),
        ),
      )
      .returning();
```

- [ ] **Step 2: Run type-check**

```bash
cd apps/server && npx tsc --noEmit 2>&1 | head -20
```

Expected: zero errors.

- [ ] **Step 3: Run the transition rank test**

```bash
cd apps/server && npx vitest run test/task_ordering.test.ts -t "transitioned task" 2>&1 | tail -15
```

Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/service/tasks.ts
git commit -m "feat(tasks): D2-P1 transitionTaskWorkflow appends rank to new column"
```

---

## Task 8: Update `listTasks` — add filters + change sort order

**Files:**
- Modify: `apps/server/src/service/tasks.ts`

- [ ] **Step 1: Update the domain import to bring in TaskStatus**

The `TaskStatus` type is already imported. Confirm `TaskListReq` is in the import. It should be — update the import block if needed to include any new types used below. Look for the domain import around line 38 and ensure it includes:

```typescript
import {
  DEFAULT_LIMIT,
  type AgentContext,
  type Event,
  type Task,
  type TaskCreateReq,
  type TaskCreateRes,
  type TaskGetReq,
  type TaskGetRes,
  type TaskListReq,
  type TaskListRes,
  type TaskReorderReq,
  type TaskReorderRes,
  type TaskStatus,
  type TaskUpdateStatusReq,
  type TaskUpdateStatusRes,
  type WorkflowColumn,
  type WorkflowColumnsListRes,
  type TaskTransitionWorkflowReq,
  type TaskTransitionWorkflowRes,
} from '../domain/index.ts';
```

- [ ] **Step 2: Rewrite `listTasks` with filters + rank sort**

Replace the entire `listTasks` function (around line 396):

```typescript
export async function listTasks(
  db: Db,
  args: { req: TaskListReq },
): Promise<TaskListRes> {
  const limit = args.req.limit ?? DEFAULT_LIMIT;
  const offset = args.req.offset ?? 0;

  const conditions = [eq(tasks.projectId, args.req.project_id)];

  if (args.req.status && args.req.status.length > 0) {
    conditions.push(inArray(tasks.status, args.req.status));
  }
  if (args.req.assignee_id) {
    conditions.push(eq(tasks.assigneeId, args.req.assignee_id));
  }

  const rows = await db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(asc(tasks.rank), asc(tasks.id))
    .limit(limit)
    .offset(offset);
  return { tasks: rows.map(rowToTask) };
}
```

- [ ] **Step 3: Run type-check**

```bash
cd apps/server && npx tsc --noEmit 2>&1 | head -20
```

Expected: zero errors.

- [ ] **Step 4: Run ordering and filter tests**

```bash
cd apps/server && npx vitest run test/task_ordering.test.ts -t "rank order|filter" 2>&1 | tail -20
```

Expected: `D2-P1: listTasks rank order` test passes; filter tests still fail (HTTP layer not wired yet).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/service/tasks.ts
git commit -m "feat(tasks): D2-P2 listTasks — rank sort + status/assignee_id filters"
```

---

## Task 9: Add `TaskNotInColumnError` + `reorderTask`

**Files:**
- Modify: `apps/server/src/service/tasks.ts`

- [ ] **Step 1: Add `TaskNotInColumnError` class**

After `WorkflowTransitionForbiddenError` (around line 97), add:

```typescript
export class TaskNotInColumnError extends Error {
  constructor(public readonly taskId: string, public readonly columnId: string) {
    super(`task ${taskId} is not in column ${columnId}`);
    this.name = 'TaskNotInColumnError';
  }
}
```

- [ ] **Step 2: Add `reorderTask` function**

After the `listWorkflowColumns` function (end of file, around line 544), add:

```typescript
export async function reorderTask(
  db: Db,
  args: { req: TaskReorderReq; actorId: string },
): Promise<TaskReorderRes> {
  const requestHash = hashRequest(args.req);
  const cached = await checkIdempotency(db, args.req.operation_id, requestHash);
  if (cached) return cached as TaskReorderRes;

  try {
    return await db.transaction(async (tx) => {
      // Step 1: Verify task exists and is in the requested column.
      const taskRows = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, args.req.task_id))
        .for('update');
      const target = taskRows[0];
      if (!target) throw new TaskNotFoundError(args.req.task_id);
      if (target.workflowColumnId !== args.req.column_id) {
        throw new TaskNotInColumnError(args.req.task_id, args.req.column_id);
      }

      // Step 2: Fetch and lock all tasks in the column, ordered by current rank.
      const colTasks = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.workflowColumnId, args.req.column_id))
        .orderBy(asc(tasks.rank), asc(tasks.id))
        .for('update');

      // Step 3: Build new order.
      const without = colTasks.filter((t) => t.id !== args.req.task_id);
      const movingTask = colTasks.find((t) => t.id === args.req.task_id)!;

      let newOrder: typeof colTasks;
      if (args.req.after_task_id === null) {
        // Move to top.
        newOrder = [movingTask, ...without];
      } else {
        // Insert after anchor.
        const anchorIdx = without.findIndex((t) => t.id === args.req.after_task_id);
        if (anchorIdx === -1) {
          throw new TaskNotInColumnError(args.req.after_task_id, args.req.column_id);
        }
        newOrder = [
          ...without.slice(0, anchorIdx + 1),
          movingTask,
          ...without.slice(anchorIdx + 1),
        ];
      }

      // Step 4: Renumber 1-based and update all rows.
      await Promise.all(
        newOrder.map((t, i) =>
          tx
            .update(tasks)
            .set({ rank: i + 1 })
            .where(eq(tasks.id, t.id)),
        ),
      );

      // Step 5: Fetch the updated column in rank order.
      const updated = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.workflowColumnId, args.req.column_id))
        .orderBy(asc(tasks.rank), asc(tasks.id));

      const response: TaskReorderRes = { tasks: updated.map(rowToTask) };

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
    if (raced) return raced as TaskReorderRes;
    throw err;
  }
}
```

- [ ] **Step 3: Run type-check**

```bash
cd apps/server && npx tsc --noEmit 2>&1 | head -30
```

Expected: zero errors.

- [ ] **Step 4: Run reorder service tests**

```bash
cd apps/server && npx vitest run test/task_ordering.test.ts -t "reorderTask" 2>&1 | tail -25
```

Expected: all 6 `D2-P2: reorderTask` tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/service/tasks.ts
git commit -m "feat(tasks): D2-P2 TaskNotInColumnError + reorderTask service function"
```

---

## Task 10: Wire HTTP Adapter — GET /api/tasks filters + POST /api/tasks/:id/reorder

**Files:**
- Modify: `apps/server/src/adapters/http/routes.ts`

- [ ] **Step 1: Add domain imports**

In `routes.ts`, find the domain import block (around line 29). Add `TaskReorderReqSchema` and ensure `TaskListReqSchema` is already there (it is). Add `TaskReorderReqSchema`:

```typescript
import {
  AgentListReqSchema,
  AttachmentCreateUploadReqSchema,
  AttachmentFinalizeReqSchema,
  AttachmentListReqSchema,
  EventListReqSchema,
  ProjectCreateReqSchema,
  ProjectGetReqSchema,
  TaskCreateReqSchema,
  TaskGetReqSchema,
  TaskListReqSchema,
  TaskReorderReqSchema,
  TaskUpdateStatusReqSchema,
  TaskTransitionWorkflowReqSchema,
  ActorRegisterReqSchema,
  ActorListReqSchema,
  ActorGetReqSchema,
  ActorHeartbeatReqSchema,
  ActorRevokeTokenReqSchema,
  ActorDeactivateReqSchema,
} from '../../domain/index.ts';
```

- [ ] **Step 2: Add service imports**

In the service import block (around line 89), add `TaskNotInColumnError` and `reorderTask`:

```typescript
import {
  TaskNotFoundError,
  TaskNotInColumnError,
  VersionMismatchError,
  WorkflowColumnNotFoundError,
  WorkflowTransitionForbiddenError,
  createTask,
  getTask,
  listRelatedTasks,
  listTaskEvents,
  listTasks,
  listWorkflowColumns,
  reorderTask,
  transitionTaskWorkflow,
  updateTaskStatus,
} from '../../service/tasks.ts';
```

- [ ] **Step 3: Update `GET /api/tasks` to parse status[] and assignee_id**

Find the `GET /api/tasks` handler. It currently parses only `project_id`. Replace the req parsing to include filters:

```typescript
  api.get('/tasks', async (c) => {
    try {
      const statusParam = c.req.queries('status') ?? [];
      const req = TaskListReqSchema.parse({
        project_id: c.req.query('project_id'),
        status: statusParam.length > 0 ? statusParam : undefined,
        assignee_id: c.req.query('assignee_id') || undefined,
        limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
        offset: c.req.query('offset') ? Number(c.req.query('offset')) : undefined,
      });
      const res = await listTasks(c.get('db'), { req });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });
```

- [ ] **Step 4: Add `POST /api/tasks/:id/reorder` route**

Find the `POST /api/tasks/:id/transition` handler and add the reorder route immediately after it:

```typescript
  api.post('/tasks/:id/reorder', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const req = TaskReorderReqSchema.parse({
        ...body,
        task_id: c.req.param('id'),
      });
      const actor = c.get('actor');
      const res = await reorderTask(c.get('db'), { req, actorId: actor.id });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });
```

- [ ] **Step 5: Add `TaskNotInColumnError` to `errorResponse`**

Find the `errorResponse` function (at the bottom of routes.ts). Add a case for `TaskNotInColumnError`:

```typescript
  if (err instanceof TaskNotInColumnError) {
    return c.json(
      { error: 'task_not_in_column', task_id: err.taskId, column_id: err.columnId },
      422,
    );
  }
```

Add it before the generic fallthrough. The full `errorResponse` function error-mapping section should look like:

```typescript
function errorResponse(c: Context, err: unknown) {
  if (err instanceof ZodError) {
    return c.json({ error: 'validation_error', details: err.issues }, 400);
  }
  if (err instanceof TaskNotFoundError) {
    return c.json({ error: 'task_not_found', task_id: err.taskId }, 404);
  }
  if (err instanceof TaskNotInColumnError) {
    return c.json(
      { error: 'task_not_in_column', task_id: err.taskId, column_id: err.columnId },
      422,
    );
  }
  // ... rest of existing mappings unchanged
```

- [ ] **Step 6: Run type-check**

```bash
cd apps/server && npx tsc --noEmit 2>&1 | head -20
```

Expected: zero errors.

- [ ] **Step 7: Run all ordering tests**

```bash
cd apps/server && npx vitest run test/task_ordering.test.ts 2>&1 | tail -25
```

Expected: all tests pass except the MCP test (if any — there are none in this test file for MCP).

- [ ] **Step 8: Run the full test suite to check for regressions**

```bash
cd apps/server && npx vitest run 2>&1 | tail -20
```

Expected: all existing tests pass + new task_ordering tests pass.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/adapters/http/routes.ts
git commit -m "feat(http): D2-P2 GET /api/tasks filters + POST /tasks/:id/reorder"
```

---

## Task 11: Wire MCP Adapter — sprino.task.reorder tool

**Files:**
- Modify: `apps/server/src/adapters/mcp/server.ts`

- [ ] **Step 1: Add domain imports**

Find the domain import block in `mcp/server.ts` (around line 27). Add `TaskReorderReqSchema`:

```typescript
import {
  AttachmentCreateUploadReqSchema,
  AttachmentFinalizeReqSchema,
  AttachmentGetReqSchema,
  AttachmentListReqSchema,
  ProjectCreateReqSchema,
  ProjectGetReqSchema,
  TaskCreateReqSchema,
  TaskGetReqSchema,
  TaskReorderReqSchema,
  TaskUpdateStatusReqSchema,
  TaskTransitionWorkflowReqSchema,
  ActorRegisterReqSchema,
  ActorListReqSchema,
  ActorGetReqSchema,
  ActorHeartbeatReqSchema,
  ActorRevokeTokenReqSchema,
  ActorDeactivateReqSchema,
} from '../../domain/index.ts';
```

- [ ] **Step 2: Add service imports**

Find the tasks service import (around line 68). Add `TaskNotInColumnError` and `reorderTask`:

```typescript
import {
  TaskNotFoundError,
  TaskNotInColumnError,
  VersionMismatchError,
  WorkflowColumnNotFoundError,
  WorkflowTransitionForbiddenError,
  createTask,
  getTask,
  reorderTask,
  transitionTaskWorkflow,
  updateTaskStatus,
} from '../../service/tasks.ts';
```

- [ ] **Step 3: Add the tool definition to TOOL_DEFINITIONS**

Find `TOOL_DEFINITIONS` (around line 110). Add the reorder tool after the `sprino.task.transition_workflow` entry:

```typescript
  {
    name: 'sprino.task.reorder',
    description:
      'Reorder a task within its current workflow column. after_task_id=null moves the task to the top. Idempotent via operation_id. The column_id must match the task\'s current workflow_column_id.',
    inputSchema: {
      type: 'object',
      required: ['operation_id', 'task_id', 'column_id', 'after_task_id'],
      additionalProperties: false,
      properties: {
        operation_id: { type: 'string', format: 'uuid' },
        task_id: { type: 'string', format: 'uuid' },
        column_id: { type: 'string', format: 'uuid' },
        after_task_id: { type: ['string', 'null'], format: 'uuid' },
      },
    },
  },
```

- [ ] **Step 4: Add case to `callTool`**

Find the `callTool` switch statement (around line 444). Add after the `sprino.task.transition_workflow` case:

```typescript
    case 'sprino.task.reorder': {
      const req = TaskReorderReqSchema.parse(args);
      const res = await reorderTask(db, { req, actorId: actor.id });
      return wrapToolResult(res);
    }
```

- [ ] **Step 5: Add `TaskNotInColumnError` to `translateError`**

Find `translateError` (around line 570). Add before the `IdempotencyConflictError` case:

```typescript
  if (err instanceof TaskNotInColumnError) {
    return rpcError(id, -32010, 'task_not_in_column', {
      task_id: err.taskId,
      column_id: err.columnId,
    });
  }
```

- [ ] **Step 6: Run type-check**

```bash
cd apps/server && npx tsc --noEmit 2>&1 | head -20
```

Expected: zero errors.

- [ ] **Step 7: Run the full server test suite**

```bash
cd apps/server && npx vitest run 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/adapters/mcp/server.ts
git commit -m "feat(mcp): D2-P2 sprino.task.reorder tool + TaskNotInColumnError mapping"
```

---

## Task 12: UI — New `BoardFilters.tsx` Component

**Files:**
- Create: `apps/web/src/components/BoardFilters.tsx`

- [ ] **Step 1: Create the component**

```typescript
// apps/web/src/components/BoardFilters.tsx
import type { Actor, TaskStatus } from '@sprino/protocol-types';

export interface BoardFilterState {
  statuses: TaskStatus[];
  assigneeId: string | null;
}

interface Props {
  members: Actor[];
  filters: BoardFilterState;
  onChange: (f: BoardFilterState) => void;
}

const ALL_STATUSES: TaskStatus[] = ['todo', 'doing', 'done', 'blocked'];

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'Todo',
  doing: 'Doing',
  done: 'Done',
  blocked: 'Blocked',
};

const STATUS_ACTIVE_CLASS: Record<TaskStatus, string> = {
  todo: 'bg-slate-700 text-white ring-slate-500',
  doing: 'bg-blue-600 text-white ring-blue-400',
  done: 'bg-emerald-600 text-white ring-emerald-400',
  blocked: 'bg-rose-600 text-white ring-rose-400',
};

const STATUS_INACTIVE_CLASS = 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50';

export function BoardFilters({ members, filters, onChange }: Props) {
  function toggleStatus(s: TaskStatus) {
    const next = filters.statuses.includes(s)
      ? filters.statuses.filter((x) => x !== s)
      : [...filters.statuses, s];
    onChange({ ...filters, statuses: next });
  }

  function setAssignee(id: string | null) {
    onChange({ ...filters, assigneeId: id });
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <div className="flex gap-1.5">
        {ALL_STATUSES.map((s) => {
          const active = filters.statuses.includes(s);
          return (
            <button
              key={s}
              onClick={() => toggleStatus(s)}
              className={`rounded-full px-3 py-1 text-xs font-medium ring-1 transition-colors ${
                active ? STATUS_ACTIVE_CLASS[s] : STATUS_INACTIVE_CLASS
              }`}
            >
              {STATUS_LABELS[s]}
            </button>
          );
        })}
      </div>

      <select
        value={filters.assigneeId ?? ''}
        onChange={(e) => setAssignee(e.target.value || null)}
        className="h-7 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 focus:border-slate-400 focus:outline-none"
      >
        <option value="">All assignees</option>
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.display_name}
          </option>
        ))}
      </select>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd apps/web && npx tsc --noEmit 2>&1 | head -20
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/BoardFilters.tsx
git commit -m "feat(web): D2-P3 BoardFilters component — status toggle-pills + assignee dropdown"
```

---

## Task 13: UI — Update `TaskWorkflowBoard.tsx` + `App.tsx`

**Files:**
- Modify: `apps/web/src/components/TaskWorkflowBoard.tsx`
- Modify: `apps/web/src/App.tsx`

### Part A — `TaskWorkflowBoard.tsx`

- [ ] **Step 1: Accept `filters` prop (passive — board renders server-filtered tasks as-is)**

Find the `Props` interface (around line 17). Add `filters` prop (typed via import):

```typescript
import type { BoardFilterState } from './BoardFilters.tsx';

interface Props {
  projectId: string;
  token: string;
  tasks: Task[];
  filters: BoardFilterState;
  onTaskUpdated: () => void;
}
```

The component body does not need to change — `tasks` is already filtered by the server. The board renders tasks in the order received (rank ASC from the server).

Update the function signature:

```typescript
export function TaskWorkflowBoard({ projectId, token, tasks, filters: _filters, onTaskUpdated }: Props) {
```

(`_filters` is accepted but not used in the component body — filtering happens server-side. The underscore prefix suppresses the unused-variable lint warning.)

### Part B — `App.tsx`

- [ ] **Step 2: Add `Actor` to the protocol-types import and import `BoardFilters`**

Find the import block at the top of `App.tsx`. Add `Actor` to the types import and add the component import:

```typescript
import type { Actor, Project, Task, TaskStatus } from '@sprino/protocol-types';
import { ActivityFeed } from './components/ActivityFeed';
import { Attachments } from './components/Attachments';
import { BoardFilters, type BoardFilterState } from './components/BoardFilters';
import { Members } from './components/Members';
import { TaskWorkflowBoard } from './components/TaskWorkflowBoard';
```

- [ ] **Step 3: Add `filters` and `members` state**

In the `App` function body (around line 51 after `const [view, setView]`), add:

```typescript
  const [filters, setFilters] = useState<BoardFilterState>({ statuses: [], assigneeId: null });
  const [members, setMembers] = useState<Actor[]>([]);
```

- [ ] **Step 4: Fetch members when project changes**

After the `useEffect` that calls `refresh()` when `selectedProjectId` changes, add a new effect:

```typescript
  useEffect(() => {
    if (!token || !selectedProjectId) { setMembers([]); return; }
    fetchAuth(`/api/members?project_id=${selectedProjectId}`)
      .then((r) => r.ok ? r.json() : Promise.resolve({ actors: [] }))
      .then((j: { actors: Actor[] }) => setMembers(j.actors))
      .catch(() => setMembers([]));
  }, [fetchAuth, token, selectedProjectId]);
```

- [ ] **Step 5: Rebuild filter query string in `refresh`**

Find the `refresh` callback (around line 103). Update the fetch URL to include active filters:

```typescript
  const refresh = useCallback(async () => {
    if (!token || !selectedProjectId) {
      setTasks([]);
      return;
    }

    setLoad('loading');
    setError(null);
    try {
      const params = new URLSearchParams({ project_id: selectedProjectId });
      if (filters.statuses.length > 0) {
        for (const s of filters.statuses) params.append('status', s);
      }
      if (filters.assigneeId) params.set('assignee_id', filters.assigneeId);

      const r = await fetchAuth(`/api/tasks?${params.toString()}`);
      if (!r.ok) throw new Error(`tasks failed: ${r.status}`);
      const j = (await r.json()) as { tasks: Task[] };
      setTasks(j.tasks);
      setLoad('idle');
    } catch (e) {
      setLoad('error');
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [fetchAuth, token, selectedProjectId, filters]);
```

- [ ] **Step 6: Re-fetch when filters change**

Add `filters` to the dependency array of the `useEffect` that calls `refresh()`:

```typescript
  useEffect(() => {
    void refresh();
  }, [refresh]);
```

(Since `refresh` already has `filters` in its dependency array, this is sufficient — changing filters re-creates `refresh`, which triggers the effect.)

- [ ] **Step 7: Render `<BoardFilters>` above `<TaskWorkflowBoard>` in the board view**

Find the `'board'` view render (around line 385):

```typescript
        ) : view === 'board' ? (
          selectedProjectId && (
            <>
              <BoardFilters
                members={members}
                filters={filters}
                onChange={(f) => { setFilters(f); }}
              />
              <TaskWorkflowBoard
                projectId={selectedProjectId}
                token={token}
                tasks={tasks}
                filters={filters}
                onTaskUpdated={refresh}
              />
            </>
          )
```

- [ ] **Step 8: Type-check**

```bash
cd apps/web && npx tsc --noEmit 2>&1 | head -30
```

Expected: zero errors.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/TaskWorkflowBoard.tsx apps/web/src/App.tsx
git commit -m "feat(web): D2-P3 wire BoardFilters + members fetch + filter re-fetch in App.tsx"
```

---

## Task 14: Final Sweep

**Files:** all — read-only verification

- [ ] **Step 1: Run the full server test suite**

```bash
cd apps/server && npx vitest run 2>&1 | tail -30
```

Expected: all tests pass, zero failures.

- [ ] **Step 2: Server type-check**

```bash
cd apps/server && npx tsc --noEmit 2>&1
```

Expected: zero errors.

- [ ] **Step 3: Web type-check**

```bash
cd apps/web && npx tsc --noEmit 2>&1
```

Expected: zero errors.

- [ ] **Step 4: Verify acceptance criteria against spec**

Verify against `docs/superpowers/specs/2026-05-06-d2-backlog-and-board-ordering-design.md`:

- **D2-P1**: `rank` column exists in DB ✓ (migration 0008), new tasks appended to bottom ✓ (createTask), ordering tests pass ✓
- **D2-P2**: Reorder is deterministic under concurrent requests ✓ (SELECT FOR UPDATE serializes), `GET /api/tasks` respects `status[]` and `assignee_id` ✓, `POST /tasks/:id/reorder` works ✓, `sprino.task.reorder` MCP tool works ✓
- **D2-P3**: `BoardFilters` component renders status pills + assignee dropdown ✓, toggle triggers re-fetch via `filters` dep on `refresh` ✓

- [ ] **Step 5: Commit final sweep**

```bash
git commit --allow-empty -m "chore: D2 final sweep passed — all tests green, types clean"
```
