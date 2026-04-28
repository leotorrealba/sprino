# Token recovery — getting back in when things break

This document is the break-glass playbook for the Sprino actor system,
introduced in v0.0.9. If you can read this and you can edit `.env` on
the server host, you can always recover access — even if every token
in the database is gone.

## The two-source model in one paragraph

Every actor has a `source`: `env` or `db`.

- **`env`** actors come from `SPRINO_ACTORS_JSON`. On every server boot,
  Sprino reconciles that env into the database: it inserts any new env
  actors and **un-revokes any of their tokens that were revoked**, so an
  attacker with database access cannot lock you out by flipping bits.
  The reconciler is `seedFromEnv()` in `apps/server/src/db/seed.ts`.
- **`db`** actors are everything created at runtime through the Members
  UI or `actor.register`. Their tokens are rotated/revoked through the
  app — restarts do not affect them.

This split exists so the **database is mutable** (you want to invite
people without redeploying) but **the env file is the source of truth
for "who can always get in"** (you want a guaranteed recovery path that
doesn't depend on database state).

## Scenarios

### "I lost my token"

- **db-source actor:** ask any active admin to open the Members tab and
  hit **rotate** for your row. They get a one-time-reveal dialog with
  the new token; they hand it to you over a secure channel.
- **env-source actor:** edit `SPRINO_ACTORS_JSON` in `.env`, replace the
  `token` field for your entry with a new ≥8-char value (we suggest
  `openssl rand -base64 24`), `docker compose up -d --force-recreate
  server`. The new token works immediately; the old one is dead.

### "Every admin's token is lost or revoked"

This is what env-source actors are for. Add (or restore) an env entry
with `kind: "human"` and any token you control:

```json
SPRINO_ACTORS_JSON='[{"id":"...","kind":"human","display_name":"Recovery","token":"<fresh-secret>"}]'
```

Restart the server. `seedFromEnv()` will:

1. Insert the actor row if missing.
2. Insert (or un-revoke) its `actor_tokens` row.

You are back in. Use the Members UI to mint new db-source admins, then
remove the recovery actor from `.env` and restart again if you want.

### "An attacker got database write access"

The env reconciler defends against the obvious attack — flipping
`actor_tokens.revoked_at` for env actors to lock the operator out.
On the next restart, env-source rows are unconditionally re-activated.

The reconciler does **not** defend against attackers who can both write
the database **and** read your `.env`. Treat `.env` like a private key.

### "I want to retire an env-source actor permanently"

Remove its entry from `SPRINO_ACTORS_JSON` and restart. The reconciler
does not delete actors that disappear from the env (so audit history
stays intact), but with no token in the env, the row will simply have
no active token — and because it's `source: 'env'`, the UI won't let
anyone mint a new one. The actor is functionally inert.

If you want it fully gone, delete the row directly from the database
(`DELETE FROM actors WHERE id = ...`) after removing the env entry.

## What gets stored where

- **Plaintext token:** never stored. Only ever returned in the response
  to `actor.register` / `rotate_token`, and shown once in the UI.
- **`actor_tokens.token_hash`:** `sha256(plaintext)` (hex). This is
  what bearer middleware looks up.
- **`actor_tokens.source`:** `env` or `db`. Drives the reconciler and
  the UI's "edit .env to rotate" hint.
- **`actor_tokens` partial unique index:** `(actor_id) WHERE revoked_at
  IS NULL`. Postgres enforces "at most one active token per actor",
  even under concurrent rotate races (see `docs/TECHNICAL.md`).

## When in doubt

The env file is the floor. If you can edit it and restart the server,
you can always get in. That's the property worth protecting.
