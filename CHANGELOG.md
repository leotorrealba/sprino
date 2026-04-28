# Changelog

All notable changes to Sprino are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — though everything below `1.0.0` is pre-release and breaking changes may occur in any pre-`1.0.0` release, including patch tags (`v0.0.x`).

Sprino implements [Tessera](https://github.com/leotorrealba/tessera). The wire protocol is versioned independently in that repo.

## [Unreleased]

### Added
- `CHANGELOG.md` (this file) and `ANNOUNCEMENT.md` blog draft (Phase 8B).

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
