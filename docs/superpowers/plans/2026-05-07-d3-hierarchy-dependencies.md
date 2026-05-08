# D3: Hierarchy and Dependency Management — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `parent_task_id` (structural subtask nesting, max 3 levels) and a `task_dependencies` table (blocked-by enforcement) to Sprino, with cycle detection, service guards, HTTP+MCP endpoints, and a hierarchy UI card component.

**Architecture:** Three packets (P1 schema, P2 service, P3 UI) mirror the D3 atomic jobs YAML. P1 writes the migration, Drizzle schema, and domain types, then runs TDD red. P2 wires service functions and adapters. P3 builds `TaskHierarchy.tsx` and integrates it into the board and activity feed.

**Tech Stack:** Drizzle ORM + Postgres 16, Hono HTTP adapter, MCP JSON-RPC adapter, Zod domain types, React + shadcn/ui (P3 only).

---

## File Map

| File | Change |
|---|---|
| `apps/server/src/db/migrations/0009_task_hierarchy.sql` | CREATE — new migration |
| `apps/server/src/db/migrations/meta/_journal.json` | MODIFY — add idx 9 entry |
| `apps/server/src/db/schema.ts` | MODIFY — add `parentTaskId` column + `taskDependencies` table |
| `apps/server/src/domain/index.ts` | MODIFY — `parent_task_id` on TaskSchema, 4 new Req/Res schemas |
| `apps/server/test/task_hierarchy.test.ts` | CREATE — 16 integration tests |
| `apps/server/src/service/tasks.ts` | MODIFY — 6 new error classes, 4 new functions, guard in `updateTaskStatus`, update `rowToTask` |
| `apps/server/src/adapters/http/routes.ts` | MODIFY — 4 new routes, 6 new error mappings in `errorResponse` |
| `apps/server/src/adapters/mcp/server.ts` | MODIFY — 4 new tool definitions + dispatch cases |
| `apps/server/test/conformance.test.ts` | MODIFY — update tools/list count 18 → 22 |
| `../tessera/schemas/resources/task.json` | MODIFY — add `parent_task_id` optional field |
| `apps/web/src/components/TaskHierarchy.tsx` | CREATE — collapsed badge → expanded subtask panel |
| `apps/web/src/components/TaskWorkflowBoard.tsx` | MODIFY — render `TaskHierarchy` in each card |
| `apps/web/src/components/ActivityFeed.tsx` | MODIFY — render hierarchy/dependency `context_updated` events |
| `apps/web/src/components/__tests__/task-hierarchy.test.tsx` | CREATE — 4 component tests |

---

## Task 1: Migration SQL + journal entry

**Files:**
- Create: `apps/server/src/db/migrations/0009_task_hierarchy.sql`
- Modify: `apps/server/src/db/migrations/meta/_journal.json`

- [ ] **Step 1: Create migration SQL**

```sql
-- apps/server/src/db/migrations/0009_task_hierarchy.sql
--
-- D3: Adds parent_task_id (task hierarchy) and task_dependencies (blocked-by).
--
-- parent_task_id:
--   Self-referential nullable FK. ON DELETE SET NULL means deleting a parent
--   does not cascade-delete children — they become root tasks. Max depth 3 is
--   enforced in service layer, not here.
--
-- task_dependencies:
--   Row (A, B) = "A is blocked by B". Composite PK prevents duplicate edges.
--   ON DELETE CASCADE for both FKs: deleting any task removes all edges
--   touching it. Index on to_task_id enables fast "what tasks does X block?"
--   queries.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS parent_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS task_dependencies (
  from_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  to_task_id   UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (from_task_id, to_task_id)
);

CREATE INDEX IF NOT EXISTS task_dependencies_to_idx
  ON task_dependencies(to_task_id);
```

- [ ] **Step 2: Add journal entry**

In `apps/server/src/db/migrations/meta/_journal.json`, append after the idx 8 entry (before the closing `]`):

```json
    ,
    {
      "idx": 9,
      "version": "7",
      "when": 1778140800000,
      "tag": "0009_task_hierarchy",
      "breakpoints": true
    }
```

The file's `entries` array must end with:
```json
    {
      "idx": 8,
      "version": "7",
      "when": 1777881600000,
      "tag": "0008_task_rank",
      "breakpoints": true
    },
    {
      "idx": 9,
      "version": "7",
      "when": 1778140800000,
      "tag": "0009_task_hierarchy",
      "breakpoints": true
    }
  ]
```

- [ ] **Step 3: Verify typecheck passes (migration is SQL only — no TS to check yet)**

```bash
cd apps/server && bun run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/db/migrations/0009_task_hierarchy.sql \
        apps/server/src/db/migrations/meta/_journal.json
git commit -m "feat(server): d3-p1 — migration 0009 task hierarchy + dependencies"
```

---

## Task 2: Drizzle schema

**Files:**
- Modify: `apps/server/src/db/schema.ts`

- [ ] **Step 1: Add `parentTaskId` column to the `tasks` table**

In `apps/server/src/db/schema.ts`, inside the `tasks` pgTable columns object (after `rank: integer('rank').notNull().default(0),`), add:

```typescript
    parentTaskId: uuid('parent_task_id').references(() => tasks.id),
```

The `tasks` table columns block should end with:
```typescript
    rank: integer('rank').notNull().default(0),
    parentTaskId: uuid('parent_task_id').references(() => tasks.id),
```

- [ ] **Step 2: Add `taskDependencies` table**

After the `workflowTransitions` table definition (and before the convenience exports block), add:

```typescript
export const taskDependencies = pgTable(
  'task_dependencies',
  {
    fromTaskId: uuid('from_task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    toTaskId: uuid('to_task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.fromTaskId, t.toTaskId] }),
    toTaskIdx: index('task_dependencies_to_idx').on(t.toTaskId),
  }),
);
```

