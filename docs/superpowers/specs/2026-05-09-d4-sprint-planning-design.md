# D4 — Sprint and Iteration Planning: Design Spec

**Date:** 2026-05-09  
**Phase:** D4 of the Tessera remaining roadmap  
**Packets:** D4-P1 (schema), D4-P2 (service + adapters), D4-P3 (UI)  
**Status:** Approved

---

## 1. Goal

Add sprint/iteration planning to Sprino: create time-boxed sprints, assign tasks to them, track progress via a burndown that shows either task count or story points. Agents and humans can create sprints, activate them, assign tasks, and close them via both the HTTP API and the MCP tool interface.

---

## 2. Data Model

### Migration: `0010_sprints.sql`

**New table: `sprints`**

```sql
CREATE TYPE sprint_status AS ENUM ('planning', 'active', 'completed');

CREATE TABLE sprints (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id),
  name         varchar(200) NOT NULL,
  status       sprint_status NOT NULL DEFAULT 'planning',
  starts_on    date NOT NULL,
  ends_on      date NOT NULL,
  created_by   uuid NOT NULL REFERENCES actors(id),
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sprints_project_id_idx ON sprints(project_id);
CREATE INDEX sprints_status_idx ON sprints(project_id, status);
```

**New table: `sprint_tasks`** (junction)

```sql
CREATE TABLE sprint_tasks (
  sprint_id  uuid NOT NULL REFERENCES sprints(id),
  task_id    uuid NOT NULL REFERENCES tasks(id),
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sprint_id, task_id)
);

CREATE INDEX sprint_tasks_task_idx ON sprint_tasks(task_id);
```

**Column addition on `tasks`**

```sql
ALTER TABLE tasks ADD COLUMN points integer CHECK (points >= 0);
```

### Drizzle schema additions (`schema.ts`)

- `sprints` table with `sprintStatusEnum` pgEnum
- `sprintTasks` table with composite PK
- `tasks.points` nullable integer column
- Exported types: `SprintRow`, `NewSprintRow`, `SprintTaskRow`

### Active sprint constraint

