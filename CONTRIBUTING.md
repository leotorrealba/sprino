# Contributing to Sprino

Thanks for your interest. Sprino is the reference implementation of [Tessera](https://github.com/leotorrealba/tessera), an open protocol for AI-native project state. This repo is **AGPL v3**; the protocol repo is **MIT**.

> If you're proposing a change to the wire protocol (verbs, schemas, conformance fixtures), open the PR against [`leotorrealba/tessera`](https://github.com/leotorrealba/tessera) instead. If your change is implementation-specific (Drizzle schema, Hono routes, React UI, Docker), it belongs here.

## Before you start

- **Open an issue first** for anything non-trivial. We'd rather talk through the shape than have you write code that doesn't land.
- Sprino is pre-1.0. APIs may move. We try to avoid gratuitous breakage but won't promise stability until v0.1.
- No CLA. By submitting a PR you license your contribution under AGPL v3.

## Development setup

```bash
git clone https://github.com/leotorrealba/sprino.git
cd sprino
bun install
docker compose up -d postgres
bun --filter '@sprino/server' db:migrate
bun run dev
```

Tests run against a real Postgres in CI (no mocks for Drizzle):

```bash
bun test                  # full server test suite
bun run typecheck         # workspace-wide typecheck
```

## PR workflow

1. **Branch from `main`.** Use `feat/`, `fix/`, `docs/`, or `chore/` prefixes.
2. **Vertical slices.** One PR = one logical change. Don't combine "fix bug X" with "rename module Y".
3. **Test before push.** New behavior needs a test; new bugs need a regression test.
4. **PR title is conventional commits format.** `fix:`, `feat:`, `docs:`, `chore:`, etc. The `pr-title` check enforces this.
5. **Conversation resolution is required.** If a reviewer leaves a comment, address it or push back with a reason. Threads must resolve before merge.
6. **CI must be green.** `ts-typecheck` and `ts-test` are required.
7. **Squash-merge.** No merge commits to `main`.

## Architecture rule (the load-bearing one)

**Single Hono process. `/api/*` and `/mcp/*` are thin adapters over `service/*`.** Idempotency, version checks, and event-log writes are enforced once in the service layer, not duplicated across adapters. The same Drizzle transaction wraps event-write + projection-update.

If you find yourself writing business logic in `adapters/` or in a route handler, move it to `service/`. That's the only architectural rule that matters.

## What we'll merge

- Bug fixes with a regression test
- Performance improvements with before/after numbers
- Docs improvements (typo, clarity, missing context)
- New Tessera verbs **after** the schema lands in the Tessera repo
- Tooling that reduces friction for everyone (not just your editor setup)

## What we probably won't merge

- Switching the framework (Hono → Express, Vite → Next, Postgres → anything)
- Adding a new ORM or replacing Drizzle
- Adding a service layer abstraction that hides the existing one
- Code style changes that don't come with a real reason
- Features that only make sense for hosted/SaaS (this is the OSS repo)

## Code of conduct

Be kind. Argue the design, not the person. If a maintainer says "no" with a reason, that's the answer — bring evidence if you want to reopen it.

Harassment, dismissive replies, or bad-faith engagement gets you blocked. We don't run a court system; the maintainers' judgment is final on this repo.

## Reporting bugs

Open a GitHub issue with:
- Sprino version (commit SHA or tag)
- Postgres version
- Minimal reproduction
- What you expected vs what happened

For **security** issues, follow [SECURITY.md](./SECURITY.md) — don't open a public issue.