- [ ] **Step 3: Add convenience type exports**

At the bottom of `apps/server/src/db/schema.ts` (after the existing type exports), add:

```typescript
export type TaskDependencyRow = typeof taskDependencies.$inferSelect;
export type NewTaskDependencyRow = typeof taskDependencies.$inferInsert;
```

- [ ] **Step 4: Verify typecheck**

```bash
cd apps/server && bun run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/schema.ts
git commit -m "feat(server): d3-p1 — drizzle schema: parentTaskId + taskDependencies"
```

---

## Task 3: Domain types

**Files:**
- Modify: `apps/server/src/domain/index.ts`

- [ ] **Step 1: Add `parent_task_id` to `TaskSchema`**

In `apps/server/src/domain/index.ts`, update `TaskSchema` to include `parent_task_id`. The current schema ends at `rank`. Change the object to add the new field:

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
  parent_task_id: uuid.nullable(),
});
export type Task = z.infer<typeof TaskSchema>;
```

- [ ] **Step 2: Add `TaskGetResSchema` `blocked_by` field**

Update `TaskGetResSchema` to include `blocked_by` (additive, optional — existing callers are unaffected):

```typescript
export const TaskGetResSchema = z.object({
  task: TaskSchema,
  agent_context: AgentContextSchema,
  blocked_by: z.array(TaskSchema).optional(),
});
export type TaskGetRes = z.infer<typeof TaskGetResSchema>;
```

- [ ] **Step 3: Add new D3 request/response schemas**

After the `TaskReorderResSchema` block (in the `── D2: Task Reorder ──` section), add a new `── D3: Hierarchy and Dependencies ──` section:

```typescript
// ── D3: Hierarchy and Dependencies ────────────────────────────────────────

export const SetParentReqSchema = z.object({
  task_id: uuid,
  parent_task_id: uuid.nullable(),
});
export type SetParentReq = z.infer<typeof SetParentReqSchema>;

export const SetParentResSchema = z.object({ task: TaskSchema });
export type SetParentRes = z.infer<typeof SetParentResSchema>;

export const AddDependencyReqSchema = z.object({
  task_id: uuid,
  blocked_by_task_id: uuid,
});
export type AddDependencyReq = z.infer<typeof AddDependencyReqSchema>;

export const AddDependencyResSchema = z.object({ task: TaskSchema });
export type AddDependencyRes = z.infer<typeof AddDependencyResSchema>;

export const RemoveDependencyReqSchema = z.object({
  task_id: uuid,
  blocked_by_task_id: uuid,
});
export type RemoveDependencyReq = z.infer<typeof RemoveDependencyReqSchema>;

export const ListDependenciesReqSchema = z.object({ task_id: uuid });
export type ListDependenciesReq = z.infer<typeof ListDependenciesReqSchema>;

export const ListDependenciesResSchema = z.object({
  blocked_by: z.array(TaskSchema),
});
export type ListDependenciesRes = z.infer<typeof ListDependenciesResSchema>;
```

- [ ] **Step 4: Verify typecheck**

```bash
cd apps/server && bun run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/domain/index.ts
git commit -m "feat(server): d3-p1 — domain types: parent_task_id + dependency schemas"
```

---

## Task 4: Write failing tests (TDD red phase)

**Files:**
- Create: `apps/server/test/task_hierarchy.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
// apps/server/test/task_hierarchy.test.ts
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

    await removeDependency(db, { fromTaskId: fromId, toTaskId: toId });

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
```

- [ ] **Step 2: Run tests — confirm they fail (red phase)**

```bash
cd apps/server && env TEST_DATABASE_URL=postgres://$(whoami)@localhost:5432/sprino_test bun run test -- task_hierarchy
```

Expected: all tests FAIL with `Cannot find module` or `is not a function` errors (the service functions don't exist yet).

- [ ] **Step 3: Commit red tests**

```bash
git add apps/server/test/task_hierarchy.test.ts
git commit -m "test(server): d3-p1 — failing hierarchy + dependency tests (TDD red)"
```

---

## Task 5: Service — error classes, helpers, `rowToTask` update

**Files:**
- Modify: `apps/server/src/service/tasks.ts`

- [ ] **Step 1: Add imports for the new table and types**

At the top of `apps/server/src/service/tasks.ts`, update the schema import line:

```typescript
import { events, taskDependencies, tasks, workflowColumns, workflowTransitions } from '../db/schema.ts';
import type { TaskRow, EventRow } from '../db/schema.ts';
```

And update the domain import to include D3 types:

```typescript
import {
  DEFAULT_LIMIT,
  type AddDependencyReq,
  type AddDependencyRes,
  type AgentContext,
  type Event,
  type ListDependenciesReq,
  type ListDependenciesRes,
  type RemoveDependencyReq,
  type SetParentReq,
  type SetParentRes,
  type Task,
  type TaskCreateReq,
  type TaskCreateRes,
  type TaskGetReq,
  type TaskGetRes,
  type TaskListReq,
  type TaskListRes,
  type TaskStatus,
  type TaskUpdateStatusReq,
  type TaskUpdateStatusRes,
  type WorkflowColumn,
  type WorkflowColumnsListRes,
  type TaskTransitionWorkflowReq,
  type TaskTransitionWorkflowRes,
  type TaskReorderReq,
  type TaskReorderRes,
} from '../domain/index.ts';
```

- [ ] **Step 2: Add 6 new error classes**

After `TaskNotInColumnError` and before `const RECENT_EVENTS_LIMIT = 20;`, add:

```typescript
export class HierarchyDepthExceededError extends Error {
  constructor() {
    super('task hierarchy cannot exceed 3 levels deep');
    this.name = 'HierarchyDepthExceededError';
  }
}

