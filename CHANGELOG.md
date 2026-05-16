# Changelog

All notable changes to Sprino are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — though everything below `1.0.0` is pre-release and breaking changes may occur in any pre-`1.0.0` release, including patch tags (`v0.0.x`).

Sprino implements [Tessera](https://github.com/leotorrealba/tessera). The wire protocol is versioned independently in that repo.

## [Unreleased]

## [v0.2.0] — 2026-05-16

### Added

- **`task.update` (Tessera v0.1.5 gap G2)** — `PATCH /api/tasks/:id` and
  `sprino.task.update` MCP tool for patching title, description, and
  assignee. Implements OCC via `if_match` version guard, writes a
  `context_updated` event with `{from, to}` delta payload, and supports
  full idempotency replay on `operation_id`.
- **MCP workspace tools (G1)** — `sprino.workspace.list`,
  `sprino.workspace.get`, and `sprino.workspace.resolve` MCP tools with
  automatic single-workspace resolution; `sprino.workspace_member.list` for
  membership inspection. HTTP/MCP auth now distinguishes
  `no_workspace_membership` (403) from `workspace_id_required` (400).
- **Docker smoke test (G3)** — `scripts/smoke.sh` exercises
  `bootstrap.sh --force` → `docker compose --profile full up -d --build` →
  health polling → authenticated API call → teardown. `KEEP_UP=1` escape
  hatch for debugging. GitHub Actions workflow
  `.github/workflows/docker-smoke.yml` runs on every push to `main` and on
  PRs touching Docker-related files.
- **Workflow state machine (D1)** — `workflow_columns` table with configurable
  per-project columns; `sprino.workflow.transition` MCP tool; guard rules
  enforced in the service layer.
- **Backlog and board ordering (D2)** — fractional-rank ordering for backlog
  list and Kanban board; drag-and-drop reorder via `PATCH /api/tasks/:id/rank`.
- **Hierarchy and dependency management (D3)** — parent/child task nesting,
  `blocks`/`blocked_by` dependency edges, and cycle-detection guard.
- **Sprint and iteration planning (D4)** — `sprints` table, sprint CRUD
  (`POST/GET/PATCH/DELETE /api/sprints`), task-to-sprint assignment, and
  sprint velocity reporting endpoint.
- **Search, saved views, and automation rules (D5)** — full-text task search
  (`GET /api/tasks?q=`), saved view persistence, and per-project automation
  rule engine (trigger → action evaluation on every task mutation).
- **Multi-workspace tenancy (E1)** — `workspaces` and `workspace_members`
  tables; all service layer calls assert workspace ownership before
  operating on projects/tasks/actors; auth middleware resolves and injects
  workspace context.
- **Audit governance and export (E2)** — append-only `audit_log` table wired
  to every mutating service call; `GET /api/audit` export endpoint with
  date/actor/resource filters; `docs/OPERATOR-RUNBOOK.md`.
- **Entitlements and billing guardrails (E3)** — `entitlements` table with
  per-workspace feature flags; middleware-level gate for seat count, storage
  quota, and feature availability; billing webhook receiver stub.

### Changed

- Task mutation endpoints (`status`, `update`) now validate the task's
  project belongs to the requesting workspace before executing, preventing
  cross-workspace data access at the service layer.
- `assignee_id` updates trigger automation rules only when the value
  actually changes (not just when the field is present in the request).
- `sprino.task.update` MCP tool enforces at-least-one-field via JSON Schema
  `anyOf`, mirroring the HTTP Zod `.refine()` constraint.

### Fixed

- `ActorNotFoundError` now returns HTTP 404 on `PATCH /api/tasks/:id` when
  an unknown `assignee_id` is provided (was 500 before).
- Workspace isolation test now exercises the service-layer
  `assertProjectInWorkspace` guard rather than the auth middleware layer.

## [v0.1.0] — 2026-05-06

### Added
- Internal actor roles (`admin` / `member`) are now persisted on `actors`,
  hydrated through auth middleware, and enforced for actor-admin verbs in
  both HTTP and MCP transports.
- Internal agent lifecycle persistence now stores `lifecycle_state`,
  `last_heartbeat_at`, and `deactivated_at` on `actors`, with service-layer
  `heartbeat` / `deactivate` transitions for agent liveness bookkeeping.
- Added dedicated regression coverage for actor-admin authorization, the
  last-admin concurrent revoke race, project seed slug collisions, and SSE
  credential revocation behavior.
- Added conformance regression coverage proving B2 agent lifecycle storage
  stays internal across HTTP actor/agent/task/event response shapes and MCP
  actor response shapes.

### Changed
- `actor.register`, `actor.revoke_token`, and Sprino-only
  `rotate_token` now authorize in the service layer through one shared
  policy kernel instead of relying on transport-specific behavior.
- Last-admin revoke protection now serializes on the active-human lock set,
  preventing two concurrent revokes from dropping the system to zero active
  human credentials.
- Project seeding in `db:migrate` now merges deterministically by existing
  project identity (`id` or `slug`) so repeated runs do not fail when an
  incoming seed changes project ids.
- Agent lifecycle transitions are centralized in `service/actors.ts`; future
  adapters should delegate there instead of duplicating heartbeat or
  deactivate business logic at the transport edge.

### Fixed
- Revoking an actor credential now invalidates stale SSE tickets and
  terminates already-open SSE streams on the next poll cycle.

## [v0.0.9] — 2026-04-29

### Added (Phase 9 — Actor lifecycle)
- **Tessera v0.1.2 verbs**: `actor.register`, `actor.list`, `actor.get`,
  `actor.revoke_token` exposed over both HTTP (`/api/actors*`) and MCP
  (`/mcp`). Sprino-only `POST /api/actors/:id/rotate_token` for in-app
  credential rotation.
- **Members tab** in the web UI: invite humans, rotate/revoke tokens
  for db-source actors, with a one-time-reveal dialog for new
  plaintext credentials. Env-source actors render with an "edit .env
  to rotate" hint and disabled actions.
- **Two-source actor model**: every actor row carries `source: 'env' |
  'db'`. Env actors are reconciled into the database on every server
  boot via `seedFromEnv()` — restoring an env entry restores access
  even if the database has been tampered with.
- `docs/TOKEN-RECOVERY.md` — break-glass playbook covering lost-admin,
  lost-token, and "I want a guaranteed recovery path" scenarios.

### Changed
- **Single auth path.** Bearer middleware no longer reads
  `SPRINO_ACTORS_JSON` at request time. All credentials live in
  `actor_tokens`; env tokens are imported at boot. Eliminates the
  "two registries can disagree" failure mode of v0.0.7.
- `actor_tokens` table gained a partial unique index `(actor_id) WHERE
  revoked_at IS NULL` — Postgres enforces "at most one active token
  per actor" as a hard invariant. Race-safe rotate snapshots active
  IDs before the transaction and uses a conditional UPDATE that throws
  `ConcurrentRotationError` if another caller won the race.
- `actor.register` responses are **redacted in the idempotency cache**:
  the persisted `operations.response_body` carries only the `actor`
  field — no `token`, no flag of any kind. Replays of the same
  `operation_id` return that same `{ actor }` shape (no `token`),
  preserving "the plaintext is shown exactly once" as a hard
  invariant. Callers that lost the plaintext must `actor.revoke_token`
  and re-register.
- Last-admin guard: revoking the only active human admin token returns
  `409 last_admin_protected` so an operator cannot lock themselves out
  by accident. `rotateToken` does not need this guard because rotate
  is atomic revoke+insert in one transaction — the actor still ends
  with one active token, so the system-wide active-human count is
  preserved by construction.

### Fixed
- `docs/TOKEN-ROTATION.md` updated to describe the v0.0.9 split: db
  actors rotate via the UI, env actors still rotate via env-edit +
  restart.

### Known limitations
- No agent-runtime metadata UI yet (the field is plumbed end-to-end
  but the Members table doesn't surface it).
- Audit feed shows actor verbs as raw `actor.register` etc. — no
  prettier rendering yet.

## [v0.0.7] — 2026-04-28

### Added (Phase 7 — Self-host bundle)
- `Dockerfile.server` and `Dockerfile.web` — multi-stage production builds.
- `bootstrap.sh` — interactive 30-minute self-host installer. Generates a per-deploy `SPRINO_STREAM_SECRET`, seeds an admin actor, and wires `.env` for `docker compose up`.
- `README.md` self-host walkthrough (≤30 minutes from `git clone` to `localhost:3000`).
- `docs/TOKEN-ROTATION.md` — how to rotate Bearer tokens with zero downtime: edit `SPRINO_ACTORS_JSON`, restart the server, verify new tokens work, deactivate old ones.

### Fixed (post-merge cleanup)
- `bootstrap.sh`: `SAFE_SLUG_RE` now mirrors the server's `projectSlug` schema exactly (lowercase + hyphens, 1–64 chars, no leading/trailing hyphen). Previously the bootstrap accepted display-name patterns that the server would 422.
- `docs/TOKEN-ROTATION.md`: corrected three spots that described 401 responses for invalid Bearer tokens — the server returns `403 invalid_token` for present-but-invalid Bearer; 401 is reserved for missing/malformed `Authorization` header.
- `README.md`: prereqs now list Docker + `git` + `openssl` (bootstrap requires all three).

### Known limitations
- Single-node deploy only; no horizontal scaling docs.
- `bootstrap.sh` is bash-only (works on macOS/Linux, not Windows native).

## [v0.0.6] — 2026-04-27

### Added (Phase 6 — Buffer + hardening)
- **6A — Backup sidecar.** Nightly `pg_dump` container with retention policy. `docs/RESTORE.md` documents the restore drill (verified by `scripts/backup.test.sh`).
- **6B — Pagination + limits.** `GET /api/events`, `GET /api/tasks`, `GET /api/agents` enforce server-side caps (1000 / 500 / 100) with cursor-based `next_cursor` responses. Limits live in `apps/server/src/domain/pagination.ts`.
- **6C — SSE realtime feed.** `GET /api/events/stream` is an SSE endpoint signed with short-lived stream tickets (HMAC over `SPRINO_STREAM_SECRET`). Web UI subscribes via `EventSource`; falls back to 10s polling if SSE is unavailable. **No LISTEN/NOTIFY yet** — stream replays from the events table on connect (deferred to v0.2).

### Notes
- Tag `v0.0.6` was pushed after Phase 6 merged. Tessera fixture compatibility verified (Phase 5 conformance still green).

## [v0.0.5] — 2026-04-27

### Added (Phase 5 — Conformance)
- Tessera v0.1.1 conformance suite replay. `apps/server/test/conformance.test.ts` reads each fixture from `../tessera/conformance/*.json` and replays it through the live HTTP routes against a real Postgres. Any drift from the spec fails CI.
- Spec-lock: bump Tessera version requires bumping `@sprino/protocol-types` and re-running conformance.

## v0.0.4 — 2026-04-26 (Phase 4 — Hardening; rolled into the v0.0.5 tag)

### Added
- **4A — Agent context.** Per-agent scratch space (`agent_context`) with a 32KB cap and pagination endpoints. Append-only, no overwrites; the agent can summarize-and-trim itself.
- **4B — Optimistic concurrency.** `task.update_status` requires `if_match` (the task's current version). Mismatched versions return `409 conflict`. Version is bumped inside the same transaction as the event write.
- **4C — Concurrency stress test.** 100 concurrent `update_status` calls against the same task. Exactly one wins; the other 99 get `409`. Test asserts wall-clock runtime stays under the budget on a monotonic clock.

## v0.0.3 — 2026-04-26 (Phase 3 — Auth + activity feed; rolled into the v0.0.5 tag)

### Added
- **3A — Bearer-token auth.** Multi-actor registry seeded from `SPRINO_ACTORS_JSON`. Each actor has a `kind` (`human` | `agent`), an opaque token, and (for agents) a runtime tag and parent actor. Middleware returns `401 missing_or_malformed_authorization` for missing/malformed `Authorization` headers and `403 invalid_token` for valid-shape-but-unknown Bearer tokens.
- **3B — Events list endpoint.** `GET /api/events` returns the append-only event log, scoped to the project. Powers the activity feed.
- **3C — Activity feed UI.** Web app polls `/api/events` every 10 seconds and renders one row per event with the originating actor's display name and a relative timestamp.

## v0.0.2 — 2026-04-26 (early protocol-types; rolled into the v0.0.5 tag)

### Added
- `@sprino/protocol-types` — TypeScript types generated from Tessera v0.0.2 JSON Schemas.
- First end-to-end task creation path (`task.create`) wired through HTTP, MCP, and the projection.

## v0.0.1 — 2026-04-26 (rolled into the v0.0.5 tag)

### Added
- Bootstrapped Sprino as the reference implementation of Tessera.
- Workspace skeleton: `apps/server` (Hono + Drizzle + Postgres), `apps/web` (Vite + React + shadcn), `packages/protocol-types`.
- PR CI workflow: `pr-title` (conventional commits), `ts-typecheck`, `ts-test`.

---

## Versioning notes

- Pre-1.0 patches (`v0.0.x`) ship per phase as we hit milestones. Breaking changes are allowed and are called out in the relevant section.
- Tessera (the protocol) is versioned independently. Sprino's `@sprino/protocol-types` package mirrors Tessera's tag exactly.
- The first stable tag (`v0.1.0`) will lock the wire protocol surface. Until then, treat anything in `apps/server/src/adapters/` as load-bearing-but-evolving.

## Honest known limitations as of v0.0.7

- **Single-tenant only.** No row-level project isolation across multiple orgs; one Sprino deploy = one team.
- **No real-time at scale.** SSE replays from the events table; no LISTEN/NOTIFY yet. Fine for ≤100 active subscribers; not benchmarked higher.
- **Token rotation requires a server restart** (env-var-driven actor registry). Hot reload is on the v0.2 list.
- **Web UI is intentionally thin.** No drag-and-drop, no inline editing, no comments. The protocol layer is where correctness lives; the UI is a viewer for now.
- **No hosted SaaS.** Self-host only. Cloud is on the roadmap, not on the calendar.
- **macOS / Linux only.** `bootstrap.sh` is bash; Windows users need WSL.

[Unreleased]: https://github.com/leotorrealba/sprino/compare/v0.0.7...HEAD
[v0.0.7]: https://github.com/leotorrealba/sprino/compare/v0.0.6...v0.0.7
[v0.0.6]: https://github.com/leotorrealba/sprino/compare/v0.0.5...v0.0.6
[v0.0.5]: https://github.com/leotorrealba/sprino/compare/v0.0.0...v0.0.5
