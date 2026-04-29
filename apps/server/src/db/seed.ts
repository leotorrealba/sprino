// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Boot-time seed: import SPRINO_ACTORS_JSON entries into the DB.
 *
 * Idempotent. Safe to run on every boot — operators editing .env and
 * restarting is the supported recovery path for lost env credentials.
 *
 * Behavior:
 *   - UPSERT each env actor as `source='env'`. Existing actor with the
 *     same id keeps its current row unless the operator explicitly sets
 *     a different internal role in `SPRINO_ACTORS_JSON`.
 *   - For each env entry, ensure exactly one active token exists in
 *     actor_tokens. If the env token's hash is already present and not
 *     revoked, do nothing. Otherwise insert it (and the partial unique
 *     index guarantees at most one active row per actor).
 *   - Removed env entries: any env-source token whose hash is no longer
 *     in the env list is marked revoked_at=now(). We never DELETE rows
 *     so the audit trail stays intact.
 *
 * Out of scope:
 *   - Project seeding stays in migrate.ts. This module only owns actors
 *     + actor_tokens.
 */

import { and, eq, isNull, notInArray } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from './client.ts';
import { actors, actorTokens } from './schema.ts';
import { hashToken, parseActorsEnv } from '../auth/registry.ts';

export interface SeedResult {
  importedActors: number;
  newTokens: number;
  revokedRemoved: number;
}

/**
 * Reconcile env actors + tokens with the database. See module header.
 */
export async function seedFromEnv(
  db: Db,
  rawEnv: string | undefined = process.env.SPRINO_ACTORS_JSON,
): Promise<SeedResult> {
  const entries = parseActorsEnv(rawEnv);

  let importedActors = 0;
  let newTokens = 0;
  let revokedRemoved = 0;

  // We intentionally do NOT wrap this in a single transaction. seedFromEnv
  // runs at boot when nothing else is touching these rows; per-entry
  // upserts are simpler and the operations are individually idempotent.
  for (const e of entries) {
    await db
      .insert(actors)
      .values({
        id: e.id,
        kind: e.kind,
        role: e.role ?? 'admin',
        displayName: e.display_name,
        agentRuntime: e.agent_runtime ?? null,
        parentActorId: e.parent_actor_id ?? null,
        source: 'env',
      })
      .onConflictDoUpdate({
        target: actors.id,
        set: {
          // Re-affirm env provenance on every boot. If an operator
          // accidentally created a 'db' actor with the same id (shouldn't
          // happen — uuids are 128-bit) we'd flip them back to env, but
          // we'd never zero out createdAt because we don't set it.
          source: 'env',
          kind: e.kind,
          role: e.role ?? 'admin',
          displayName: e.display_name,
          agentRuntime: e.agent_runtime ?? null,
          parentActorId: e.parent_actor_id ?? null,
        },
      });
    importedActors += 1;

    const tokenHash = hashToken(e.token);

    // Ensure exactly one active env token for this actor with this hash.
    const existing = await db
      .select({ id: actorTokens.id, revokedAt: actorTokens.revokedAt })
      .from(actorTokens)
      .where(eq(actorTokens.tokenHash, tokenHash))
      .limit(1);

    const present = existing[0];
    if (!present) {
      // Revoke any other active tokens for this actor — env entry's
      // current token is the source of truth.
      await db
        .update(actorTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(actorTokens.actorId, e.id),
            isNull(actorTokens.revokedAt),
          ),
        );
      await db.insert(actorTokens).values({
        id: uuidv7(),
        actorId: e.id,
        tokenHash,
        source: 'env',
      });
      newTokens += 1;
    } else if (present.revokedAt !== null) {
      // Operator un-revoked an env token by re-adding it. Surface a
      // hard error: re-using a previously-revoked token is a security
      // smell and we want the operator to mint a fresh one.
      throw new Error(
        `SPRINO_ACTORS_JSON token for actor ${e.id} matches a previously-revoked credential. Generate a fresh token instead of reusing.`,
      );
    }
    // else: token already present and active — nothing to do.
  }

  // Revoke env-source tokens that no longer correspond to any env entry.
  // We compare on token_hash because that's the only env-stable key
  // (actor ids alone aren't enough — same actor with rotated env token
  // should revoke the old one).
  const envHashes = entries.map((e) => hashToken(e.token));
  if (envHashes.length === 0) {
    // No env entries left — revoke ALL active env-source tokens.
    const revoked = await db
      .update(actorTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(actorTokens.source, 'env'),
          isNull(actorTokens.revokedAt),
        ),
      )
      .returning({ id: actorTokens.id });
    revokedRemoved = revoked.length;
  } else {
    const revoked = await db
      .update(actorTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(actorTokens.source, 'env'),
          isNull(actorTokens.revokedAt),
          notInArray(actorTokens.tokenHash, envHashes),
        ),
      )
      .returning({ id: actorTokens.id });
    revokedRemoved = revoked.length;
  }

  return { importedActors, newTokens, revokedRemoved };
}
