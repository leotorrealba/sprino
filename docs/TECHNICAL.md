# Sprino — Technical Reference

This is the deep-dive companion to the [README](../README.md). It covers
how Sprino is built, why the architecture looks the way it does, and what
you need to know to operate, extend, or audit the codebase.

For the protocol Sprino implements, see
[Tessera SPEC](https://github.com/leotorrealba/tessera/blob/main/SPEC.md).

---

## 1. What Sprino is, technically

Sprino is the **reference implementation** of [Tessera](https://github.com/leotorrealba/tessera),
an open protocol for AI-native project state. Concretely Sprino is:

- A self-hosted PM tool, packaged as Docker Compose.
- A single TypeScript/Hono process exposing **two adapters** over the same
  business logic: HTTP REST for the web UI, and MCP-over-HTTP (JSON-RPC 2.0)
  for AI clients (Claude Code, Cursor, Codex, etc).
- A Postgres-backed event-sourced store with materialized projections.
- A small React/Vite frontend that renders task state and a live event feed.

The codebase is intentionally small. The entire backend is under
`apps/server/src/` and the frontend under `apps/web/src/`.

---

## 2. Repository layout

```
sprino/
├── apps/
│   ├── server/              # Hono + Drizzle + Postgres + MCP
│   │   ├── src/
│   │   │   ├── main.ts          # Entry — boots Hono, mounts adapters
│   │   │   ├── adapters/
│   │   │   │   ├── http/        # REST routes for the web UI
│   │   │   │   └── mcp/         # MCP JSON-RPC server
│   │   │   ├── service/         # Business logic (the load-bearing layer)
│   │   │   │   ├── tasks.ts
│   │   │   │   ├── projects.ts
│   │   │   │   ├── events.ts
│   │   │   │   ├── agents.ts
│   │   │   │   └── idempotency.ts
│   │   │   ├── domain/          # Zod schemas, types, errors
│   │   │   ├── db/              # Drizzle schema + migrations + client
│   │   │   ├── auth/            # Bearer tokens + SSE stream tickets
│   │   │   └── realtime/        # SSE bus
│   │   └── test/                # Integration tests against real Postgres
│   └── web/                 # Vite + React + shadcn/ui
├── packages/
│   └── protocol-types/      # TS types generated from Tessera schemas
├── docs/
│   ├── TECHNICAL.md         # ← you are here
│   ├── EXPLAINED.md         # plain-English version of this document
│   ├── RESTORE.md           # backup/restore playbook
│   ├── TOKEN-ROTATION.md    # rotating actor bearer tokens
│   └── git-workflow.md      # branch protection, escape hatches
├── docker-compose.yml
├── Dockerfile.server
├── Dockerfile.web
└── bootstrap.sh             # generates .env with random secrets
```

---

## 3. The architectural rule (read this first)

> **One Hono process. `/api/*` and `/mcp` are thin adapters over `service/*`.
> All idempotency, version checks, and event-log writes happen ONCE in the
> service layer.**

This is the only architectural rule that matters. It exists because the
failure mode of a dual-adapter system is duplicating business logic on each
side and letting them drift. Concretely:

- A route handler in `adapters/http/` is allowed to: parse input with Zod,
  call a `service/*` function, format the response. Nothing else.
- An MCP tool handler in `adapters/mcp/` is allowed to: the same.
- All database writes, all idempotency lookups, all `if_match` version
  checks, all event-log appends happen inside `service/*` functions.
- Each mutating service function wraps its event-write + projection-update
  in a single Drizzle transaction.

If you find yourself reaching for business logic in an adapter, stop and
move it down a layer. The integration tests will catch drift between
adapters quickly because both adapters hit the same service functions
through different transports.

---

## 4. Stack (locked)

| Layer | Choice | Why |
| --- | --- | --- |
| Language | TypeScript 5.9 | Shared types between server, web, and protocol-types. |
| Runtime | Bun 1.3 | Fast installs and script execution. Tests run via Vitest (`bun run test`), not Bun's built-in test runner. |
| HTTP | Hono | Edge-ready, tiny, middleware-friendly. Same process for HTTP + MCP. |
| ORM | Drizzle | Typed SQL, no runtime overhead, schema-as-code. |
| DB | Postgres 16 | Event log + JSON columns + LISTEN/NOTIFY (deferred to v0.2). |
| Validation | Zod | Single source of truth for request shapes; exports JSON Schema. |
| MCP | `@modelcontextprotocol/sdk` | Official SDK; we mount it as Hono routes. |
| Frontend | Vite + React + shadcn/ui + Tailwind | Stock React stack — the UI is a thin viewer. |
| Realtime | SSE + 10s polling fallback | Simpler than WebSockets; works behind any proxy. |
| Deploy | Docker Compose | Single VPS, no orchestration. |

Versions are pinned to exact minors in `package.json`; do not use ranges.

---

## 5. Data model

Tessera defines five core resources. Sprino's Drizzle schema
(`apps/server/src/db/schema.ts`) maps them 1:1 to Postgres tables:

| Table | Purpose |
| --- | --- |
| `actors` | Humans + AI agents. `kind` discriminates (`human` / `agent`). |
| `projects` | Scope boundary. Tasks belong to a project. |
| `tasks` | Materialized task state — projection of the event log. |
| `events` | Append-only authoritative log. **Source of truth.** |
| `operations` | Idempotency dedup records (UUIDv7, 30-day retention). |

The `actors` table also carries Sprino-internal lifecycle storage for AI
agents: `lifecycle_state` (`active` / `inactive`),
`last_heartbeat_at`, and `deactivated_at`. These columns support agent
liveness bookkeeping and future expiry policies, but they are deliberately
not part of the Tessera `Actor`, `Agent`, `Task`, or event response shapes.

### Event sourcing

- Every mutating operation writes an event row **before** updating the
  materialized `tasks` row, in the same transaction.
- `tasks.status`, `tasks.assignee_id`, and `tasks.version` are projections
  of the latest matching event.
- Replaying the event log in `created_at` order MUST yield the same
  materialized state. This is the contract that lets us evolve projections
  without losing history.

### Idempotency

Clients supply a UUIDv7 `operation_id` on every mutating verb. The flow:

1. Compute `request_hash = sha256(canonical_json(request_body))`.
2. Look up the operation row.
3. **Hit, same hash** → return the cached response verbatim. No new event.
4. **Hit, different hash** → return `409 Conflict` with the cached response
   (the original wins; the second request is treated as a programming error).
5. **Miss** → execute, then INSERT operation row + event + projection
   update, all in one transaction.
6. Operations expire after 30 days; expired retries return `410 Gone`.

This is implemented in `service/idempotency.ts`. Both adapters call it; no
adapter is allowed to short-circuit it.

### Optimistic concurrency

Every mutating verb takes `if_match: <version>`. On match, server writes
the event and increments the version. On mismatch, server returns
`409 Conflict` with the **server's current task body** so the client can
re-read and retry.

This exists because AI agents tend not to pause to check state before
writing. Last-write-wins would be a footgun.

---

## 6. Request flow

### HTTP (REST)

```
client → Hono → bearer auth middleware → route handler (adapters/http)
       → service/<verb>(...) → Drizzle transaction → Postgres
       → SSE bus broadcast (if mutating) → response
```

### MCP-over-HTTP

```
agent → Hono → /mcp endpoint → MCP SDK JSON-RPC dispatch
      → tool handler (adapters/mcp) → service/<verb>(...) → ... (same as above)
```

The two adapters converge on `service/*` after argument parsing. The
service layer is transport-agnostic; it neither knows nor cares whether
its caller arrived via HTTP or MCP.

### Auth

- HTTP and MCP both require `Authorization: Bearer <token>`.
- All tokens live in the `actor_tokens` table (`token_hash` is
  `sha256(plaintext)`; plaintext is never persisted). The bearer
  middleware always queries `actor_tokens JOIN actors` — there is no
  fallback to an in-memory env registry at request time. This single
  auth path eliminates the "two registries can disagree" failure mode
  that the v0.0.7 boot-time-only registry was vulnerable to.
- Env-declared actors (`SPRINO_ACTORS_JSON`) are imported into the
  database on every boot by `seedFromEnv()` (`apps/server/src/db/seed.ts`).
  Each row carries `source: 'env' | 'db'` so the Members UI can disable
  rotate/revoke for env-managed credentials. See
  [Section 10b](#10b-actor-lifecycle-v009) for the full reconciliation
  contract and recovery story.
- The middleware attaches the resolved `actor` to the Hono request
  context, including the actor's internal `role` (`admin` | `member`).
  The HTTP/MCP adapters then pass `actorId` explicitly into `service/*`
  functions for `created_by` fields and the event log's actor reference;
  the service layer is transport-agnostic and does not depend on Hono
  context.
- Actor-admin verbs (`actor.register`, `actor.revoke_token`, and
  Sprino-only `rotate_token`) are authorized in the service layer via a
  centralized `authorization.ts` helper. Current Phase A policy is:
  only `human` actors with `role='admin'` may manage actor credentials.
  Adapters only translate the resulting forbidden error into HTTP / MCP
  wire shapes.
- For SSE, browsers can't set custom headers on `EventSource`, so we issue
  short-lived **stream tickets** signed with HMAC-SHA256 over
  `${actorId}.${projectId}.${exp}`. The issued ticket is the dotted string
  `<actor_id>.<project_id>.<exp_ms>.<base64url(signature)>`. Clients
  exchange a Bearer token for a ticket, then pass that full string as the
  `ticket` query param.
- SSE ticket verification is necessary but not sufficient: on both the
  initial handshake and the live poll loop, the server re-checks that the
  ticket-bound actor still has an active credential. Revoking an actor's
  bearer token therefore invalidates both stale tickets and already-open
  event streams.

### Realtime

- Mutating service functions broadcast events to a process-local SSE bus
  after the transaction commits.
- HTTP clients subscribe to `/api/events/stream?ticket=...&project_id=...`.
- The frontend falls back to a 10-second poll if SSE drops. This is
  deliberately simple — no LISTEN/NOTIFY across instances yet (deferred to
  v0.2 when multi-tenant lands).

---

## 7. Operations

### Self-host

The 30-minute walkthrough lives in the [README](../README.md#self-host).
Summary:

```sh
git clone https://github.com/leotorrealba/sprino.git
cd sprino
sh bootstrap.sh                       # generates .env
docker compose --profile full up -d   # postgres + server + web + backup sidecar
```

Print the admin token from `.env`, open `http://localhost:3000`, paste
name + token, create a task. The `full` profile includes a nightly
`pg_dump` sidecar that writes timestamped dumps to `./backups/`.

### Backup & restore

- The `backup` service runs `pg_dump` on a cron and writes to a mounted
  volume. Retention is configurable via `BACKUP_RETENTION` (default 30).
- Restore playbook: [`docs/RESTORE.md`](./RESTORE.md).
- The backup/restore integration test lives at `scripts/backup.test.sh`
  and can be run explicitly with `bun run test:backup`. It is not part
  of the default CI workflow — operators should run it as part of a
  release checklist or pre-deploy verification.

### Token rotation

- Bearer tokens live in `SPRINO_ACTORS_JSON`. Rotation = edit env, restart
  server. The full playbook (planned rotation, leak response, full reset)
  is in [`docs/TOKEN-ROTATION.md`](./TOKEN-ROTATION.md).
- Stream-ticket secrets rotate independently (`SPRINO_STREAM_SECRET`).

### Pagination & limits

- `events.list` — limit ≤ 1000.
- `tasks.list` — limit ≤ 500.
- `agents.list` — limit ≤ 100.
- List endpoints take `limit` + `offset` (validated by the server's
  pagination schema in `domain/pagination.ts`). The implemented list
  responses (`EventListResSchema`, `TaskListResSchema`,
  `AgentListResSchema`) return arrays only — no `next_page_token`.
- `next_page_token`(s) are reserved for **agent-context truncation**:
  `task.get` returns a map of `agent_context.next_page_tokens` when the
  embedded context is truncated to keep the response under 32 KB, and
  the dedicated tail endpoints (`/tasks/:id/events` and
  `/tasks/:id/related_tasks`) accept that token to fetch the rest.
- The contract is locked for v0.1 in Tessera and tested in
  `pagination.test.ts`.

---

## 8. Testing

The test discipline is documented in [CLAUDE.md](../CLAUDE.md). Summary:

- **Protocol layer = TDD against Tessera fixtures.** Conformance tests in
  `apps/server/test/conformance.test.ts` replay every `*.req.json` /
  `*.res.json` pair from the sibling `tessera/conformance/fixtures/`
  directory against a live server.
- **Integration tests** for `service/*` and adapters use a real Postgres
  (in CI, a GitHub Actions `services.postgres` container reached via
  `TEST_DATABASE_URL`; locally, a Docker Compose `postgres` service on
  port 5433). No mocks of Drizzle, no in-memory shims.
- **Unit tests sparingly.** Reserved for pure functions: idempotency hash,
  event-log replay, base64url encoding.
- **No frontend tests in v0.1.** The frontend is a thin viewer; correctness
  is enforced at the protocol layer.

Run locally:

```sh
DATABASE_URL=postgres://sprino:sprino@localhost:5433/sprino_test \
TEST_DATABASE_URL=postgres://sprino:sprino@localhost:5433/sprino_test \
bun run test
```

Current state: 9 test files, 82 tests, all passing.

---

## 9. Tessera ↔ Sprino split (where things go)

When deciding whether a change belongs in this repo or the protocol repo,
ask: **would a second implementer also need to make the same decision?**

| Lives in Tessera (`../tessera/`) | Lives in Sprino (this repo) |
| --- | --- |
| JSON Schemas for resources/verbs | Drizzle schema, Postgres queries |
| Conformance fixtures | Hono routes, MCP tool registrations |
| `SPEC.md`, semver rules, deprecation policy | Docker setup, frontend, dogfood UX |
| The shape of `task.create` itself | How `task.create` is wired to `service/tasks.ts` |
| Idempotency *rules* (UUIDv7, 30-day, 409-on-mismatch) | Idempotency *implementation* (`service/idempotency.ts`) |

If you find yourself wanting to relax a Tessera rule to fit a Sprino
constraint, you are working at the wrong layer — open an issue on Tessera
instead.

---

## 10. License

Sprino is [AGPL v3](../LICENSE). Tessera is MIT. The split is deliberate:
protocols belong to everyone, reference implementations should keep their
improvements in the commons. If your use case can't accept AGPL, talk to
us about a commercial license.

---

## 10b. Actor lifecycle (v0.0.9)

The v0.0.9 release replaced the in-memory env-only actor registry with
a single SQL-backed auth path. Three properties are load-bearing:

**Token format.** Plaintext bearer tokens are 24 random bytes,
base64url-encoded (no padding) when minted in-app. The database stores
only `sha256(plaintext)` (hex) in `actor_tokens.token_hash`. Plaintext
appears exactly twice: in the HTTP/MCP response that mints it, and in
the one-time-reveal dialog in the Members UI.

**Single auth path.** The bearer middleware always queries
`actor_tokens` joined to `actors`. There is no fallback to the env
registry at request time. Env actors are imported into the database on
boot by `seedFromEnv()` (`apps/server/src/db/seed.ts`), which:

1. Inserts any new env actors with `source='env'`.
2. Inserts each env token row if no row with that hash exists yet. If a
   row with the same `token_hash` is already present and **active**, no
   change is made (idempotent restart). If it is present and **revoked**,
   `seedFromEnv()` rejects with a hard error: re-introducing a
   previously-revoked credential is treated as a security smell, and the
   error message tells the operator to mint a fresh token instead.
3. Never deletes — actors removed from the env stay in the database
   for audit history but have no active token.

**Race-safe rotate.** `actor_tokens` carries a partial unique index:

```sql
CREATE UNIQUE INDEX actor_tokens_active_actor_idx
  ON actor_tokens (actor_id) WHERE revoked_at IS NULL;
```

Postgres enforces "at most one active token per actor" as a hard
invariant. The `rotateToken` service snapshots the current active
token IDs *before* opening the transaction, then inside the
transaction issues `UPDATE ... WHERE id IN (snapshot) AND revoked_at
IS NULL RETURNING id`. If `rowsAffected !== snapshot.length`, another
caller won the race and we throw `ConcurrentRotationError`. The
partial unique index is the backstop if any other code path forgets
the check.

**Idempotency redaction.** `actor.register` is idempotent on
`operation_id`, like every other Tessera write verb. To avoid leaking
plaintext tokens through the idempotency cache, the service writes a
redacted body — just `{ actor }`, with no `token` field — to
`operations.response_body`. On a same-`operation_id` replay (whether
through `checkIdempotency` or the post-INSERT race fallback), the
caller gets back that same `{ actor }` shape. The plaintext token is
returned exactly once — on the original successful call — and is
never recoverable from the database. A caller that lost it must call
`actor.revoke_token` and re-register.

**Last-admin guard.** `revokeToken` checks whether the actor is the
only human with an active token and refuses with `409
last_admin_protected` — that's the path that could leave the system
without an admin credential. `rotateToken` does **not** need this
guard because rotate is atomic revoke + insert in a single
transaction: the actor still ends with one active token after the
call, so the system-wide active-human count is preserved. Env-source
actors are rejected by both verbs with `400 operation_unsupported`
(error class `EnvActorImmutableError`) — operators rotate them by
editing `.env` and restarting, which is the documented break-glass
path (`docs/TOKEN-RECOVERY.md`).

---

## 10c. Agent lifecycle persistence (B2)

B2 adds storage and an internal service primitive for agent runtime
liveness without changing the external Tessera contract.

**Storage contract.** Migration `0005_agent_lifecycle.sql` creates
`actor_lifecycle_state` with `active` and `inactive`, then adds three
columns to `actors`:

- `lifecycle_state`: non-null, default `active`.
- `last_heartbeat_at`: nullable until the first successful heartbeat.
- `deactivated_at`: nullable until the first deactivate transition.

The migration also adds `actors_lifecycle_state_idx` and
`actors_agent_liveness_idx` so future liveness scans can filter by
actor kind, lifecycle state, and heartbeat timestamp without table scans.

**Transition boundary.** `transitionAgentLifecycle()` in
`apps/server/src/service/actors.ts` is the only B2 transition primitive.
It row-locks the target actor, rejects transitions for humans, records
heartbeats only while an agent is active, and treats repeated deactivate
calls as idempotent. Adapters do not call this yet; when heartbeat or
deactivate verbs become public, adapters should stay thin and delegate to
this service boundary.

**Wire contract.** Lifecycle fields remain internal. `actor.get`,
`actor.list`, Sprino's `/api/agents`, task responses, event responses,
and MCP actor structured content continue to expose the same external
shapes as before B2. The conformance regression in
`apps/server/test/conformance.test.ts` first writes heartbeat/deactivate
state through the internal primitive, then checks HTTP actor/agent/task/event
responses and MCP actor responses for absence of `lifecycle_state`,
`last_heartbeat_at`, and `deactivated_at` (including camelCase variants).

---

## 11. Where to go next

- New to the project? Read [`docs/EXPLAINED.md`](./EXPLAINED.md).
- Implementing Tessera in another language? Start with the [Tessera SPEC](https://github.com/leotorrealba/tessera/blob/main/SPEC.md)
  and run our conformance suite against your server.
- Contributing? Read [`CONTRIBUTING.md`](../CONTRIBUTING.md) and
  [`docs/git-workflow.md`](./git-workflow.md).
- Reporting a security issue? See [`SECURITY.md`](../SECURITY.md).
