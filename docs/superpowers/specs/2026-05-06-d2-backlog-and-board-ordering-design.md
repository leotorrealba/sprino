# D2 — Backlog and Board Ordering Design

**Date:** 2026-05-06
**Phase:** D2 (PM Workflow Productization — second slice)
**Scope:** `apps/server` + `apps/web`
**Packets:** D2-P1 (schema/domain), D2-P2 (service + adapters), D2-P3 (board filters UI)

---

## Context

D1 added per-project Kanban workflow columns with an explicit transition graph. D2 adds explicit ordering within each column and filtering of the task list. The `rank` field is owned entirely by the Sprino service layer — it is not part of the Tessera protocol wire shape.

---

## Key design decisions

- **Rank scope**: per workflow column. Each column has its own independent 1-based integer ranking. Moving a task to a new column resets its rank to the bottom of that column.
- **Rank data type**: sequential integers, full rewrite per reorder. On every reorder the service rewrites `rank = 1, 2, 3, …` for all tasks in the column in a single transaction. No float degradation, no client-side rank calculation.
- **Reorder API shape**: after-anchor. The caller says "put task X after task Y" (`after_task_id: uuid | null`; null = move to top). The service resolves anchors and renumbers.
- **Board filters**: `status[]` (multi-value) + `assignee_id` (single UUID), server-side, via new query params on `GET /api/tasks`.

---

## Schema (D2-P1)

Migration `apps/server/src/db/migrations/0008_task_rank.sql`:

```sql
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS rank integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS tasks_rank_column_idx ON tasks(workflow_column_id, rank);
```

The default of `0` is safe for existing tasks — they all start at the same rank and are reordered on first use. The composite index on `(workflow_column_id, rank)` makes the per-column ordered fetch fast.

Three rank assignment rules enforced by the service layer:

| Operation | Rank assigned |
|-----------|--------------|
| `task.create` | `MAX(rank in default column) + 1` (append to bottom) |
| `transitionTaskWorkflow` | `MAX(rank in new column) + 1` (append to bottom of new column) |
| `reorderTask` | Full 1-based renumber of all tasks in the column |

---

## Domain types (D2-P1 + D2-P2)

### Changes to `apps/server/src/domain/index.ts`

**`TaskSchema`** — add `rank` field:
```typescript
export const TaskSchema = z.object({
  // ... existing fields ...
  workflow_column_id: uuid.nullable(),
  rank: z.number().int().min(0),
});
```

**`TaskListReqSchema`** — add optional filter params:
```typescript
export const TaskListReqSchema = z
  .object({
    project_id: uuid,
    status: z.array(TaskStatusSchema).optional(),
    assignee_id: uuid.optional(),
  })
  .merge(paginationSchema(MAX_LIMITS.tasks));
```

**New verb schemas**:
```typescript
export const TaskReorderReqSchema = z.object({
  operation_id: uuid,
  task_id: uuid,
  column_id: uuid,               // must match task's current workflow_column_id
  after_task_id: uuid.nullable(), // null = move to top of column
});
export type TaskReorderReq = z.infer<typeof TaskReorderReqSchema>;

export const TaskReorderResSchema = z.object({
  tasks: z.array(TaskSchema),    // full column in new rank order
});
export type TaskReorderRes = z.infer<typeof TaskReorderResSchema>;
```

### Changes to `packages/protocol-types/src/index.ts`

Add `rank: z.number().int().min(0)` to `TaskSchema` (same position as server domain).

---

## Service layer (D2-P2)

All changes in `apps/server/src/service/tasks.ts`.

### `rowToTask` — add `rank: r.rank`

### `listTasks` — filter + sort changes

- Add optional `status` filter: `inArray(tasks.status, req.status)` when `req.status` is provided and non-empty.
- Add optional `assignee_id` filter: `eq(tasks.assigneeId, req.assignee_id)` when provided.
- Change ORDER BY from `asc(tasks.createdAt), asc(tasks.id)` to `asc(tasks.rank), asc(tasks.id)`.

### `createTask` — append to bottom of default column

Inside the transaction, after looking up the default column:
```typescript
const maxRankRow = await tx
  .select({ maxRank: sql<number>`COALESCE(MAX(rank), 0)` })
  .from(tasks)
  .where(eq(tasks.workflowColumnId, defaultColumnId));
const newRank = (maxRankRow[0]?.maxRank ?? 0) + 1;
// then INSERT tasks with rank: newRank
```

### `transitionTaskWorkflow` — append to bottom of new column

Inside the transaction, after resolving `targetCol`:
```typescript
const maxRankRow = await tx
  .select({ maxRank: sql<number>`COALESCE(MAX(rank), 0)` })
  .from(tasks)
  .where(eq(tasks.workflowColumnId, args.req.to_column_id));
const newRank = (maxRankRow[0]?.maxRank ?? 0) + 1;
// then UPDATE tasks SET rank = newRank (alongside workflowColumnId, status, version)
```

