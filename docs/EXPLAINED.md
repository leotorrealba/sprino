# Sprino, Explained Like You're New Here

This is the no-jargon version. If you want the engineering deep-dive,
read [`TECHNICAL.md`](./TECHNICAL.md) instead.

## What is Sprino?

Sprino is a project management tool — like Jira, Linear, or Trello — but
designed for teams where AI agents (Claude, Cursor, Copilot, ChatGPT,
etc) do a big chunk of the actual work.

You self-host it. You own the data. It's free and open source.

## Why does it exist?

Today on small dev teams, AI agents do somewhere between 40% and 70% of
the implementation work. But the project management tools we use were
all designed before agents existed. They treat agents as invisible —
either as "the human's typing fingers" or as a separate ticketing system
the human has to relay messages between.

So what teams end up doing is:

1. Keeping their tasks as markdown files inside the git repo, so the
   agent can read and write them directly.
2. Manually copying state back to "real" PM tools (Jira, Linear) so the
   non-coding humans on the team can see what's happening.

That works for one person and one repo. It breaks the moment you add a
second repo, a second person, a designer who doesn't read markdown, or
a multi-week project where you forget what the agent did three weeks
ago.

Sprino is what you get if you redesign PM tooling assuming agents are
first-class authors of work, not invisible.

## What's special about it?

Three things, in plain English:

1. **Agents are real users.** When an agent creates a task or updates
   one, it shows up as the agent — not as you. You can see "the Claude
   agent in repo X opened this task" right next to "Maria moved this to
   in-progress." The history is honest.

2. **Idempotent operations.** Agents don't always know if their last
   request worked (network blips, retries, parallel sessions). Sprino's
   protocol gives every operation an ID, so retrying never creates
   duplicates. You can ask the same question twice and get the same
   answer.

3. **Append-only event log.** Every change is a permanent fact. Nothing
   is overwritten silently. If a teammate (human or agent) wants to
   know what happened to a task, they can read the log instead of
   guessing.

## Who is it for?

- A solo developer working with Claude Code or Cursor on a project, who
  wants their AI assistant to actually own and update tasks.
- A small team (2–8 people) running multi-agent workflows and tired of
  manually keeping a Linear board in sync with what the agents did.
- A founder, designer, or PM on that team who needs to see project
  status without reading markdown files in a repo.
- Anyone who wants to self-host their PM tool because their data
  shouldn't live in someone else's SaaS.

## How does it work?

There's a small server (written in TypeScript) and a small web frontend.
You run them with Docker on any machine — your laptop, a small VPS,
your home server. Setup is one command after Docker is installed:

```sh
git clone https://github.com/leotorrealba/sprino.git
cd sprino
sh bootstrap.sh
docker compose --profile full up -d
```

Open `http://localhost:3000`, paste your name and token, and you're in.

When an AI assistant (Claude Code, Cursor, etc) wants to talk to Sprino,
it does so through **MCP** — the Model Context Protocol. Sprino exposes
a built-in MCP server, so any agent that speaks MCP can list your
tasks, create new ones, or update status, without you copy-pasting
anything into a chat box.

## Sprino vs Tessera — what's the difference?

You'll see "Tessera" mentioned a lot. They're two parts of the same
project:

- **Tessera** is *the spec*. It says: "If you want to be an AI-native
  PM tool, here's the shape your data should have." It's a written
  document, MIT-licensed, free for anyone to implement.
- **Sprino** (this repo) is *the working code*. It's one specific tool
  that follows the Tessera spec. AGPL-licensed.

Why split them? Because protocols outlive any single implementation.
Tessera could one day be supported by Linear, Jira, or a tool that
hasn't been written yet — Sprino doesn't need to be the only Tessera
implementation forever.

If that distinction sounds familiar: it's the same pattern as LSP
(Language Server Protocol), which is implemented by every editor and
every language server. Tessera is trying to be the LSP of AI-native
project state.

## What it is NOT

Setting expectations:

- **Not a SaaS.** You self-host. There's no "Sign up at sprino.com"
  button. (A hosted version is on the roadmap, but not the focus right
  now.)
- **Not Jira.** No epics, no story points, no swimlane configurations,
  no permissions matrix, no workflow builder. Sprino has tasks, status,
  assignees, and an event log. That's it.
- **Multi-workspace on your own server, not a shared SaaS.** One Sprino
  install can host **several workspaces** (separate teams or divisions)
  with isolated projects and audit data. What you don’t get yet is a
  hosted “Sprino Cloud” where strangers sign up side by side — that’s
  still planned for a later release.
- **Not a finished product.** Pre-alpha. Working code, exercised daily
  by the maintainer, but not battle-tested across hundreds of teams.

## What's new: workspaces and audit logs

**Workspaces** are separate buckets inside your Sprino install — think “two
teams, one server.” Each workspace has its own projects and tasks; the web
UI includes a switcher so you pick which workspace you’re working in before
you create or browse work. People only see what their membership allows.

**Audit export** is for compliance and review: everything that happened in a
workspace can be downloaded as machine-readable output. The HTTP API offers
**JSON** (full event records, including payloads) or a **CSV** snapshot with
the main columns for the append-only trail (ids, times, kinds,
`workspace_id`, etc.). That’s useful for dropping into a spreadsheet,
attaching to a ticket, or feeding offline tools — and you can page through
long histories using `offset` if you hit the per-request row limit.

**Security, in one sentence:** only actors who belong to that workspace can
export its events — the server never trusts “which workspace” from untrusted
query tricks; it always scopes to the workspace the caller is authenticated
into (including the `X-Workspace-ID` header when you use more than one).

## What's the catch?

Honest list:

- It's pre-alpha. Bugs exist. The README and CHANGELOG say what works.
- If you need **hosted** multi-tenant SaaS (tenants you don’t run yourself),
  that’s still on the roadmap — today you self-host and use workspaces
  for team boundaries on your own infrastructure.
- Self-hosted means *you* run it. If your VPS dies, your tasks die
  with it (unless you set up the backup sidecar — which is included
  and tested, but you have to opt in to the `full` profile).
- AGPL license. If you're going to host Sprino as a service for other
  people, AGPL requires you to publish your modifications. Most users
  don't care; some companies do. If you fall in the second bucket,
  email us about a commercial license.

## What changed in v0.0.9

Two things, both about *who can use Sprino*:

**1. You can invite people from inside the app now.** Before v0.0.9,
adding a teammate or an agent meant editing `SPRINO_ACTORS_JSON` in
`.env` and restarting the server. As of v0.0.9 there's a Members tab:
type a name, hit "register," hand the new bearer token to your
teammate. Tokens can be rotated and revoked from the same screen with
no downtime. The plaintext token is shown exactly once — copy it then,
or rotate again.

**2. Your `.env` is your floor: lose the database, recover from `.env`.**
Every actor row carries a `source` flag: either `env` (declared in
`SPRINO_ACTORS_JSON`) or `db` (created in-app). On every server boot,
Sprino reads the env file and imports any new entries — so even if
the database is wiped clean, restarting with a populated `.env` gives
you a working credential again. The reverse case (an attacker revokes
your env credential by writing to the database directly) is recovered
by editing `.env` with a *fresh* token and restarting; Sprino
intentionally refuses to "un-revoke" a previously-revoked token —
re-introducing the same plaintext is treated as a security smell.
`docs/TOKEN-RECOVERY.md` is the full playbook.

## Where to go from here

- **You want to try it:** [README](../README.md) → "Self-host (30 minutes,
  end-to-end)".
- **You want the engineering details:** [`TECHNICAL.md`](./TECHNICAL.md).
- **You want to know what's coming:** [`CHANGELOG.md`](../CHANGELOG.md)
  → "Unreleased".
- **You want to contribute:** [`CONTRIBUTING.md`](../CONTRIBUTING.md).
- **You want to know what the protocol looks like:**
  [Tessera README](https://github.com/leotorrealba/tessera).
