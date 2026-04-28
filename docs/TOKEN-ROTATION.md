# Rotating Sprino actor tokens

Sprino actors (humans and agents) authenticate to the API and to MCP with
opaque bearer tokens. In the v0.x self-hosted setup, tokens live in the
`SPRINO_ACTORS_JSON` environment variable, loaded from `.env` at server
start. This document is the playbook for replacing one of those tokens.

> **Audience.** Whoever runs the Sprino instance. If you can edit `.env`
> and recreate a Compose service, you can rotate a token.

## Why rotate

Rotate a token when:

- It was committed to git, posted in a chat, pasted into a third-party
  service, or otherwise left a place you control.
- A laptop, server, or session that held it was lost or compromised.
- An agent's runtime is being decommissioned and you want its token to
  stop working immediately.
- A teammate or collaborator is leaving the project.
- You're on a periodic rotation cadence (recommended: every 90 days for
  human tokens, every 30 days for agent tokens that run unattended).

If none of those apply, you don't need to rotate.

## What rotation does (and doesn't)

The actor registry is **loaded into memory once at server startup** and
cached for the life of the process (see
`apps/server/src/auth/registry.ts`). Editing `.env` while the server is
running has no effect — the registry only reloads when the server
restarts.

That has two consequences worth understanding before you start:

1. **A restart is required.** There is no SIGHUP-style reload yet.
2. **Old operations stay valid.** Tokens are an authentication concern,
   not an authorization one — the rotated token can no longer create
   *new* events, but every event that was already written into the log
   under the old token's actor remains attributed to that actor and is
   not retroactively invalidated. This is by design (event logs are
   append-only).

## Step-by-step: rotate one token

You'll need shell access to the host running Sprino, and roughly five
minutes of brief API downtime (the server restart). The web UI itself
keeps serving from nginx during the restart, but `/api/*` and `/mcp/*`
calls will return 502s for ~10 seconds while the server boots.

### 1. Generate a new token

```sh
NEW_TOKEN=$(openssl rand -base64 24 | tr '+/' '-_')
echo "$NEW_TOKEN"
```

This is the same generator `bootstrap.sh` uses: 192 bits of entropy
encoded as 32 base64url characters. Copy the output somewhere you can
paste it (a password manager, ideally).

### 2. Edit `.env`

Open `.env` in an editor. Find the `SPRINO_ACTORS_JSON` line — it's a
single-quoted JSON array, looking roughly like:

```sh
SPRINO_ACTORS_JSON='[{"id":"...","kind":"human","display_name":"Admin","token":"OLD_TOKEN_HERE","agent_runtime":null}]'
```

Replace the `token` value for the actor you're rotating with the new
token from step 1. Leave every other field — `id`, `kind`,
`display_name`, `agent_runtime` — exactly as it was. Save.

> **Tip.** If you have multiple actors and the JSON is hard to read on
> one line, you can use a helper:
>
> ```sh
> # Pretty-print to inspect:
> grep '^SPRINO_ACTORS_JSON' .env | sed "s/^SPRINO_ACTORS_JSON='//;s/'$//" | python3 -m json.tool
> ```
>
> Edit it pretty, then re-flatten back onto one line before pasting back
> into `.env`. The value MUST be on a single line wrapped in single
> quotes — dotenv does not understand multi-line values here.

### 3. Recreate the server container

```sh
docker compose up -d --no-deps --force-recreate server
```

> **Why not `docker compose restart server`?** Compose interpolates
> values from `.env` into a service's environment **at container
> creation time**. `restart` stops and starts the *existing* container
> with its baked-in env vars — so the rotated token in `.env` would be
> ignored. `up -d --force-recreate server` rebuilds the env from the
> current `.env` and swaps the container in place. `--no-deps` keeps
> Postgres and the web container untouched.

The new container re-reads `.env` on boot, so the new token is now
live. Postgres and the web container are not restarted — only the API
service. Wait for the healthcheck to go green:

```sh
docker compose ps server
```

You're looking for `(healthy)` in the STATUS column. This usually takes
10–20 seconds.

### 4. Verify the new token works

```sh
curl -fsS -H "Authorization: Bearer $NEW_TOKEN" \
  http://localhost:3001/healthz
```

A `200 OK` confirms the server is up. To confirm the rotated *actor*
is recognized (not just any token), make an authenticated call against
a real endpoint:

```sh
curl -fsS -H "Authorization: Bearer $NEW_TOKEN" \
  "http://localhost:3001/api/agents"
```

You should get back `200 OK` with a JSON list of agents (possibly
empty). If the Bearer token is present but invalid, the auth middleware
returns `403 invalid_token`; `401` is reserved for a missing or
malformed `Authorization` header (see
`apps/server/src/auth/middleware.ts`).

### 5. Verify the old token is rejected

```sh
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $OLD_TOKEN" \
  http://localhost:3001/api/agents
```

This should print `403` (the auth middleware's `invalid_token`
response). If it prints `200`, the recreate didn't pick up the new
`.env` — repeat step 3. (Note: we drop `-f` here on purpose — `-f`
makes curl exit non-zero on 4xx, which would mask the very behavior
we're checking for.)

### 6. Distribute the new token

Send the new token to whoever uses the actor (the human, or the agent
runtime config). For agents running on the same host, that usually
means updating their MCP client config or environment, then restarting
them.

The old token is dead at this point. Anyone still using it will hit
`403 invalid_token` and need the new one.

## Rotating an agent's token

Same six steps; the only difference is that an agent's runtime config
likely needs updating, not a human's password manager. Common locations
for agent tokens:

- `~/.config/<runtime>/...` — for desktop AI clients
- a CI/CD secret store — for scripted agents
- a separate `.env` — for self-hosted agent runtimes

After step 6, restart the agent so it picks up the new token. If the
agent is invoked as a subprocess per-request (e.g. an MCP client
launched fresh on each tool call), there's nothing to restart — the
next invocation will read the new value automatically.

## Rotating ALL tokens at once (emergency)

If you suspect the entire `.env` was leaked (lost laptop, public git
push), regenerate everything:

```sh
mv .env .env.compromised
sh bootstrap.sh --force
docker compose up -d --no-deps --force-recreate server
```

`bootstrap.sh --force` regenerates every token, the SSE stream secret,
and the project bootstrap UUIDs. Distribute the new tokens (printed at
the end of `bootstrap.sh`) to everyone who needs them. **Securely
destroy `.env.compromised` once you're done** — `shred -u` on Linux,
`rm -P` on macOS.

This is more disruptive than a single-token rotation but is the right
call when you don't know which token leaked.

## Rolling back

If something goes wrong after step 3 (server won't start, all tokens
return 401, etc.), rolling back depends on whether you saved the
previous `.env` before editing. **Always copy `.env` before touching it
for a rotation:**

```sh
cp .env .env.before-rotation
# ... edit ...
# if anything is wrong:
cp .env.before-rotation .env && \
  docker compose up -d --no-deps --force-recreate server
```

For an emergency `bootstrap.sh --force` run, do the same dance: copy
`.env` aside first, since `--force` overwrites it and does not write a
backup of its own.

## Limitations and what's coming

- **No overlap window.** Rotation is atomic — at restart, the old token
  stops working and the new one starts. We don't currently support a
  grace period where both tokens are valid simultaneously. For a
  team-wide rotation that needs zero-downtime, the workaround is to
  add a *new* actor with the new token, migrate clients to it, then
  remove the old actor in a second pass.
- **No audit trail of rotations.** The fact that a token was rotated
  is not itself recorded in the event log. If you need that, log it
  yourself in your ops journal.
- **No SIGHUP / hot reload.** Planned for v0.2 alongside the table-backed
  registry. Until then, restart is required.

If any of these are blockers for you, open an issue describing your
use case so the v0.2 design can address it.
