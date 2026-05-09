# E1 — Multi-Workspace Tenancy
**Date:** 2026-05-09
**Phase:** E1 (depends on D5-APPROVE)
**Status:** Approved — ready for implementation

---

## Overview

E1 introduces organization-level workspace boundaries to Sprino. A workspace groups projects and actors under a single tenancy boundary. All resource queries — projects, tasks, actors — are scoped to the requesting actor's workspace. Cross-workspace access is blocked at the service layer.

Primary users: human teammates and AI agents (MCP). The workspace context is communicated via an `X-Workspace-ID` request header on both transports.

---

## Data Model

Migration: `apps/server/src/db/migrations/0012_workspaces.sql`

### `workspaces`

| column | type | notes |
|--------|------|-------|
| `id` | UUID PK | |
| `name` | TEXT NOT NULL | max 100 chars |
| `slug` | TEXT NOT NULL UNIQUE | max 50 chars |
| `created_by` | UUID FK → actors, nullable | NULL for bootstrap default workspace |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

Index: `workspaces_slug_idx ON workspaces(slug)`

### `workspace_members`

| column | type | notes |
|--------|------|-------|
| `workspace_id` | UUID FK → workspaces ON DELETE CASCADE | composite PK |
| `actor_id` | UUID FK → actors ON DELETE CASCADE | composite PK |
| `role` | TEXT NOT NULL DEFAULT 'member' | CHECK IN ('admin', 'member') |
| `joined_at` | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

Indexes: `workspace_members_actor_idx ON workspace_members(actor_id)`, `workspace_members_workspace_idx ON workspace_members(workspace_id)`

### `projects` extension

```sql
ALTER TABLE projects
  ADD COLUMN workspace_id UUID NOT NULL
    REFERENCES workspaces(id) ON DELETE CASCADE;
CREATE INDEX projects_workspace_idx ON projects(workspace_id);
```

### Migration bootstrap sequence

1. Create `workspaces` and `workspace_members` tables.
2. `INSERT` one default workspace: `slug='default'`, `name='Default'`, `created_by=NULL`.
3. `UPDATE projects SET workspace_id = <default-id>` — backfills all existing rows.
4. `INSERT INTO workspace_members` for all existing actors using their current `actors.role`.

The default workspace is invisible from the outside when only one workspace exists. Existing single-tenant setups work without any config change.

---

## Domain Types (`domain/index.ts`)

```ts
WorkspaceSchema           // { id, name, slug, created_by, created_at }
WorkspaceCreateReqSchema  // { name: string (max 100), slug: string (max 50) }
WorkspaceCreateResSchema  // { workspace: Workspace }
WorkspaceListResSchema    // { workspaces: Workspace[] }

WorkspaceMemberSchema          // { workspace_id, actor_id, role, joined_at }
WorkspaceMemberAddReqSchema    // { actor_id: string (uuid), role?: 'admin' | 'member' }
WorkspaceMemberListResSchema   // { members: WorkspaceMember[] }
```

All types exported from `packages/protocol-types/src/index.ts`.

**Error types:**
- `WorkspaceNotFoundError` — workspace does not exist or actor is not a member
- `WorkspaceIsolationError` — resource belongs to a different workspace

---

## Service Layer

### `service/workspaces.ts` (new)

Single responsibility: workspace CRUD + membership management.

```ts
createWorkspace(db, { name, slug, actorId })                           → Workspace
listWorkspacesForActor(db, actorId)                                    → Workspace[]
getWorkspace(db, workspaceId)                                          → Workspace
addWorkspaceMember(db, { workspaceId, actorId, role, adminActorId })   → void
removeWorkspaceMember(db, { workspaceId, actorId, adminActorId })      → void
listWorkspaceMembers(db, workspaceId)                                  → WorkspaceMember[]
```

### `service/authorization.ts` (modified)

New helper for workspace-scoped enforcement:

```ts
assertProjectInWorkspace(db, { projectId, workspaceId }): Promise<void>
// throws WorkspaceIsolationError if projects.workspace_id ≠ workspaceId
// called AFTER the existing project-not-found lookup, never instead of it
```

Called at the top of every project-scoped service function, after the existing `ProjectNotFoundError` guard. Tasks inherit isolation via their `project_id` FK — no `workspace_id` column is added to `tasks`.

### `service/projects.ts` (modified)

- `createProject` gains required `workspaceId` arg; sets `workspace_id` on insert
- `listProjects` filters by `WHERE workspace_id = ?`
- `getProject` calls `assertProjectInWorkspace` before returning

### `service/tasks.ts` (modified)

- `createTask` and `listTasks` call `assertProjectInWorkspace` before proceeding
- All other task mutations that receive a `project_id` call `assertProjectInWorkspace`

### `service/actors.ts` (modified)

- `listActors` joins `workspace_members` to return only actors who are members of the given workspace