At most one `active` sprint per project. Enforced in the service layer (consistent with D3's cycle-detection approach — not a DB unique partial index, to keep migration risk low and allow the service to return a typed error).

---

## 3. Domain Types (`domain/index.ts`)

```typescript
SprintStatusSchema = z.enum(['planning', 'active', 'completed'])

SprintSchema = z.object({
  id: uuid,
  project_id: uuid,
  name: z.string().min(1).max(200),
  status: SprintStatusSchema,
  starts_on: z.string().date(),
  ends_on: z.string().date(),
  version: z.number().int().min(1),
  created_by: uuid,
  created_at: isoDateTime,
  updated_at: isoDateTime,
})

BurndownPointSchema = z.object({ date: z.string().date(), remaining: z.number().int() })

SprintGetResSchema = z.object({
  sprint: SprintSchema,
  tasks: z.array(TaskSchema),
  burndown_series: z.array(BurndownPointSchema),
  // Y-axis label: 'tasks' when any task lacks points, 'points' when all have points
  burndown_metric: z.enum(['tasks', 'points']),
})

// Verbs
SprintCreateReqSchema, SprintCreateResSchema
SprintTransitionReqSchema (to_status: 'active' | 'completed', if_match: version)
SprintTransitionResSchema
SprintListReqSchema (project_id, status?: SprintStatus)
SprintListResSchema
AssignToSprintReqSchema (operation_id, sprint_id, task_id)
AssignToSprintResSchema
RemoveFromSprintReqSchema (sprint_id, task_id)
UpdateTaskPointsReqSchema (operation_id, task_id, points: number | null, if_match)
UpdateTaskPointsResSchema
```

---

## 4. Service Layer

### `service/sprints.ts` (new file)

| Function | Description |
|---|---|
| `createSprint(req)` | Idempotent via `operations` table. Inserts sprint with status `planning`. No task event (sprint lifecycle is not task-scoped). |
| `activateSprint(req)` | Guards: no other `active` sprint in project; `starts_on ≤ today`. Transitions `planning → active`; bumps `version` + `updated_at`. No task event. |
| `closeSprint(req)` | Transitions `active → completed`; bumps `version` + `updated_at`. Returns `carry_over_tasks` (tasks in sprint not yet `done`). No task event. |
| `listSprints(req)` | Returns sprints filtered by `project_id` and optional `status`. |
| `getSprint(req)` | Returns sprint + tasks + precomputed `burndown_series` + `burndown_metric`. Burndown series: one point per calendar day from `starts_on` to `min(today, ends_on)`, counting tasks (or sum of points) remaining at end of each day based on event log. |

### `service/tasks.ts` additions

| Function | Description |
|---|---|
| `assignToSprint(req)` | Guards: task not already in an `active` sprint; task and sprint share `project_id`. Inserts into `sprint_tasks`. Idempotent. Writes `context_updated` event on the task with `{sprint_id}` payload. |
| `removeFromSprint(req)` | Deletes from `sprint_tasks`. No-op if not present (idempotent). Writes `context_updated` event on task with `{sprint_id: null}` payload. |
| `updateTaskPoints(req)` | Sets `tasks.points`. Optimistic lock via `if_match`. Writes `context_updated` event on task with `{points}` in payload. |

### Error classes

| Class | HTTP status |
|---|---|
| `SprintNotFoundError` | 404 |
| `SprintAlreadyActiveError` | 409 |
| `TaskAlreadyInActiveSprintError` | 409 |
| `CrossProjectSprintError` | 422 |
| `InvalidSprintTransitionError` | 422 |

All follow the same pattern as D3 error classes.

---

## 5. HTTP Adapter

| Method | Path | Service call |
|---|---|---|
| `POST` | `/projects/:id/sprints` | `createSprint` |
| `PATCH` | `/sprints/:id/status` | `activateSprint` or `closeSprint` based on `to_status` |
| `GET` | `/projects/:id/sprints` | `listSprints` |
| `GET` | `/sprints/:id` | `getSprint` |
| `POST` | `/sprints/:id/tasks` | `assignToSprint` |
| `DELETE` | `/sprints/:id/tasks/:taskId` | `removeFromSprint` |
| `PATCH` | `/tasks/:id/points` | `updateTaskPoints` |

Error mappings for all 5 new error classes added to `errorResponse()`.

---

## 6. MCP Adapter

7 new tools appended to `TOOL_DEFINITIONS` (conformance count: 22 → 29):

- `sprino.sprint.create`
- `sprino.sprint.transition`
- `sprino.sprint.list`
- `sprino.sprint.get`
- `sprino.task.assign_sprint`
- `sprino.task.remove_from_sprint`
- `sprino.task.set_points`

Conformance test updated to expect 29 tools.

---

## 7. UI (D4-P3)

**`SprintBoard.tsx`**  
Fetches active sprint via `GET /projects/:id/sprints?status=active`. Renders a kanban filtered to sprint tasks, grouped by `workflow_column_id` (reuses existing column data from `TaskWorkflowBoard`). Shows title, assignee, and points badge per task. Empty state when no active sprint.

**`BurndownChart.tsx`**  
Fetches sprint via `GET /sprints/:id`. Renders the `burndown_series` as a plain SVG line chart — no charting library. Y-axis label comes from `burndown_metric` (`'tasks'` or `'points'`).

**`App.tsx`**  
Adds a "Sprint" tab. Renders `SprintBoard` for the active project.

No new test files (per CLAUDE.md "No frontend tests in v1"). P3 verification: `bun run typecheck && bun run build`.

---

## 8. Orchestration Agent Topology

### Lane sequence (no exceptions)

```
implementation → code_review → qa → orchestrator_approval
```

Commit gate: `after_qa_pass` — the orchestrator commits only after QA signs off.

### Model assignment (D4 override)

The routing YAML `risk_tier_models` would assign `model-top` to risk_tier 4 lanes. D4 uses these fixed assignments instead:

| Lane | Agent role | Model |
|---|---|---|
| `implementation` | implementer | `claude-haiku-4-5-20251001` |
| `code_review` | code-reviewer | `claude-haiku-4-5-20251001` |
| `qa` | QA | `claude-sonnet-4-6` |
| `orchestrator_approval` | orchestrator | `claude-sonnet-4-6` |

### Spawn templates per packet

| Packet | risk_tier | Impl template | Review | QA | Approval |
|---|---|---|---|---|---|
| D4-P1 | 4 | `impl-high-risk` | `review-default` | `qa-default` | `approval-default` |
| D4-P2 | 4 | `impl-high-risk` | `review-default` | `qa-default` | `approval-default` |
| D4-P3 | 2 | `impl-low-risk` | `review-default` | `qa-default` | `approval-default` |

`impl-high-risk` requires evidence: `test_output`, `diff_summary`, `rollback_check`, `schema_diff`.  
`impl-low-risk` requires evidence: `test_output`, `diff_summary`.

### Carry-over at sprint close

`closeSprint` returns `carry_over_tasks`. The orchestrator includes this list in the `patch-summary` evidence so the next sprint's orchestrator can pre-assign them.

---

## 9. TDD Approach (per-packet)

### D4-P1 red tests (`apps/server/test/sprints.test.ts`)
- Sprint row persists with correct fields
- `status` defaults to `planning`
- `points` column exists on tasks table (nullable)

### D4-P2 red tests (extend `sprints.test.ts`)
- `activateSprint` rejects when another sprint is already active
- `assignToSprint` rejects when task is already in an active sprint
- `assignToSprint` rejects cross-project assignment
- `closeSprint` returns carry-over tasks (uncompleted)
- HTTP: `POST /projects/:id/sprints` → 201
- HTTP: `PATCH /sprints/:id/status` to `active` → 200, second call → 409
- HTTP: `POST /sprints/:id/tasks` → 201, duplicate → 200 (idempotent)
- HTTP: `PATCH /tasks/:id/points` → 200

### D4-P3 (stub tests only per CLAUDE.md)

---

## 10. Vertical Slice Order

1. **P1**: Migration + Drizzle schema + domain types + red tests (schema tests only pass, service tests fail)
2. **P2**: Service functions + HTTP routes + MCP tools + red tests go green
3. **P3**: UI components + App.tsx wiring + typecheck/build passes
