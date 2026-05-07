# D3: Hierarchy and Dependency Management — Design Spec

**Date:** 2026-05-07
**Status:** Approved
**Scope:** Sprino v0.1.x additive — no breaking Tessera protocol changes

---

## Goal

Add two orthogonal relationship concepts to tasks:

1. **Parent-child hierarchy** — organizational subtask nesting, max 3 levels deep. A parent cannot be marked `done` until all its children are `done`.
2. **Blocked-by dependencies** — explicit execution ordering. A task cannot transition to `doing` or `done` while any of its `blocked_by` dependencies are not `done`.

These are separate graphs stored separately. Both get cycle detection. Neither requires new Tessera event kinds — both write `context_updated` events with structured payloads.

---

## Architecture

Three implementation packets mirror the epic:

- **D3-P1** — Schema primitives: migration, Drizzle schema, Tessera task resource update, Zod domain types, persistence tests
- **D3-P2** — Service logic: cycle detection, guards, new service functions, HTTP + MCP adapter wiring, error codes
- **D3-P3** — UI: `TaskHierarchy.tsx` component, board card integration, dependency badge, activity feed rendering

---

## Data Model

### `tasks` table — new column

```sql
parent_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL
```

- Nullable. `NULL` means root task (no parent).
- Max depth 3 enforced in service layer, not as a DB constraint.
- Tessera `task.json` resource schema gains `parent_task_id` as an optional field (`"type": ["string", "null"], "format": "uuid"`). This is additive (v0.1.x compatible); `additionalProperties: false` in the schema requires the field be explicitly declared.

### `task_dependencies` table — new table

```sql
CREATE TABLE task_dependencies (
  from_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  to_task_id   UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (from_task_id, to_task_id)
);
```

- Row `(A, B)` means **"A is blocked by B"** — B must be `done` before A can proceed.
- Composite PK prevents duplicate edges.
- Both FKs `ON DELETE CASCADE` — deleting a task automatically removes all its dependency edges.
- Separate index on `to_task_id` for efficient "what tasks does X block?" queries.

### Drizzle schema additions

```typescript
// in tasks table
parentTaskId: uuid('parent_task_id').references(() => tasks.id),

// new table
export const taskDependencies = pgTable(
  'task_dependencies',
  {
    fromTaskId: uuid('from_task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    toTaskId:   uuid('to_task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk:        primaryKey({ columns: [t.fromTaskId, t.toTaskId] }),
    toTaskIdx: index('task_dependencies_to_idx').on(t.toTaskId),
  }),
);
```

### Domain type additions (`domain/index.ts`)

`TaskSchema` gains:
```typescript
parent_task_id: uuid.nullable(),
blocked_by: z.array(TaskSchema).optional(),  // populated on task.get, not stored
```

New schemas:
```typescript
export const SetParentInputSchema = z.object({
  task_id:        z.string().uuid(),
  parent_task_id: z.string().uuid().nullable(),
  actor_id:       z.string().uuid(),
});

export const AddDependencyInputSchema = z.object({
  from_task_id: z.string().uuid(),
  to_task_id:   z.string().uuid(),
  actor_id:     z.string().uuid(),
});

export const RemoveDependencyInputSchema = z.object({
  from_task_id: z.string().uuid(),
  to_task_id:   z.string().uuid(),
});
```

---

## Service Layer (`service/tasks.ts`)

### New error types

```typescript
export class HierarchyDepthExceededError extends Error { name = 'HierarchyDepthExceededError' }
export class ParentCycleDetectedError     extends Error { name = 'ParentCycleDetectedError' }
export class DependencyCycleDetectedError extends Error { name = 'DependencyCycleDetectedError' }
export class DependencyNotResolvedError   extends Error { name = 'DependencyNotResolvedError' }
export class ChildrenNotDoneError         extends Error { name = 'ChildrenNotDoneError' }
export class CrossProjectRelationError    extends Error { name = 'CrossProjectRelationError' }
```

### `setParent(taskId, parentId | null, actorId)`