export class ParentCycleDetectedError extends Error {
  constructor() {
    super('setting this parent would create a hierarchy cycle');
    this.name = 'ParentCycleDetectedError';
  }
}

export class DependencyCycleDetectedError extends Error {
  constructor() {
    super('adding this dependency would create a cycle');
    this.name = 'DependencyCycleDetectedError';
  }
}

export class DependencyNotResolvedError extends Error {
  constructor() {
    super('task has unresolved dependencies — resolve them before changing status');
    this.name = 'DependencyNotResolvedError';
  }
}

export class ChildrenNotDoneError extends Error {
  constructor() {
    super('parent task cannot be marked done while children are not done');
    this.name = 'ChildrenNotDoneError';
  }
}

export class CrossProjectRelationError extends Error {
  constructor() {
    super('parent and dependency tasks must be in the same project');
    this.name = 'CrossProjectRelationError';
  }
}
```

- [ ] **Step 3: Update `rowToTask` to include `parent_task_id`**

Change `rowToTask` to:

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
    parent_task_id: r.parentTaskId,
  };
}
```

- [ ] **Step 4: Add graph helper functions**

Add two private helpers just before the `// ── Verbs ──` section:

```typescript
// ── D3: Graph helpers ─────────────────────────────────────────────────────

async function walkAncestors(
  db: SelectClient,
  startId: string,
): Promise<string[]> {
  const ancestors: string[] = [];
  const visited = new Set<string>();
  let currentId: string | null = startId;
  while (currentId !== null && !visited.has(currentId)) {
    visited.add(currentId);
    const rows = await db
      .select({ parentTaskId: tasks.parentTaskId })
      .from(tasks)
      .where(eq(tasks.id, currentId));
    const parentId = rows[0]?.parentTaskId ?? null;
    if (parentId !== null) ancestors.push(parentId);
    currentId = parentId;
  }
  return ancestors;
}

async function isReachableInDependencies(
  db: SelectClient,
  fromId: string,
  targetId: string,
): Promise<boolean> {
  const visited = new Set<string>();
  const queue: string[] = [fromId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === targetId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const edges = await db
      .select({ toTaskId: taskDependencies.toTaskId })
      .from(taskDependencies)
      .where(eq(taskDependencies.fromTaskId, current));
    for (const e of edges) queue.push(e.toTaskId);
  }
  return false;
}
```

- [ ] **Step 5: Verify typecheck**

```bash
cd apps/server && bun run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/service/tasks.ts
git commit -m "feat(server): d3-p1 — error classes, rowToTask parent_task_id, graph helpers"
```

---

## Task 6: Service — `setParent`, `addDependency`, `removeDependency`, `listDependencies`

**Files:**
- Modify: `apps/server/src/service/tasks.ts`

Add all four functions at the end of the file (after `reorderTask`), before the closing brace.

- [ ] **Step 1: Add `setParent`**

```typescript
export async function setParent(
  db: Db,
  args: { taskId: string; parentTaskId: string | null; actorId: string },
): Promise<SetParentRes> {
  const now = new Date();

  const taskRows = await db.select().from(tasks).where(eq(tasks.id, args.taskId));
  const current = taskRows[0];
  if (!current) throw new TaskNotFoundError(args.taskId);

  if (args.parentTaskId !== null) {
    const parentRows = await db.select().from(tasks).where(eq(tasks.id, args.parentTaskId));
    const parent = parentRows[0];
    if (!parent) throw new TaskNotFoundError(args.parentTaskId);
    if (parent.projectId !== current.projectId) throw new CrossProjectRelationError();

    const ancestors = await walkAncestors(db, args.parentTaskId);
    if (ancestors.includes(args.taskId)) throw new ParentCycleDetectedError();
    if (ancestors.length >= 2) throw new HierarchyDepthExceededError();
  }

  const prevParentId = current.parentTaskId;

  const [updated] = await db
    .update(tasks)
    .set({ parentTaskId: args.parentTaskId, updatedAt: now })
    .where(eq(tasks.id, args.taskId))
    .returning();

  await db.insert(events).values({
    id: uuidv7(),
    taskId: args.taskId,
    actorId: args.actorId,
    kind: 'context_updated',
    payload: { field: 'parent_task_id', old: prevParentId, new: args.parentTaskId },
    operationId: uuidv7(),
    createdAt: now,
  });

  return { task: rowToTask(updated!) };
}
```

- [ ] **Step 2: Add `addDependency`**

```typescript
export async function addDependency(
  db: Db,
  args: { fromTaskId: string; toTaskId: string; actorId: string },
): Promise<AddDependencyRes> {
  const now = new Date();

  const [fromRows, toRows] = await Promise.all([
    db.select().from(tasks).where(eq(tasks.id, args.fromTaskId)),
    db.select().from(tasks).where(eq(tasks.id, args.toTaskId)),
  ]);
  const fromTask = fromRows[0];
  const toTask = toRows[0];
  if (!fromTask) throw new TaskNotFoundError(args.fromTaskId);
  if (!toTask) throw new TaskNotFoundError(args.toTaskId);
  if (fromTask.projectId !== toTask.projectId) throw new CrossProjectRelationError();

  const wouldCycle = await isReachableInDependencies(db, args.toTaskId, args.fromTaskId);
  if (wouldCycle) throw new DependencyCycleDetectedError();

  await db
    .insert(taskDependencies)
    .values({ fromTaskId: args.fromTaskId, toTaskId: args.toTaskId, createdAt: now })
    .onConflictDoNothing();

  let updatedRow = fromTask;
  if (fromTask.status === 'todo' || fromTask.status === 'doing') {
    const [row] = await db
      .update(tasks)
      .set({ status: 'blocked', updatedAt: now })
      .where(eq(tasks.id, args.fromTaskId))
      .returning();
    updatedRow = row!;
  }

  await db.insert(events).values({
    id: uuidv7(),
    taskId: args.fromTaskId,
    actorId: args.actorId,
    kind: 'context_updated',
    payload: { field: 'dependency_added', blocked_by_task_id: args.toTaskId },
    operationId: uuidv7(),
    createdAt: now,
  });

  return { task: rowToTask(updatedRow) };
}
```