### New error class

```typescript
export class TaskNotInColumnError extends Error {
  constructor(public readonly taskId: string, public readonly columnId: string) {
    super(`task ${taskId} is not in column ${columnId}`);
    this.name = 'TaskNotInColumnError';
  }
}
```

### New function `reorderTask(db, { req, actorId })`

```
Transaction steps:
1. Idempotency check (hash req → idempotency table)
2. Verify task exists and is in req.column_id → TaskNotFoundError / TaskNotInColumnError
3. SELECT all tasks WHERE workflow_column_id = req.column_id
   ORDER BY rank ASC, id ASC  (FOR UPDATE to lock the set)
4. Remove req.task_id from the list
5. If req.after_task_id is not null:
   - Find after_task_id in the remaining list → TaskNotInColumnError if absent
   - Insert req.task_id immediately after it
   Else (null):
   - Insert req.task_id at index 0 (top of column)
6. UPDATE each task in the new list with rank = 1-based index
7. recordOperation
8. Return { tasks: updated column in rank order }
```

The `FOR UPDATE` lock on step 3 ensures concurrent reorders for the same column serialize — one waits for the other's transaction to commit before proceeding. No explicit version field needed; the full-rewrite approach is inherently atomic.

---

## Adapters (D2-P2)

### HTTP (`apps/server/src/adapters/http/routes.ts`)

**`GET /api/tasks`** — extend query param parsing:
```
?status=todo&status=doing   → req.status = ['todo', 'doing']
?assignee_id=<uuid>         → req.assignee_id = uuid
```

**New route:**
```
POST /api/tasks/:id/reorder
Body: { operation_id, column_id, after_task_id }
Response 200: { tasks: Task[] }
```

Error mapping:
- `TaskNotInColumnError` → 422
- `TaskNotFoundError` → 404
- `WorkflowColumnNotFoundError` → 404 (if column_id doesn't exist)

### MCP (`apps/server/src/adapters/mcp/server.ts`)

New tool `sprino.task.reorder`:
```json
{
  "name": "sprino.task.reorder",
  "required": ["operation_id", "task_id", "column_id", "after_task_id"],
  "properties": {
    "operation_id": { "type": "string", "format": "uuid" },
    "task_id":      { "type": "string", "format": "uuid" },
    "column_id":    { "type": "string", "format": "uuid" },
    "after_task_id": { "type": ["string", "null"], "format": "uuid" }
  }
}
```

`translateError` maps `TaskNotInColumnError` → `-32010`.

---

## UI (D2-P3)

### `apps/web/src/components/BoardFilters.tsx` (new)

Pure controlled component — no fetch calls.

```typescript
interface BoardFilterState {
  statuses: TaskStatus[];    // empty array = all statuses shown
  assigneeId: string | null; // null = all assignees
}

interface Props {
  members: Actor[];
  filters: BoardFilterState;
  onChange: (f: BoardFilterState) => void;
}
```

Renders:
- Four status toggle-pills (`todo`, `doing`, `done`, `blocked`). Active = included in filter. All active by default.
- Assignee dropdown: "All" (null) + one entry per project member (id + display_name).

### `apps/web/src/components/TaskWorkflowBoard.tsx` (modify)

Accept `filters: BoardFilterState` prop. No client-side filtering needed — `App.tsx` re-fetches when filters change, so `tasks` prop is already filtered. The board renders tasks in the order received (which is `rank ASC` from the server).

### `apps/web/src/App.tsx` (modify)

- Add `filters: BoardFilterState` state, default `{ statuses: [], assigneeId: null }`.
- Add `members: Actor[]` state, fetched once on project select from `GET /api/members?project_id=…`.
- `refresh` callback extended: build query string from active filters when calling `GET /api/tasks`.
- In `'board'` view: render `<BoardFilters … />` above `<TaskWorkflowBoard … />`.
- When `filters` changes: call `refresh()` to re-fetch tasks.

---

## Acceptance criteria

- **D2-P1**: `rank` column exists; new tasks appended to bottom of their column; ordering tests pass; no migration regressions.
- **D2-P2**: Reorder is deterministic under concurrent requests; `GET /api/tasks` respects `status[]` and `assignee_id` filters; `POST /tasks/:id/reorder` and `sprino.task.reorder` work end-to-end.
- **D2-P3**: Filtered board and backlog views function correctly; `BoardFilters` toggles trigger re-fetch.

---

## Out of scope for D2

- Drag-and-drop reorder in the UI (the API supports it; the board has no drag gesture yet)
- "Unassigned" filter sentinel (YAGNI — filter by specific member only in v1)
- Per-column rank visibility in agent context (D5+)
- Cross-column reorder in a single API call (transition + reorder are separate operations)
