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
- **Not multi-tenant yet.** One Sprino install = one team. Multi-team
  cloud is planned for v0.2.
- **Not a finished product.** Pre-alpha. Working code, exercised daily
  by the maintainer, but not battle-tested across hundreds of teams.

## What's the catch?

Honest list:

- It's pre-alpha. Bugs exist. The README and CHANGELOG say what works.
- Single-tenant only right now. If you need multi-team isolation,
  wait for v0.2.
- Self-hosted means *you* run it. If your VPS dies, your tasks die
  with it (unless you set up the backup sidecar — which is included
  and tested, but you have to opt in to the `full` profile).
- AGPL license. If you're going to host Sprino as a service for other
  people, AGPL requires you to publish your modifications. Most users
  don't care; some companies do. If you fall in the second bucket,
  email us about a commercial license.

## Where to go from here

- **You want to try it:** [README](../README.md) → "Self-host (30 minutes,
  end-to-end)".
- **You want the engineering details:** [`TECHNICAL.md`](./TECHNICAL.md).
- **You want to know what's coming:** [`CHANGELOG.md`](../CHANGELOG.md)
  → "Unreleased".
- **You want to contribute:** [`CONTRIBUTING.md`](../CONTRIBUTING.md).
- **You want to know what the protocol looks like:**
  [Tessera README](https://github.com/leotorrealba/tessera).