- [ ] **Step 3: Add `removeDependency`**

```typescript
export async function removeDependency(
  db: Db,
  args: { fromTaskId: string; toTaskId: string; actorId: string },
): Promise<void> {
  const now = new Date();

  await db
    .delete(taskDependencies)
    .where(
      and(
        eq(taskDependencies.fromTaskId, args.fromTaskId),
        eq(taskDependencies.toTaskId, args.toTaskId),
      ),
    );

  const taskRows = await db.select().from(tasks).where(eq(tasks.id, args.fromTaskId));
  const task = taskRows[0];
  if (!task) return;

  await db.insert(events).values({
    id: uuidv7(),
    taskId: args.fromTaskId,
    actorId: args.actorId,
    kind: 'context_updated',
    payload: { field: 'dependency_removed', blocked_by_task_id: args.toTaskId },
    operationId: uuidv7(),
    createdAt: now,
  });
}
```

- [ ] **Step 4: Add `listDependencies`**

```typescript
export async function listDependencies(
  db: SelectClient,
  args: { taskId: string },
): Promise<ListDependenciesRes> {
  const edges = await db
    .select({ toTaskId: taskDependencies.toTaskId })
    .from(taskDependencies)
    .where(eq(taskDependencies.fromTaskId, args.taskId));

  if (edges.length === 0) return { blocked_by: [] };

  const blockerIds = edges.map((e) => e.toTaskId);
  const blockerRows = await db
    .select()
    .from(tasks)
    .where(inArray(tasks.id, blockerIds));

  return { blocked_by: blockerRows.map(rowToTask) };
}
```

- [ ] **Step 5: Verify typecheck**

```bash
cd apps/server && bun run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/service/tasks.ts
git commit -m "feat(server): d3-p2 — setParent, addDependency, removeDependency, listDependencies"
```

---

## Task 7: Service — `updateTaskStatus` guards

**Files:**
- Modify: `apps/server/src/service/tasks.ts`

- [ ] **Step 1: Add dependency and children guards to `updateTaskStatus`**

In `updateTaskStatus`, inside the transaction (`await db.transaction(async (tx) => {`), after the version mismatch check and before inserting the event, add:

```typescript
      // D3-P2: Guard forward transitions against unresolved dependencies.
      if (args.req.status === 'doing' || args.req.status === 'done') {
        const unresolvedDeps = await tx
          .select({ id: taskDependencies.toTaskId })
          .from(taskDependencies)
          .innerJoin(tasks, eq(tasks.id, taskDependencies.toTaskId))
          .where(
            and(
              eq(taskDependencies.fromTaskId, args.req.task_id),
              // biome-ignore lint/suspicious/noExplicitAny: Drizzle sql tag
              sql`${tasks.status} != 'done'`,
            ),
          );
        if (unresolvedDeps.length > 0) throw new DependencyNotResolvedError();
      }

      // D3-P2: Guard done transition against children not done.
      if (args.req.status === 'done') {
        const undoneChildren = await tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(
            and(
              eq(tasks.parentTaskId, args.req.task_id),
              sql`${tasks.status} != 'done'`,
            ),
          );
        if (undoneChildren.length > 0) throw new ChildrenNotDoneError();
      }
```

The import line for `sql` is already present at the top of the file (`import { and, desc, eq, asc, inArray, sql } from 'drizzle-orm';`).

- [ ] **Step 2: Verify typecheck**

```bash
cd apps/server && bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Run tests — confirm D3-P1 and P2 service tests pass**

```bash
env TEST_DATABASE_URL=postgres://$(whoami)@localhost:5432/sprino_test bun run test -- task_hierarchy
```

Expected: all service-layer tests pass. HTTP tests still fail (routes not wired yet).

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/service/tasks.ts
git commit -m "feat(server): d3-p2 — updateTaskStatus guards: unresolved deps + children not done"
```

---

## Task 8: HTTP adapter — routes + error handling

**Files:**
- Modify: `apps/server/src/adapters/http/routes.ts`

- [ ] **Step 1: Import new service functions and error classes**

In `apps/server/src/adapters/http/routes.ts`, update the import from `service/tasks.ts` to add:

```typescript
  ChildrenNotDoneError,
  CrossProjectRelationError,
  DependencyCycleDetectedError,
  DependencyNotResolvedError,
  HierarchyDepthExceededError,
  ParentCycleDetectedError,
  addDependency,
  listDependencies,
  removeDependency,
  setParent,
```

And update the domain import to include the new schemas:

```typescript
  AddDependencyReqSchema,
  ListDependenciesReqSchema,
  RemoveDependencyReqSchema,
  SetParentReqSchema,
```

- [ ] **Step 2: Add 4 new routes**

After the `api.post('/tasks/:id/reorder', ...)` handler and before `api.get('/tasks/:id/events', ...)`, add:

```typescript
  api.patch('/tasks/:id/parent', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const req = SetParentReqSchema.parse({ ...body, task_id: c.req.param('id') });
      const actor = c.get('actor');
      const res = await setParent(c.get('db'), {
        taskId: req.task_id,
        parentTaskId: req.parent_task_id,
        actorId: actor.id,
      });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  api.post('/tasks/:id/dependencies', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const req = AddDependencyReqSchema.parse({
        task_id: c.req.param('id'),
        blocked_by_task_id: body?.blocked_by_task_id,
      });
      const actor = c.get('actor');
      const res = await addDependency(c.get('db'), {
        fromTaskId: req.task_id,
        toTaskId: req.blocked_by_task_id,
        actorId: actor.id,
      });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  api.delete('/tasks/:id/dependencies/:depId', async (c) => {
    try {
      const actor = c.get('actor');
      await removeDependency(c.get('db'), {
        fromTaskId: c.req.param('id'),
        toTaskId: c.req.param('depId'),
        actorId: actor.id,
      });
      return new Response(null, { status: 204 });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  api.get('/tasks/:id/dependencies', async (c) => {
    try {
      const req = ListDependenciesReqSchema.parse({ task_id: c.req.param('id') });
      const res = await listDependencies(c.get('db'), { taskId: req.task_id });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });
```

- [ ] **Step 3: Add 6 error mappings to `errorResponse`**

In the `errorResponse` function, after the `WorkflowColumnNotFoundError` block and before the `IdempotencyConflictError` block, add:

```typescript
  if (err instanceof HierarchyDepthExceededError) {
    return c.json({ error: 'hierarchy_depth_exceeded', message: err.message }, 422);
  }
  if (err instanceof ParentCycleDetectedError) {
    return c.json({ error: 'parent_cycle_detected', message: err.message }, 422);
  }
  if (err instanceof DependencyCycleDetectedError) {
    return c.json({ error: 'dependency_cycle_detected', message: err.message }, 422);
  }
  if (err instanceof DependencyNotResolvedError) {
    return c.json({ error: 'dependency_not_resolved', message: err.message }, 409);
  }
  if (err instanceof ChildrenNotDoneError) {
    return c.json({ error: 'children_not_done', message: err.message }, 409);
  }
  if (err instanceof CrossProjectRelationError) {
    return c.json({ error: 'cross_project_relation', message: err.message }, 422);
  }
```

- [ ] **Step 4: Verify typecheck**

```bash
cd apps/server && bun run typecheck
```

Expected: no errors.

- [ ] **Step 5: Run all task_hierarchy tests — confirm all pass**

```bash
env TEST_DATABASE_URL=postgres://$(whoami)@localhost:5432/sprino_test bun run test -- task_hierarchy
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/adapters/http/routes.ts
git commit -m "feat(server): d3-p2 — HTTP routes: parent + dependencies endpoints"
```

---

## Task 9: MCP adapter — 4 new tools

**Files:**
- Modify: `apps/server/src/adapters/mcp/server.ts`

- [ ] **Step 1: Import new service functions**

In `apps/server/src/adapters/mcp/server.ts`, add to the service import:

```typescript
  addDependency,
  listDependencies,
  removeDependency,
  setParent,
```

And add domain schema imports:

```typescript
  AddDependencyReqSchema,
  ListDependenciesReqSchema,
  RemoveDependencyReqSchema,
  SetParentReqSchema,
```

- [ ] **Step 2: Add 4 tool definitions to `TOOL_DEFINITIONS`**

Append after `sprino.task.reorder` in the `TOOL_DEFINITIONS` array:

```typescript
  {
    name: 'sprino.task.set_parent',
    description:
      'Set or clear the parent task for a task. parent_task_id=null makes the task a root. Max hierarchy depth is 3 levels. Rejects cycles and cross-project parents.',
    inputSchema: {
      type: 'object',
      required: ['task_id', 'parent_task_id'],
      additionalProperties: false,
      properties: {
        task_id: { type: 'string', format: 'uuid' },
        parent_task_id: { type: ['string', 'null'], format: 'uuid' },
      },
    },
  },
  {
    name: 'sprino.task.add_dependency',
    description:
      'Mark a task as blocked by another task. The from task (task_id) cannot move to doing or done until the blocking task (blocked_by_task_id) is done. Auto-sets task status to blocked. Rejects cycles.',
    inputSchema: {
      type: 'object',
      required: ['task_id', 'blocked_by_task_id'],
      additionalProperties: false,
      properties: {
        task_id: { type: 'string', format: 'uuid' },
        blocked_by_task_id: { type: 'string', format: 'uuid' },
      },
    },
  },
  {
    name: 'sprino.task.remove_dependency',
    description:
      'Remove a blocked-by dependency. Does not auto-update task status — call task.update_status separately if the task is ready to proceed.',
    inputSchema: {
      type: 'object',
      required: ['task_id', 'blocked_by_task_id'],
      additionalProperties: false,
      properties: {
        task_id: { type: 'string', format: 'uuid' },
        blocked_by_task_id: { type: 'string', format: 'uuid' },
      },
    },
  },
  {
    name: 'sprino.task.list_dependencies',
    description:
      'List all tasks that are blocking the given task (its blocked_by list).',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      additionalProperties: false,
      properties: {
        task_id: { type: 'string', format: 'uuid' },
      },
    },
  },
```

- [ ] **Step 3: Add 4 dispatch cases to `callTool`**

Inside the `switch (name)` in `callTool`, add after `case 'sprino.task.reorder':`:

```typescript
    case 'sprino.task.set_parent': {
      const req = SetParentReqSchema.parse(args);
      const res = await setParent(db, {
        taskId: req.task_id,
        parentTaskId: req.parent_task_id,
        actorId: actor.id,
      });
      return wrapToolResult(res);
    }
    case 'sprino.task.add_dependency': {
      const req = AddDependencyReqSchema.parse(args);
      const res = await addDependency(db, {
        fromTaskId: req.task_id,
        toTaskId: req.blocked_by_task_id,
        actorId: actor.id,
      });
      return wrapToolResult(res);
    }
    case 'sprino.task.remove_dependency': {
      const req = RemoveDependencyReqSchema.parse(args);
      await removeDependency(db, {
        fromTaskId: req.task_id,
        toTaskId: req.blocked_by_task_id,
        actorId: actor.id,
      });
      return wrapToolResult({ ok: true });
    }
    case 'sprino.task.list_dependencies': {
      const req = ListDependenciesReqSchema.parse(args);
      const res = await listDependencies(db, { taskId: req.task_id });
      return wrapToolResult(res);
    }
```

- [ ] **Step 4: Verify typecheck**

```bash
cd apps/server && bun run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/adapters/mcp/server.ts
git commit -m "feat(server): d3-p2 — MCP tools: set_parent, add/remove/list_dependencies"
```

---

## Task 10: Conformance test update + Tessera schema

**Files:**
- Modify: `apps/server/test/conformance.test.ts`
- Modify: `../tessera/schemas/resources/task.json`

- [ ] **Step 1: Update the tools/list conformance assertion**

In `apps/server/test/conformance.test.ts`, find the assertion that checks tool names. It currently has 18 tools. Add the 4 new tools:

Find the sorted expected array (it has 18 entries) and add:

```
'sprino.task.add_dependency',
'sprino.task.list_dependencies',
'sprino.task.remove_dependency',
'sprino.task.set_parent',
```

The new sorted array (22 entries) must be:

```typescript
expect(names).toEqual([
  'sprino.actor.deactivate',
  'sprino.actor.get',
  'sprino.actor.heartbeat',
  'sprino.actor.list',
  'sprino.actor.register',
  'sprino.actor.revoke_token',
  'sprino.attachment.create_upload',
  'sprino.attachment.finalize',
  'sprino.attachment.get',
  'sprino.attachment.list',
  'sprino.project.create',
  'sprino.project.get',
  'sprino.project.list',
  'sprino.task.add_dependency',
  'sprino.task.create',
  'sprino.task.get',
  'sprino.task.list_dependencies',
  'sprino.task.remove_dependency',
  'sprino.task.reorder',
  'sprino.task.set_parent',
  'sprino.task.transition_workflow',
  'sprino.task.update_status',
]);
```

Also update the count assertion from `18` to `22` if there's a separate `expect(names).toHaveLength(18)`.

- [ ] **Step 2: Update Tessera task.json schema**

In `../tessera/schemas/resources/task.json`, add `parent_task_id` to the `properties` object (after `assignee_id`):

```json
    "parent_task_id": {
      "type": ["string", "null"],
      "format": "uuid",
      "description": "UUID of the parent task. NULL means root task. Max hierarchy depth is 3 levels (enforced by implementations). Setting parent is a structural operation; children must all be done before a parent can be marked done."
    },
```

`parent_task_id` is NOT added to `required` since it is optional. Existing tasks have `parent_task_id: null`.

- [ ] **Step 3: Run all tests**

```bash
cd apps/server && env TEST_DATABASE_URL=postgres://$(whoami)@localhost:5432/sprino_test bun run test
```

Expected: all tests PASS including conformance.

- [ ] **Step 4: Commit**

```bash
git add apps/server/test/conformance.test.ts ../tessera/schemas/resources/task.json
git commit -m "feat(server): d3-p2 — conformance tools list 18→22 + Tessera task schema parent_task_id"
```

---

## Task 11: UI — `TaskHierarchy.tsx` component

**Files:**
- Create: `apps/web/src/components/TaskHierarchy.tsx`

The component fetches children of the task on mount (GET `/api/tasks?project_id=X&parent_task_id=Y` — add this query param in Task 12), and blocked_by list (GET `/api/tasks/:id/dependencies`). It shows a collapsed badge by default; click expands inline.

- [ ] **Step 1: Create `TaskHierarchy.tsx`**

