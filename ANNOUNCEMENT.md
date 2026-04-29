# Sprino is open source — and so is the protocol underneath it

> *Draft. Not yet published. Tone is founder voice; edit before posting to LinkedIn or a blog.*

I built Sprino because my AI agents were invisible.

I'd ask Claude to refactor a module, it would do the work, and then... nothing. No trace. Whatever conversation context the model had at that moment, gone. The next agent — or me, the next morning — would re-investigate the same code, ask the same questions, repeat the same mistakes. The PM tool said "Leo did stuff." Reality said "Leo + 3 agents did stuff and 2 of them disagreed."

The fix isn't more dashboards. It's a shared, append-only record of project state that humans **and** agents can read and write — through the same protocol, with the same actor model, against the same source of truth.

That's what Sprino is. And the protocol it speaks — Tessera — is its own thing, MIT-licensed, in [its own repo](https://github.com/leotorrealba/tessera), so anyone can build a different implementation tomorrow.

## What Sprino does today

Concretely, after the v0.0.9 actor-lifecycle release:

- **In-app member management.** A Members tab in the web UI invites
  humans, rotates tokens, and revokes them — no `.env` edits, no
  restart. New plaintext is shown once, then only the SHA-256 hash
  lives in the database.
- **Two-source actor model.** Actors carry a `source` of `env` or `db`.
  Env actors are reconciled from `SPRINO_ACTORS_JSON` on every boot,
  giving you a guaranteed break-glass recovery path even if the
  database has been tampered with. Db actors are managed entirely at
  runtime through the UI or the `actor.register` Tessera verb.
- **One Hono process, two adapters.** `/api/*` for humans (and the React UI), `/mcp/*` for agents. Same service layer underneath. Idempotency, version checks, and event-log writes happen exactly once, in `service/`, never duplicated across adapters.
- **Append-only event log.** Every state change is an event. Projections (tasks, agents, agent_context) are derived. Same Drizzle transaction wraps event-write + projection-update — so you can't have a state change without a corresponding event, ever.
- **Multi-actor auth.** Bearer tokens, with each actor declared as either `human` or `agent`. Agents get a runtime tag (`claude-code`, `gpt-5`, whatever) and a parent actor. The activity feed shows who did what — not just "the user" or "the API."
- **Optimistic concurrency.** `task.update_status` requires `if_match`. 100 concurrent agents racing on the same task: one wins, ninety-nine get a clean 409. No silent overwrites.
- **Realtime feed.** SSE-based, signed stream tickets, polling fallback. Not LISTEN/NOTIFY yet — that's a v0.2 thing — but the stream replays cleanly on reconnect.
- **Self-host in 30 minutes.** `git clone` → `bash bootstrap.sh` → `docker compose up`. Postgres, Sprino server, web UI. No cloud account, no SaaS. Your data on your hardware.

## Why a separate protocol repo

I made a deliberate split:

- **[Tessera](https://github.com/leotorrealba/tessera)** is the *protocol*. JSON Schemas, conformance fixtures, the SPEC.md. MIT-licensed. If you want to build a Postgres-free, embedded, Rust, edge, or hosted alternative — you don't need my code, you need the spec.
- **[Sprino](https://github.com/leotorrealba/sprino)** is the *reference implementation*. AGPL v3. The opinionated stack: Hono + Drizzle + Postgres + Vite/React. If you self-host Sprino and modify it, you share your changes back. That's the deal.

This is the same pattern as ActivityPub + Mastodon, or LSP + every editor that speaks it. The protocol is the durable thing; the implementation is one possible bet.

## What's not ready

I'd rather tell you up-front than have you find out three weeks in:

- **Single-tenant only.** One Sprino deploy = one team. No multi-org isolation yet. Multi-tenant is the v0.2 headline feature.
- **Token rotation needs a server restart.** Hot reload of the actor registry is on the list, not in the build. *(Fixed in v0.0.9 for db-source actors — the Members tab rotates without restarting. Env-source actors still require a restart by design, as the recovery path.)*
- **No comments, no DnD, no inline editing.** The web UI is a thin viewer. Correctness lives at the protocol layer.
- **No hosted SaaS.** I'll self-host for you if you ask nicely, but there's no signup form. v0.2 is when cloud becomes a real plan.
- **Performance is unmeasured at scale.** Tested fine for tens of agents and hundreds of events. Haven't pushed past that.

If any of those are dealbreakers for your team — wait for v0.2. If they're not, I'd love a real-world stress test.

## What I'm asking for

Three things, in order:

1. **Try it locally.** `git clone`, `bash bootstrap.sh`, `docker compose up`. Tell me where it broke or where the docs lied.
2. **Look at the protocol.** Open the [Tessera SPEC.md](https://github.com/leotorrealba/tessera/blob/main/SPEC.md). The conformance fixtures are in `conformance/` — they replay through any implementation that wants to claim Tessera support. Feedback on the verb shapes is more valuable to me right now than feedback on the React app.
3. **If you're a small team running agents alongside humans:** I want to talk. The v0.2 design (multi-tenant + real-time + a comments verb) is wide open and I'd rather build it with one team that ships it than three teams that prototype.

DM me on GitHub or email leotorrealba@gmail.com.

## Links

- Sprino: <https://github.com/leotorrealba/sprino> — AGPL v3, self-hostable today
- Tessera: <https://github.com/leotorrealba/tessera> — MIT, open protocol
- Self-host walkthrough: <https://github.com/leotorrealba/sprino/blob/main/README.md>
- Token rotation playbook: <https://github.com/leotorrealba/sprino/blob/main/docs/TOKEN-ROTATION.md>
- Security disclosure: <https://github.com/leotorrealba/sprino/blob/main/SECURITY.md>

— Leo
