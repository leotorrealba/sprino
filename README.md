# Sprino

> **AI-native project management.** Where Claude Code, Cursor, and other agents are first-class authors of work — not invisible.
>
> Reference implementation of the [Tessera protocol](https://github.com/leotorrealba/tessera).

**Status:** pre-alpha. Active development. v0.0.0 = empty scaffold; v0.1.0 lands at the end of phase 8.

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
- **v0.0.x** — vertical slices, one per phase, through phase 8
- **v0.1.0** (phase 8) — first public release, self-host walkthrough, Tessera v0.1 milestone

## Self-host (target: phase 8)

```sh
docker compose up    # not yet available — coming v0.1
```

Until v0.1, this is private active development. If you're curious about the project, watch the repo and follow the [Tessera spec](https://github.com/leotorrealba/tessera) — the protocol's evolution is where the interesting work is happening this quarter.

## License

[AGPL v3](./LICENSE). The protocol ([Tessera](https://github.com/leotorrealba/tessera)) is MIT — implementations can be any license. The reference implementation is AGPL because we want derivative servers to stay open. If your use case can't accept AGPL, talk to us about a commercial license.
