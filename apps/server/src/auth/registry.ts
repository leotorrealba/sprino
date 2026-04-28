// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * DB-backed actor registry. v0.0.9 unifies env-seeded credentials and
 * runtime-minted credentials behind ONE auth path:
 *
 *   bearer  ──sha256──►  actor_tokens.token_hash
 *                         JOIN actors ON actor_id
 *                         WHERE revoked_at IS NULL
 *
 * `loadActorRegistry`/`lookupActorById`/`lookupActorByToken` previously
 * returned cached results from a Map populated at boot. They now query
 * Postgres on every call. The cost is one indexed lookup per request
 * (≪1ms on a warm pool); the win is no env/DB drift, and revoke being
 * effective immediately without a restart.
 *
 * Env tokens are imported into actor_tokens at boot via seed.ts —
 * they live in this table with `source='env'`. The auth code path
 * does not care about the source; that field is metadata for the
 * Members UI to render "env-seeded — recover via .env" badges.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import { actors, actorTokens } from '../db/schema.ts';

// ────────────────────────────────────────────────────────────────────────
// Wire shapes
// ────────────────────────────────────────────────────────────────────────

/**
 * Runtime view of an actor as seen by adapters and handlers — never
 * carries plaintext tokens. Mirrors the previous in-memory shape so
 * existing call sites compile unchanged.
 */
export interface ActorEntry {
  id: string;
  kind: 'human' | 'agent';
  display_name: string;
  agent_runtime: string | null;
  parent_actor_id: string | null;
  source: 'env' | 'db';
}

/**
 * Boot-time env entry shape — what the operator hand-writes in
 * SPRINO_ACTORS_JSON. Only `seed.ts` consumes this. The fields are
 * a superset of ActorEntry because env entries also carry a plaintext
 * `token` that we hash on import and then forget.
 */
const ActorEnvEntrySchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['human', 'agent']),
  display_name: z.string().min(1),
  token: z.string().min(8),
  agent_runtime: z.string().nullable().optional(),
  parent_actor_id: z.string().uuid().nullable().optional(),
});
export type ActorEnvEntry = z.infer<typeof ActorEnvEntrySchema>;

// ────────────────────────────────────────────────────────────────────────
// Token hashing
// ────────────────────────────────────────────────────────────────────────

/**
 * sha256(plaintext). 192-bit base64url tokens (24 bytes) make a peppered
 * HMAC unnecessary — see TECHNICAL.md §Token format.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

// ────────────────────────────────────────────────────────────────────────
// Env parsing — boot-time only
// ────────────────────────────────────────────────────────────────────────

/**
 * Parse and validate SPRINO_ACTORS_JSON. Throws on malformed JSON,
 * schema violations, or duplicate ids/tokens.
 *
 * Returns [] when the env var is unset — at v0.0.9 a deployment can run
 * with zero env actors and mint humans via actor.register at runtime.
 * Boot fails later (in seed) only if zero active credentials exist
 * AFTER the import.
 */
export function parseActorsEnv(raw: string | undefined): ActorEnvEntry[] {
  if (!raw) return [];
  const parsed = z.array(ActorEnvEntrySchema).parse(JSON.parse(raw));
  const seenIds = new Set<string>();
  const seenTokens = new Set<string>();
  for (const a of parsed) {
    if (seenIds.has(a.id)) {
      throw new Error(`Duplicate actor id detected: ${a.id}`);
    }
    if (seenTokens.has(a.token)) {
      throw new Error(`Duplicate token detected for actor ${a.id}`);
    }
    seenIds.add(a.id);
    seenTokens.add(a.token);
  }
  return parsed;
}

// ────────────────────────────────────────────────────────────────────────
// Runtime DB lookups — used by tokenAuth and SSE
// ────────────────────────────────────────────────────────────────────────

/**
 * Resolve a Bearer token to an actor. Returns undefined for unknown or
 * revoked tokens — middleware translates that to 403.
 *
 * Single SQL: actor_tokens JOIN actors WHERE token_hash = $1 AND
 * revoked_at IS NULL. The partial unique index on (actor_id) WHERE
 * revoked_at IS NULL guarantees that even mid-rotate we see at most
 * one row per actor, so the implicit "first row wins" is safe.
 */
export async function lookupActorByToken(
  db: Db,
  token: string,
): Promise<ActorEntry | undefined> {
  const tokenHash = hashToken(token);
  const rows = await db
    .select({
      id: actors.id,
      kind: actors.kind,
      displayName: actors.displayName,
      agentRuntime: actors.agentRuntime,
      parentActorId: actors.parentActorId,
      source: actors.source,
    })
    .from(actorTokens)
    .innerJoin(actors, eq(actorTokens.actorId, actors.id))
    .where(
      and(
        eq(actorTokens.tokenHash, tokenHash),
        isNull(actorTokens.revokedAt),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return {
    id: row.id,
    kind: row.kind,
    display_name: row.displayName,
    agent_runtime: row.agentRuntime,
    parent_actor_id: row.parentActorId,
    source: row.source as 'env' | 'db',
  };
}

/**
 * Look up an actor by id. Used by SSE to verify the ticket-bound actor
 * still exists (Codex finding 2: previously env-only; now hits the DB so
 * actor.register-minted humans can stream events too).
 */
export async function lookupActorById(
  db: Db,
  id: string,
): Promise<ActorEntry | undefined> {
  const rows = await db
    .select({
      id: actors.id,
      kind: actors.kind,
      displayName: actors.displayName,
      agentRuntime: actors.agentRuntime,
      parentActorId: actors.parentActorId,
      source: actors.source,
    })
    .from(actors)
    .where(eq(actors.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return {
    id: row.id,
    kind: row.kind,
    display_name: row.displayName,
    agent_runtime: row.agentRuntime,
    parent_actor_id: row.parentActorId,
    source: row.source as 'env' | 'db',
  };
}