Guards (in order):
1. Task exists — else `NotFoundError`
2. If `parentId` not null: parent exists and is in the same project — else `CrossProjectRelationError`
3. Cycle check: walk ancestors of `parentId`; reject if `taskId` appears — else `ParentCycleDetectedError`
4. Depth check: count ancestors above `parentId` (root = 0 ancestors). If `parentId` already has 2 ancestors (is at depth 3), adding `taskId` as its child would exceed max depth — reject with `HierarchyDepthExceededError`. Allowed depths: root (0 ancestors) → child (1) → grandchild (2).

Side effects (single transaction):
- `UPDATE tasks SET parent_task_id = $parentId WHERE id = $taskId`
- `INSERT INTO events (kind='context_updated', payload={ field: 'parent_task_id', old: <prev>, new: <parentId> })`

### `addDependency(fromTaskId, toTaskId, actorId)`

Guards (in order):
1. Both tasks exist — else `NotFoundError`
2. Both in the same project — else `CrossProjectRelationError`
3. Not a self-dependency (`fromTaskId !== toTaskId`)
4. Edge does not already exist (PK handles this at DB level, but check first for a clean error)
5. Cycle check on dependency graph: BFS from `toTaskId`; reject if `fromTaskId` is reachable — else `DependencyCycleDetectedError`

Side effects (single transaction):
- `INSERT INTO task_dependencies (from_task_id, to_task_id)`
- If `from` task status is `todo` or `doing`: `UPDATE tasks SET status = 'blocked'`
- `INSERT INTO events (kind='context_updated', payload={ field: 'dependency_added', blocked_by_task_id: toTaskId })`

### `removeDependency(fromTaskId, toTaskId)`

Side effects (single transaction):
- `DELETE FROM task_dependencies WHERE from_task_id = $from AND to_task_id = $to`
- `INSERT INTO events (kind='context_updated', payload={ field: 'dependency_removed', blocked_by_task_id: toTaskId })`
- Does NOT auto-update `from` task status — actor must call `task.update_status` explicitly.

### `updateTaskStatus` guard (new check in D3-P2)

Before allowing transition to `doing` or `done`:
```sql
SELECT COUNT(*) FROM task_dependencies td
JOIN tasks t ON t.id = td.to_task_id
WHERE td.from_task_id = $taskId AND t.status != 'done'
```
If count > 0 → throw `DependencyNotResolvedError`.

Before marking a parent task `done`:
```sql
SELECT COUNT(*) FROM tasks
WHERE parent_task_id = $taskId AND status != 'done'
```
If count > 0 → throw a new `ChildrenNotDoneError` (or return error code `children_not_done`).

### Cycle detection algorithm

Both graphs use the same BFS helper:

```typescript
async function isReachable(db, table, startId, targetId): Promise<boolean>
```

Walks outward from `startId` using a visited set. Returns `true` if `targetId` is found. For the hierarchy graph this is the ancestor chain (walk `parent_task_id`); for the dependency graph this is the blocked-by chain (walk `to_task_id`).

Max depth 3 means the hierarchy BFS terminates in at most 3 hops — negligible cost. Dependency graph is bounded by the number of tasks in the project.

---

## API Surface

### HTTP routes (Sprino-specific, thin adapters over service/)

| Method | Path | Body / Params | Response |
|---|---|---|---|
| `PATCH` | `/api/projects/:projectId/tasks/:taskId/parent` | `{ parent_task_id: uuid \| null }` | `{ task }` |
| `POST` | `/api/projects/:projectId/tasks/:taskId/dependencies` | `{ blocked_by_task_id: uuid }` | `{ task }` |
| `DELETE` | `/api/projects/:projectId/tasks/:taskId/dependencies/:depTaskId` | — | `204` |
| `GET` | `/api/projects/:projectId/tasks/:taskId/dependencies` | — | `{ blocked_by: Task[] }` |

`task.create` — accepts optional `parent_task_id` field. Additive, backward-compatible.

`task.get` — response body gains `parent_task_id: uuid | null` and `blocked_by: Task[]` (resolved from `task_dependencies`).

### Error → HTTP mapping

| Error class | HTTP status | Protocol code |
|---|---|---|
| `HierarchyDepthExceededError` | 422 | `hierarchy_depth_exceeded` |
| `ParentCycleDetectedError` | 422 | `parent_cycle_detected` |
| `DependencyCycleDetectedError` | 422 | `dependency_cycle_detected` |
| `DependencyNotResolvedError` | 409 | `dependency_not_resolved` |
| `ChildrenNotDoneError` | 409 | `children_not_done` |
| `CrossProjectRelationError` | 422 | `cross_project_relation` |

