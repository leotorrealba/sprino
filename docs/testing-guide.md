# Sprino — Local Testing Guide

A complete, self-contained guide for running and manually testing Sprino from scratch. No prior context required.

---

## Prerequisites

```bash
bun --version          # must be >= 1.3.0  (https://bun.sh)
psql --version         # must be >= 15
pg_isready -h localhost -p 5432   # must say "accepting connections"
```

If Postgres is not running, start it:
```bash
# macOS with Homebrew
brew services start postgresql@16

# or via Docker (if you prefer isolation)
docker run -d \
  --name sprino-postgres \
  -e POSTGRES_USER=sprino \
  -e POSTGRES_PASSWORD=sprino \
  -e POSTGRES_DB=sprino_dev \
  -p 5433:5432 \
  postgres:16-alpine
```

---

## One-time setup

Run this once after cloning the repo. Skip if you've done it before.

```bash
cd /path/to/sprino

# Install dependencies
bun install

# Create the dev and test databases
createdb sprino_dev
createdb sprino_test

# Apply all migrations to both databases
DATABASE_URL=postgres://$(whoami)@localhost:5432/sprino_dev   bun run db:migrate
TEST_DATABASE_URL=postgres://$(whoami)@localhost:5432/sprino_test bun run db:migrate
```

> **Note on the migration runner:** If `bun run db:migrate` runs silently and a table appears missing, apply migrations directly:
> ```bash
> for f in apps/server/src/db/migrations/*.sql; do
>   psql -h localhost -p 5432 -U $(whoami) -d sprino_dev -f "$f"
> done
> ```

---

## Start the servers

Open **two terminal tabs**, both in the project root.

**Tab 1 — API server (port 3001)**
```bash
DATABASE_URL=postgres://$(whoami)@localhost:5432/sprino_dev \
  bun run --filter '@sprino/server' dev
```

Expected output:
```
Sprino server listening on http://localhost:3001
  /api/*  — REST  (Bearer token required)
  /mcp    — JSON-RPC 2.0 (Bearer token required)
```

**Tab 2 — Frontend (port 3000)**
```bash
bun run --filter '@sprino/web' dev
```

Expected output:
```
  VITE v5.x  ready in ...ms
  ➜  Local:   http://localhost:3000/
```

**Verify both are up:**
```bash
curl http://localhost:3001/healthz
# → {"ok":true,"version":"0.0.9","protocol":"tessera/v0.1.2"}

curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/
# → 200
```

---

## Credentials

| Key | Value |
|-----|-------|
| **Bearer token** | `DzDsvHP_XKMqbCWUGNNO74Dy0KEmOJgK` |
| **Actor** | Admin (`a9530e7d-f6b9-4c22-b11f-70aae075a9d7`) |
| **Workspace ID** | `00000000-0000-7000-8000-000000000001` |
| **Workspace name** | Default |
| **Project ID** | `018c3e7a-0002-7000-8000-000000000001` |
| **Project slug** | `sprino` |

These come from the root `.env` file (`SPRINO_ACTORS_JSON`). They are seeded into the database automatically every time the server starts.

> **Why `sprino_dev` and not `sprino_test`?**
> The test suite runs `TRUNCATE ... actors CASCADE` on `sprino_test` before every test file. If the server is pointed at `sprino_test` and you run `bun run test`, your session disappears mid-run. `sprino_dev` is never touched by the test suite — safe to leave running all day.

---

## Test via browser

1. Open **http://localhost:3000**
2. Paste the token into the "Bearer token" field:
   ```
   DzDsvHP_XKMqbCWUGNNO74Dy0KEmOJgK
   ```
3. Click **connect**