```typescript
// apps/web/src/components/TaskHierarchy.tsx
import { useEffect, useState } from 'react';

interface Task {
  id: string;
  title: string;
  status: 'todo' | 'doing' | 'done' | 'blocked';
  parent_task_id: string | null;
}

interface TaskHierarchyProps {
  task: Task;
  projectId: string;
  authHeader: Record<string, string>;
}

export function TaskHierarchy({ task, projectId, authHeader }: TaskHierarchyProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<Task[]>([]);
  const [blockedBy, setBlockedBy] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [childRes, depRes] = await Promise.all([
        fetch(`/api/tasks?project_id=${projectId}&parent_task_id=${task.id}`, {
          headers: authHeader,
        }),
        fetch(`/api/tasks/${task.id}/dependencies`, { headers: authHeader }),
      ]);

      if (cancelled) return;

      if (childRes.ok) {
        const data = (await childRes.json()) as { tasks: Task[] };
        setChildren(data.tasks);
      }
      if (depRes.ok) {
        const data = (await depRes.json()) as { blocked_by: Task[] };
        setBlockedBy(data.blocked_by);
      }
      setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [task.id, projectId, authHeader]);

  if (loading) return null;
  if (children.length === 0 && blockedBy.length === 0) return null;

  const doneCount = children.filter((c) => c.status === 'done').length;
  const pct = children.length > 0 ? Math.round((doneCount / children.length) * 100) : 0;

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {children.length > 0 && (
          <button
            onClick={() => setExpanded((v) => !v)}
            style={{
              background: 'rgba(124,58,237,0.13)',
              color: '#a78bfa',
              border: 'none',
              borderRadius: 12,
              padding: '2px 10px',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            {expanded ? '▾' : '▸'} {children.length} subtask{children.length !== 1 ? 's' : ''} · {doneCount}/{children.length} done
          </button>
        )}
        {blockedBy.length > 0 && (
          <span
            style={{
              background: 'rgba(239,68,68,0.13)',
              color: '#f87171',
              borderRadius: 12,
              padding: '2px 10px',
              fontSize: 11,
            }}
          >
            ⛔ {blockedBy.length} blocker{blockedBy.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {expanded && children.length > 0 && (
        <div style={{ marginTop: 8, borderTop: '1px solid #2a2a2a', paddingTop: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ color: '#9ca3af', fontSize: 11 }}>Progress</span>
            <span style={{ color: '#a78bfa', fontSize: 11 }}>{doneCount} / {children.length}</span>
          </div>
          <div style={{ background: '#111', borderRadius: 4, height: 5, marginBottom: 8 }}>
            <div
              style={{
                background: '#7c3aed',
                height: 5,
                borderRadius: 4,
                width: `${pct}%`,
                transition: 'width 0.2s',
              }}
            />
          </div>
          {children.map((child) => (
            <div
              key={child.id}
              style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, fontSize: 12 }}
            >
              <span style={{ color: child.status === 'done' ? '#22c55e' : '#6b7280' }}>
                {child.status === 'done' ? '✓' : '○'}
              </span>
              <span style={{ color: child.status === 'done' ? '#9ca3af' : '#e0e0e0',
                textDecoration: child.status === 'done' ? 'line-through' : 'none' }}>
                {child.title}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify typecheck**

```bash
cd apps/web && bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/TaskHierarchy.tsx
git commit -m "feat(web): d3-p3 — TaskHierarchy component (collapsed badge + expand)"
```

---

## Task 12: HTTP adapter — `parent_task_id` filter for `listTasks`

**Files:**
- Modify: `apps/server/src/domain/index.ts`
- Modify: `apps/server/src/service/tasks.ts`

The `TaskHierarchy` component needs to fetch children by `parent_task_id`. Add this optional filter to `listTasks`.

- [ ] **Step 1: Add `parent_task_id` filter to `TaskListReqSchema`**

In `apps/server/src/domain/index.ts`, update `TaskListReqSchema`:

```typescript
export const TaskListReqSchema = z
  .object({
    project_id: uuid,
    status: z.array(TaskStatusSchema).optional(),
    assignee_id: uuid.optional(),
    parent_task_id: uuid.optional(),
  })
  .merge(paginationSchema(MAX_LIMITS.tasks));
export type TaskListReq = z.infer<typeof TaskListReqSchema>;
```

- [ ] **Step 2: Apply the filter in `listTasks`**

In `apps/server/src/service/tasks.ts`, in the `listTasks` function, add:

```typescript
  if (args.req.parent_task_id) {
    conditions.push(eq(tasks.parentTaskId, args.req.parent_task_id));
  }
```

after the `assignee_id` condition block.

- [ ] **Step 3: Wire `parent_task_id` query param in HTTP routes**

In `apps/server/src/adapters/http/routes.ts`, in the `api.get('/tasks', ...)` handler, update the `TaskListReqSchema.parse(...)` call to include `parent_task_id`:

```typescript
      const req = TaskListReqSchema.parse({
        project_id: c.req.query('project_id'),
        status: c.req.queries('status') ?? undefined,
        assignee_id: c.req.query('assignee_id') ?? undefined,
        parent_task_id: c.req.query('parent_task_id') ?? undefined,
        limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
        offset: c.req.query('offset') ? Number(c.req.query('offset')) : undefined,
      });
```

- [ ] **Step 4: Verify typecheck and run tests**

```bash
cd apps/server && bun run typecheck && env TEST_DATABASE_URL=postgres://$(whoami)@localhost:5432/sprino_test bun run test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/domain/index.ts apps/server/src/service/tasks.ts \
        apps/server/src/adapters/http/routes.ts