### MCP tools

| Tool | Description |
|---|---|
| `sprino.task.set_parent` | Set or clear `parent_task_id` |
| `sprino.task.add_dependency` | Mark task as blocked by another |
| `sprino.task.remove_dependency` | Remove a blocked-by relation |
| `sprino.task.list_dependencies` | List all tasks blocking a given task |

---

## UI Components

### `TaskHierarchy.tsx` (new)

Props:
```typescript
interface TaskHierarchyProps {
  task: Task;
  projectId: string;
}
```

Behaviour:
- If the task has no children (`blocked_by` count = 0 and no subtasks), renders nothing.
- Collapsed state: shows a badge `"⋯ N subtasks · X/N done ▸"` and optionally `"⛔ M blocker(s)"` badge if `blocked_by` is non-empty.
- Expanded state (toggle on badge click): reveals a progress bar (`X / N` with a filled bar) followed by a list of subtask titles with a checkmark/circle status icon.
- Progress bar uses the existing shadcn/ui `Progress` component (or a simple `div` if Progress isn't in scope).
- Dependency badge `⛔ M blocker(s)` is always visible on blocked tasks regardless of expand state.

### `TaskWorkflowBoard.tsx` (updated)

- Each task card renders `<TaskHierarchy task={t} projectId={projectId} />` below the title/assignee line.
- Fetch for task list must now also populate `blocked_by` count; add `?include_blocked_by=true` query param or resolve at fetch time.

### `ActivityFeed.tsx` (updated)

Renders `context_updated` events with `field` in `['parent_task_id', 'dependency_added', 'dependency_removed']`:

| Payload field | Feed text |
|---|---|
| `parent_task_id` (new non-null) | *"Set parent to '[parent title]'"* |
| `parent_task_id` (set to null) | *"Removed from parent task"* |
| `dependency_added` | *"Marked as blocked by '[task title]'"* |
| `dependency_removed` | *"Removed dependency on '[task title]'"* |

---

## Testing

### D3-P1 (`test/task_hierarchy.test.ts`)

- Inserting a task with `parent_task_id` persists and round-trips through `rowToTask`
- Inserting a task_dependency row and reading it back
- `task.get` returns `parent_task_id` and `blocked_by` array

### D3-P2 (`test/task_hierarchy.test.ts` continued)

- `setParent` rejects cross-project parent
- `setParent` rejects parent cycle (A→B, then set B's parent to A)
- `setParent` rejects depth-4 chain
- `addDependency` rejects dependency cycle (A blocked by B, then B blocked by A)
- `updateTaskStatus` rejects `doing` on task with unresolved dependency
- `updateTaskStatus` rejects `done` on parent with non-done children
- `removeDependency` succeeds without auto-changing status

### D3-P3 (`components/__tests__/task-hierarchy.test.tsx`)

- `TaskHierarchy` renders nothing when task has no children and no blockers
- Renders collapsed badge with correct count
- On click, expands to show progress bar and subtask list
- Renders dependency badge when `blocked_by` is non-empty

---

## Tessera Protocol Impact

- `task.json` resource schema: add `parent_task_id: { type: ["string", "null"], format: "uuid" }` — additive, v0.1.x compatible.
- No new Tessera verbs. Set-parent and dependency management are Sprino HTTP + MCP extensions.
- No new Tessera event kinds. All changes use `context_updated` with structured `payload`.
- Conformance fixture `task.get` response must include `parent_task_id: null` for existing tasks — backward-compatible default.

---

## Out of Scope for D3

- Auto-unblocking when a dependency resolves — `addDependency` will auto-set the `from` task to `blocked` (so the board immediately reflects the constraint), but `removeDependency` does NOT auto-lift it. The actor must call `task.update_status` explicitly. This asymmetry is intentional: blocking is deterministic (you just added a constraint), unblocking requires human/agent judgement (are you ready to proceed?).
- Status inheritance from parent to children
- Cross-project dependencies
- Dependency visualization beyond the card badge (graph view is D4+)
- `task.list` filter by `parent_task_id` (can add additively later)
