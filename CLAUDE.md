# Sprino — workspace context for Claude Code

## What this project is

**Sprino** is the reference implementation of **[Tessera](https://github.com/leotorrealba/tessera)**, an open protocol for AI-native project state. Sprino is the working PM tool; Tessera is the spec it speaks. Two repos, two licenses, one project.

- This repo: `github.com/leotorrealba/sprino` (AGPL v3) — the implementation.
- Sibling repo: `github.com/leotorrealba/tessera` (MIT) — the protocol. Local clone at `../tessera/`.

## Stack (locked)

- Backend: TypeScript + Hono + Drizzle ORM + Postgres 16
- MCP: `@modelcontextprotocol/sdk` exposed as `/mcp/*` routes in the same Hono process (NOT a separate process)
- Frontend: Vite + React + shadcn/ui + Tailwind (NOT Next.js)
- Validation: Zod
- Realtime: SSE with poll fallback (LISTEN/NOTIFY deferred to v0.2)
- Deploy: Docker Compose

Pin exact minor versions in phase 1's `package.json`.

## Architecture rule (the load-bearing one)

**Single Hono process. `/api/*` and `/mcp/*` are thin adapters over `service/*`.** Idempotency, version checks, and event-log writes are enforced ONCE in the service layer, not duplicated across adapters. Same Drizzle transaction wraps event-write + projection-update.

If you find yourself writing business logic in `adapters/` or in a route handler, move it to `service/`. That's the only architectural rule that matters.

## Folder layout (phase 1 starting state)

```
sprino/
  apps/
    server/   (Hono + Drizzle + Postgres; service/, adapters/{http,mcp}/, db/, domain/)
    web/      (Vite + React + shadcn)
  packages/
    protocol-types/  (TS types generated from Tessera JSON Schemas)
  docker-compose.yml
  package.json (workspace root, pnpm or bun)
```

## Test discipline

- **Protocol layer = TDD.** Write the Tessera JSON conformance fixture FIRST in `../tessera/conformance/<verb>.json`, then implement the backend until it passes.
- **Integration tests** for `service/` and adapters with real Postgres in CI (Testcontainers or Docker service). Don't mock Drizzle.
- **Unit tests sparingly** — only for pure functions (idempotency hash, event-log replay).
- **No frontend tests in v1.** Frontend is a thin viewer; correctness is enforced at the protocol layer.
- **No DDD** until v0.2 introduces real bounded contexts (billing, cloud tenant).

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. The skill has multi-step workflows, checklists, and quality gates that produce better results than an ad-hoc answer. When in doubt, invoke the skill.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke /office-hours
- Strategy, scope, "think bigger", "what should we build" → invoke /plan-ceo-review
- Architecture, "does this design make sense" → invoke /plan-eng-review
- Design system, brand, "how should this look" → invoke /design-consultation
- Design review of a plan → invoke /plan-design-review
- Developer experience of a plan → invoke /plan-devex-review
- "Review everything", full review pipeline → invoke /autoplan
- Bugs, errors, "why is this broken" → invoke /investigate
- Test the site, find bugs → invoke /qa (or /qa-only for report only)
- Code review, check the diff → invoke /review
- Visual polish, design audit → invoke /design-review
- Developer experience audit → invoke /devex-review
- Ship, deploy, create a PR → invoke /ship
- Merge + deploy + verify → invoke /land-and-deploy
- Save progress → invoke /context-save
- Resume, restore → invoke /context-restore
- Security audit → invoke /cso

## Tessera ↔ Sprino split

When in doubt about where a change goes:

- Lives in **Tessera** (`../tessera/`): protocol-level decisions. JSON Schemas, conformance fixtures, the SPEC.md, deprecation policies, semver rules, the `task.create` verb shape itself.
- Lives in **Sprino** (`./`): implementation-level decisions. Drizzle schema, Postgres queries, Hono routes, React components, Docker setup, dogfood UX.

Rule of thumb: if a second implementer would also need to make the same decision, it belongs in Tessera. If it's specific to "how Sprino, the reference impl, does it," it stays in Sprino.

## Design doc

Living design doc with full phase-by-phase plan, architecture rationale, and review history: `~/.gstack/projects/Sprino/leotorrealba-main-design-20260426-234657.md` (maintainer-local, not committed).