The workspace is auto-selected (there's only one). You land on the **Sprino** project task list.

### What to try

| Feature | How |
|---------|-----|
| Create a task | Type in "What needs doing?" → click **create** |
| Change status | Click TODO / DOING / DONE / BLOCKED on any task row |
| Search by title | Type in the "Search title…" box — URL updates live |
| Filter by status | Click the **todo / doing / done / blocked** toggle buttons |
| Filter by assignee | Use the **Assignee: any** dropdown |
| Save a filter | Set filters → click **⭐ Saved views ▾** → **+ Save current filters** |
| Load a saved view | Open **⭐ Saved views ▾** → click a saved view name |
| Delete a saved view | Open **⭐ Saved views ▾** → click **×** next to the view |
| Board view | Click **Board** in the nav bar |
| Sprint view | Click **Sprint** (shows empty state if no active sprint) |
| Members view | Click **Members** — shows all actors with kind/source/status |
| Create a project | Click **+ project** in the nav bar |
| Workspace switcher | Only appears when your actor belongs to 2+ workspaces |

---

## Test via API (curl)

Set these variables once in your shell:

```bash
TOKEN="DzDsvHP_XKMqbCWUGNNO74Dy0KEmOJgK"
WS="00000000-0000-7000-8000-000000000001"
PROJECT="018c3e7a-0002-7000-8000-000000000001"
BASE="http://localhost:3001/api"
```

### Routes that do NOT need `X-Workspace-ID`

```bash
# Health check (no auth)
curl -s $BASE/../healthz | jq .

# List your workspaces
curl -s -H "Authorization: Bearer $TOKEN" $BASE/workspaces | jq .

# Create a new workspace
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Acme Corp","slug":"acme"}' \
  $BASE/workspaces | jq .

# Workspace member management
curl -s -H "Authorization: Bearer $TOKEN" $BASE/workspaces/$WS/members | jq .
```

### Routes that require `X-Workspace-ID`

Add `-H "X-Workspace-ID: $WS"` to every workspace-scoped request.

```bash
# List projects
curl -s -H "Authorization: Bearer $TOKEN" \
     -H "X-Workspace-ID: $WS" \
  $BASE/projects | jq .

# Create a project
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Workspace-ID: $WS" \
  -H "Content-Type: application/json" \
  -d '{"operation_id":"'$(uuidgen | tr A-Z a-z)'","slug":"my-project","display_name":"My Project"}' \
  $BASE/projects | jq .

# List tasks
curl -s -H "Authorization: Bearer $TOKEN" \
     -H "X-Workspace-ID: $WS" \
  "$BASE/tasks?project_id=$PROJECT" | jq .

# Create a task
TASK=$(curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Workspace-ID: $WS" \
  -H "Content-Type: application/json" \
  -d '{"operation_id":"'$(uuidgen | tr A-Z a-z)'","project_id":"'$PROJECT'","title":"My test task"}' \
  $BASE/tasks)
echo $TASK | jq .task.id
TASK_ID=$(echo $TASK | jq -r .task.id)

# Change task status (version=1 on a freshly created task)
curl -s -X PATCH \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Workspace-ID: $WS" \
  -H "Content-Type: application/json" \
  -d '{"operation_id":"'$(uuidgen | tr A-Z a-z)'","status":"doing","version":1}' \
  $BASE/tasks/$TASK_ID/status | jq .task.status

# List task events
curl -s -H "Authorization: Bearer $TOKEN" \
     -H "X-Workspace-ID: $WS" \
  $BASE/tasks/$TASK_ID/events | jq .

# List actors in workspace
curl -s -H "Authorization: Bearer $TOKEN" \
     -H "X-Workspace-ID: $WS" \
  $BASE/actors | jq .
```

---

## Common errors

| HTTP | `error` field | Meaning | Fix |
|------|---------------|---------|-----|
| `401` | `invalid_token` | Token not in DB or revoked | Use the token above. If the test suite ran and wiped the DB, restart the server (it re-seeds on boot). |
| `400` | `workspace_id_required` | Actor has 2+ workspaces and no `X-Workspace-ID` header was sent | Add `-H "X-Workspace-ID: $WS"` |
| `403` | `workspace_not_found_or_not_member` | The workspace ID you sent doesn't exist or your actor isn't a member | Use the workspace ID listed above |
| `403` | `workspace_isolation` | Resource belongs to a different workspace | You're mixing workspace IDs across requests |
| `404` | `not_found` | Wrong project slug or ID | Use `sprino` / the IDs listed above |
| `409` | `version_mismatch` | Optimistic lock — another write happened first | Re-fetch the task and retry with the current `version` number |
| `409` | `duplicate_operation` | Same `operation_id` used twice | Generate a new UUID with `uuidgen \| tr A-Z a-z` |
| `409` | `slug_conflict` | Project slug already in use | Choose a different slug |

---

## Run the test suite

The test suite requires a **separate** `sprino_test` database. It truncates all tables before each test file — never run tests while pointing the server at `sprino_test`.

```bash
# From project root — this is the only correct way to run tests
TEST_DATABASE_URL=postgres://$(whoami)@localhost:5432/sprino_test \
  bun run test

# Expected output
#  Test Files  24 passed (24)
#       Tests  333 passed (333)
```

> **Do NOT use `bun test`** (no `run`). That invokes bun's native test runner which skips the vitest config and all the setup files — 268 tests will appear to fail.

To run a single test file:
```bash
TEST_DATABASE_URL=postgres://$(whoami)@localhost:5432/sprino_test \
  bun run --filter '@sprino/server' test test/workspaces.test.ts
```

---

## Typecheck

```bash
bun run typecheck
```

Should complete with no errors.

---

## MCP (for AI agents)

The same Hono process exposes a JSON-RPC 2.0 MCP endpoint at `/mcp`. AI agents connect with the same bearer token.

```bash
# Example: list MCP tools
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  http://localhost:3001/mcp | jq '.result.tools | length'
# → 29
```

---

## Resetting the dev database

If you want a clean slate on `sprino_dev`:

```bash
# Drop and recreate
dropdb sprino_dev && createdb sprino_dev

# Re-apply all migrations (or use the loop above if the runner skips any)
DATABASE_URL=postgres://$(whoami)@localhost:5432/sprino_dev bun run db:migrate

# Restart the server — it seeds actors + default workspace on boot
```