---

## Auth Middleware (`auth/middleware.ts`)

`tokenAuth` gains workspace resolution after actor lookup:

1. Read `X-Workspace-ID` header.
2. **If present:** verify workspace exists and actor is a member → attach `WorkspaceEntry` to context.
3. **If absent:** query `workspace_members` for actor's workspaces:
   - Exactly 1 → auto-select (default single-tenant path; no header required).
   - 0 or 2+ → `400 { error: 'workspace_id_required' }` on workspace-required routes.

`AuthVars` gains:
```ts
workspace: WorkspaceEntry  // { id, name, slug, role: 'admin' | 'member' }
```

**Bypass routes** (workspace resolution skipped):
- `POST /api/workspaces` — creating a workspace has no prior workspace context
- `GET /api/workspaces` — listing workspaces has no prior workspace context

---

## API Layer

### HTTP routes (`routes.ts`)

**Workspace management (no `X-Workspace-ID` required):**
```
POST   /api/workspaces                          createWorkspace
GET    /api/workspaces                          listWorkspacesForActor
```

**Workspace-scoped (require membership):**
```
GET    /api/workspaces/:id/members              listWorkspaceMembers
POST   /api/workspaces/:id/members              addWorkspaceMember  (workspace-admin only)
DELETE /api/workspaces/:id/members/:actorId     removeWorkspaceMember (workspace-admin only)
```

"workspace-admin" means `workspace_members.role = 'admin'` for that specific workspace — not the global `actors.role`.

All existing resource routes (`/api/projects`, `/api/tasks`, etc.) automatically gain workspace scoping via the modified middleware + service layer — no route signature changes needed.

### Error → HTTP status mapping

| Error | Status |
|-------|--------|
| `WorkspaceNotFoundError` | 404 |
| `WorkspaceIsolationError` | 403 |

---

## Frontend (E1-P3)

### `WorkspaceSwitcher.tsx` (new)

Controlled component. Props: `workspaceId`, `onWorkspaceChange`, `token`.

- On mount: `GET /api/workspaces` → populate dropdown.
- Renders workspace names; current workspace slug as button label.
- On select: calls `onWorkspaceChange(id)` — parent clears stale state and re-fetches.

### `App.tsx` (modified)

- New `workspaceId` state (persisted in `localStorage` under key `sprino_workspace_id`).
- `fetchAuth` includes `X-Workspace-ID: ${workspaceId}` on every request when `workspaceId` is set.
- `WorkspaceSwitcher` rendered in the top nav area.
- Changing `workspaceId` clears `tasks`, `projects`, `members` state and triggers full refresh.
- Boot sequence: load workspaces → pick saved or first → then load projects/tasks.

### `Members.tsx` (modified)

- Member list calls `GET /api/workspaces/:id/members` (workspace-scoped).

---

## Testing

### `test/workspaces.test.ts` (E1-P1 red, E1-P2 green)

- `createWorkspace` → `listWorkspacesForActor` round-trip: only returned for member actor
- Workspace isolation: project in workspace A returns 403 for actor scoped to workspace B
- Task creation or listing in wrong workspace → 403
- Default workspace: all pre-existing actors and projects are visible; single-actor scenario auto-selects workspace (no header required)
- `addWorkspaceMember` / `removeWorkspaceMember` CRUD round-trip
- Non-admin (workspace-member role) cannot add or remove members → 403

### `test/auth.test.ts` (E1-P2)

- No header, actor has 1 workspace → 200, workspace auto-selected
- No header, actor has 2 workspaces → 400 `workspace_id_required`
- Header with workspace actor is not a member of → 403
- Valid `X-Workspace-ID` header → 200 with workspace entry on context

### `apps/web/src/components/__tests__/workspace-switcher.test.tsx` (E1-P3)

Stub only with `it.todo()` — per CLAUDE.md "No frontend tests in v1."

---

## Packet Mapping (atomic jobs)

| Packet | Scope |
|--------|-------|
| E1-P1 | `0012_workspaces.sql`, `schema.ts`, `domain/index.ts`, `protocol-types/index.ts`, `test/workspaces.test.ts` (failing) |
| E1-P2 | `service/workspaces.ts`, `service/authorization.ts`, `service/projects.ts`, `service/tasks.ts`, `service/actors.ts`, `auth/middleware.ts`, `routes.ts`, `test/workspaces.test.ts` (passing), `test/auth.test.ts` |
| E1-P3 | `WorkspaceSwitcher.tsx`, `App.tsx`, `Members.tsx`, `workspace-switcher.test.tsx` |

---

## Out of Scope (E1)

- Workspace deletion (E2+)
- Per-workspace billing or entitlement limits (E3+)
- Workspace-level audit log (E2)
- MCP tools for workspace management (E2+)
- Workspace invite flow / email-based onboarding