git commit -m "feat(server): d3-p3 — listTasks parent_task_id filter for hierarchy fetch"
```

---

## Task 13: UI — wire `TaskHierarchy` into `TaskWorkflowBoard`

**Files:**
- Modify: `apps/web/src/components/TaskWorkflowBoard.tsx`

- [ ] **Step 1: Import `TaskHierarchy`**

At the top of `apps/web/src/components/TaskWorkflowBoard.tsx`, add:

```typescript
import { TaskHierarchy } from './TaskHierarchy';
```

- [ ] **Step 2: Add `TaskHierarchy` to each task card**

`TaskWorkflowBoard.tsx` already declares `const authHeader = { Authorization: \`Bearer ${token}\` };` on line 33. Find the JSX block that renders each task card (search for where `t.title` and `t.status` are rendered). After the existing badge/assignee row inside each card, add:

```tsx
<TaskHierarchy
  task={t}
  projectId={projectId}
  authHeader={authHeader}
/>
```

The `Task` type from `@sprino/protocol-types` will need `parent_task_id` — it flows from the domain types update in Task 3 via the shared `packages/protocol-types/` package (rebuild if needed: `cd packages/protocol-types && bun run build`).

- [ ] **Step 3: Verify build**

```bash
cd apps/web && bun run build
```

Expected: build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/TaskWorkflowBoard.tsx
git commit -m "feat(web): d3-p3 — wire TaskHierarchy into TaskWorkflowBoard cards"
```

---

## Task 14: UI — `ActivityFeed.tsx` hierarchy/dependency events

**Files:**
- Modify: `apps/web/src/components/ActivityFeed.tsx`

- [ ] **Step 1: Improve the `context_updated` branch in `describe()`**

In `apps/web/src/components/ActivityFeed.tsx`, the `describe()` function at line 37 has a `case 'context_updated':` branch (line 50) that currently returns a generic string. Replace it with:

```typescript
    case 'context_updated': {
      const p = event.payload as { field?: string; new?: unknown } | null;
      const field = p?.field;
      if (field === 'parent_task_id') {
        return p?.new === null
          ? `removed ${taskLabel} from its parent`
          : `set a parent for ${taskLabel}`;
      }
      if (field === 'dependency_added') return `marked ${taskLabel} as blocked`;
      if (field === 'dependency_removed') return `removed a dependency from ${taskLabel}`;
      return `updated context on ${taskLabel}`;
    }
```

- [ ] **Step 2: Verify build**

```bash
cd apps/web && bun run build
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ActivityFeed.tsx
git commit -m "feat(web): d3-p3 — ActivityFeed renders hierarchy/dependency context_updated events"
```

---

## Task 15: UI component tests

**Files:**
- Create: `apps/web/src/components/__tests__/task-hierarchy.test.tsx`

- [ ] **Step 1: Create the test file**

```typescript
// apps/web/src/components/__tests__/task-hierarchy.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskHierarchy } from '../TaskHierarchy';

const TASK = {
  id: 'task-1',
  title: 'Parent task',
  status: 'todo' as const,
  parent_task_id: null,
};

const AUTH = { Authorization: 'Bearer test' };
const PROJECT_ID = 'proj-1';

function mockFetch(children: object[], blockedBy: object[]) {
  vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
    const u = url.toString();
    if (u.includes('parent_task_id')) {
      return new Response(JSON.stringify({ tasks: children }), { status: 200 });
    }
    if (u.includes('/dependencies')) {
      return new Response(JSON.stringify({ blocked_by: blockedBy }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
}

describe('TaskHierarchy', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders nothing when task has no children and no blockers', async () => {
    mockFetch([], []);
    const { container } = render(
      <TaskHierarchy task={TASK} projectId={PROJECT_ID} authHeader={AUTH} />,
    );
    await screen.findByText(/subtask|blocker/, { exact: false }).catch(() => {});
    expect(container.firstChild).toBeNull();
  });

  it('renders collapsed subtask badge when children exist', async () => {
    mockFetch(
      [{ id: 'c1', title: 'Child 1', status: 'todo', parent_task_id: 'task-1' }],
      [],
    );
    render(<TaskHierarchy task={TASK} projectId={PROJECT_ID} authHeader={AUTH} />);
    expect(await screen.findByText(/1 subtask/)).toBeTruthy();
  });

  it('expands to show progress bar and subtask list on click', async () => {
    mockFetch(
      [
        { id: 'c1', title: 'Done child', status: 'done', parent_task_id: 'task-1' },
        { id: 'c2', title: 'Todo child', status: 'todo', parent_task_id: 'task-1' },
      ],
      [],
    );
    render(<TaskHierarchy task={TASK} projectId={PROJECT_ID} authHeader={AUTH} />);
    const badge = await screen.findByText(/2 subtasks/);
    fireEvent.click(badge);
    expect(screen.getByText('Done child')).toBeTruthy();
    expect(screen.getByText('Todo child')).toBeTruthy();
    expect(screen.getByText('1 / 2')).toBeTruthy();
  });

  it('renders blocker badge when blocked_by is non-empty', async () => {
    mockFetch([], [{ id: 'b1', title: 'Blocker', status: 'todo', parent_task_id: null }]);
    render(<TaskHierarchy task={TASK} projectId={PROJECT_ID} authHeader={AUTH} />);
    expect(await screen.findByText(/1 blocker/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the component tests**

```bash
cd apps/web && bun run test
```

Expected: all 4 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/__tests__/task-hierarchy.test.tsx
git commit -m "test(web): d3-p3 — TaskHierarchy component tests"
```

---

## Task 16: Final sweep

**Files:**
- Run full test suite and typecheck

- [ ] **Step 1: Full server typecheck + test run**

```bash
cd apps/server && bun run typecheck && env TEST_DATABASE_URL=postgres://$(whoami)@localhost:5432/sprino_test bun run test
```

Expected: all tests pass. Note: CI uses `localhost:5432`; local Postgres may differ.

- [ ] **Step 2: Full web build + typecheck**

```bash
cd apps/web && bun run typecheck && bun run build
```

Expected: no type errors, clean build.

- [ ] **Step 3: Verify conformance tools/list count**

The conformance test must assert 22 tools. Check `apps/server/test/conformance.test.ts` to confirm the expected list has exactly 22 entries and includes all 4 new D3 tools.

- [ ] **Step 4: Create the feature branch PR**

```bash
git push -u origin HEAD
gh pr create \
  --title "feat(d3): hierarchy and dependency management" \
  --body "Implements D3: parent_task_id (max 3 levels, structural blocking), task_dependencies table (blocked-by enforcement), cycle detection on both graphs, 4 HTTP routes, 4 MCP tools, and TaskHierarchy UI component."
```

---

## Quick Reference

**Run tests locally:**
```bash
cd apps/server && env TEST_DATABASE_URL=postgres://$(whoami)@localhost:5432/sprino_test bun run test
```

**Run a specific test file:**
```bash
env TEST_DATABASE_URL=postgres://$(whoami)@localhost:5432/sprino_test bun run test -- task_hierarchy
```

**Type-check both packages:**
```bash
cd apps/server && bun run typecheck
cd apps/web && bun run typecheck
```

**Key invariants to preserve:**
- Business logic lives ONLY in `service/tasks.ts` — routes are thin adapters
- Every mutation writes exactly one event in the same transaction
- `task_dependencies` cascade-deletes when either task is deleted
- `parent_task_id` ON DELETE SET NULL — deleting a parent makes children root tasks
- `updateTaskStatus` guard runs INSIDE the transaction (after `FOR UPDATE` lock)
