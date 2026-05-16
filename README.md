# Sprino

> **AI-native project management.** Where Claude Code, Cursor, and other agents are first-class authors of work — not invisible.
>
> Reference implementation of the [Tessera protocol](https://github.com/leotorrealba/tessera).

**Status:** pre-alpha. Active development. Latest release: [**v0.2.0**](https://github.com/leotorrealba/sprino/releases/tag/v0.2.0) — multi-workspace tenancy (E1–E3), workflow/board/sprint/search features (D1–D5), `task.update` verb (G2), MCP workspace tools (G1), and Docker smoke CI (G3).

## Why

Project management tools were designed before AI agents became primary contributors. Today, on small dev teams, AI agents do 40-70% of the implementation work, but the PM layer treats them as invisible. Devs end up keeping tasks in markdown files in the repo so their agents can read/write them, then manually copy state back to "real" PM tools for the humans on the team. That workaround breaks at small-team scale, across multiple repos, across sessions, and for non-coding stakeholders.

Sprino fixes this by making agents first-class actors at the schema level — with idempotent operations, structured agent context, and an append-only event log of who did what.

## Two parts

- **Sprino** (this repo, AGPL v3) — the working PM tool. Self-hosted, open-source, MCP-native.
- **[Tessera](https://github.com/leotorrealba/tessera)** (separate repo, MIT) — the open protocol Sprino implements. Other tools can implement Tessera too.

The reason for the split: protocols belong to everyone, implementations belong to whoever maintains them. Tessera is MIT so any tool can implement it. Sprino is AGPL so derivative servers stay open.

## Stack (locked, phase 1 pins versions exactly)

- **Backend:** TypeScript + Hono + Drizzle ORM + Postgres 16
- **Frontend:** Vite + React + shadcn/ui + Tailwind
- **MCP:** `@modelcontextprotocol/sdk` (TypeScript), MCP-over-HTTP exposed as `/mcp/*` routes in the same Hono process
- **Validation:** Zod (exports JSON Schema for Tessera conformance fixtures)
- **Realtime:** SSE with poll fallback
- **Deploy:** Docker Compose, single VPS

## Status & roadmap

This repo is currently the AGPL placeholder for the v1 PoC build. Phase-by-phase development plan and architecture notes live in the design doc (in `~/.gstack/projects/Sprino/` for the maintainer).

- **v0.0.0** — repo scaffold (this commit)
- **v0.0.1** (phase 1) — "Hello Task" slice: protocol fixtures, Postgres schema, Hono backend, MCP routes, single-page frontend, dogfood loop closed
- **v0.0.2** (phase 2) — project scoping + multi-repo: project list/get, repo-aware MCP task creation, frontend project switcher
- **v0.0.3** (phase 3) — task lifecycle + agent presence, single-tenant auth, Tessera v0.1 conformance suite v1
- **v0.0.4** (phase 4) — server-side `task.update`, optimistic locking, error envelope, Codex challenge skill, hardened CI
- **v0.0.5** (phase 5) — Tessera v0.1.0 stabilization, conformance fixtures locked, deprecation policy, semver guarantees
- **v0.0.6** (phase 6) — buffer + hardening: pagination contract on `events.list` / `tasks.list` / `agents.list`, SSE realtime fallback, nightly `pg_dump` backup sidecar with `docs/RESTORE.md` playbook
- **v0.0.7** (phase 7) — 30-minute self-host bundle: server + web Dockerfiles, `bootstrap.sh`, `docs/TOKEN-ROTATION.md`, README walkthrough
- **v0.0.9** (phase 9) — Tessera v0.1.2 actor lifecycle: `actor.register` / `list` / `get` / `revoke_token` verbs, in-app Members tab with rotate/revoke, two-source actor model (env + db) with break-glass recovery, single-SQL auth path, race-safe rotate
- **v0.1.0** ✅ shipped — Tessera v0.1.5 full surface: agent registration and session lifecycle (`actor.heartbeat`, `actor.deactivate`), attachment upload lifecycle (create_upload → PUT → finalize), project creation (`project.create`, slug uniqueness), frontend attachment UI, keyboard-accessible task cards. All 16 Tessera verbs implemented; 233+ conformance tests pass.
- **v0.2.0** ✅ shipped — Multi-workspace tenancy (E1–E3): workspace isolation, audit log + export, entitlements. Workflow/board/sprint/search (D1–D5): state machine, Kanban ordering, hierarchy + deps, sprint planning, saved views + automation. Gap-series: `task.update` verb (G2), MCP workspace tools (G1), Docker smoke CI validating self-host end-to-end (G3).

## Self-host (30 minutes, end-to-end)

You need: Docker (with Compose v2), `git`, `openssl`, ~2 GB free RAM,
~5 GB free disk. `git` and `openssl` are present on virtually every
developer machine; the only thing most people need to install is
Docker. No Postgres install, no Node/Bun, no nginx config.

```sh
git clone https://github.com/leotorrealba/sprino.git
cd sprino
sh bootstrap.sh                       # generates .env with random secrets
docker compose --profile full up -d   # build + start postgres + server + web + backup sidecar
```

When `bootstrap.sh` finishes it prints your admin token. Open
<http://localhost:3000>, paste the name and token, and create your
first task. The server is at <http://localhost:3001> if you want to
poke at the API directly.

To stop everything:

```sh
docker compose --profile full down       # stop, keep data
docker compose --profile full down -v    # stop, wipe Postgres volume
```

### Learn more

- **New here?** Read [`docs/EXPLAINED.md`](./docs/EXPLAINED.md) — Sprino
  in plain English, no jargon.
- **Want the engineering details?** Read
  [`docs/TECHNICAL.md`](./docs/TECHNICAL.md) — architecture, data model,
  request flow, and operational concerns.
- **Architecture decisions (ADRs):** [`docs/adr/`](./docs/adr/) — for example
  [ADR 0001](./docs/adr/0001-e1-e2-e3-workspace-audit-entitlements.md) on
  workspace resolution, audit export isolation, and plan entitlements (E1–E3).

### Day-2 docs

- **Backups & disaster recovery:** [`docs/RESTORE.md`](./docs/RESTORE.md)
  — the `full` profile runs a nightly `pg_dump` sidecar; this is the
  playbook for restoring from one of those files.
- **Rotating tokens:** [`docs/TOKEN-ROTATION.md`](./docs/TOKEN-ROTATION.md)
  — how to replace an actor's bearer token (planned rotation, leak
  response, or full reset). v0.0.9 added in-app rotation for db-source
  actors via the Members tab.
- **Recovering access:** [`docs/TOKEN-RECOVERY.md`](./docs/TOKEN-RECOVERY.md)
  — break-glass playbook for last-admin lockout, lost tokens, and the
  env/db two-source model.
- **Git workflow:** [`docs/git-workflow.md`](./docs/git-workflow.md) —
  branch protection, conversation-resolution gating, the
  `enforce_admins` escape hatch.

This is pre-alpha active development. If you're curious about the project, watch the repo and follow the [Tessera spec](https://github.com/leotorrealba/tessera) — the protocol's evolution is where the interesting work is happening.

## License

[AGPL v3](./LICENSE). The protocol ([Tessera](https://github.com/leotorrealba/tessera)) is MIT — implementations can be any license. The reference implementation is AGPL because we want derivative servers to stay open. If your use case can't accept AGPL, talk to us about a commercial license.
