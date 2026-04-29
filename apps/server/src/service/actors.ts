// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Actor lifecycle service — Tessera v0.1.2 verbs + Sprino-only rotate.
 *
 * Verbs:
 *   actor.register     (humans only in v0.1.2; idempotent via operation_id)
 *   actor.list         (read; optional kind filter)
 *   actor.get          (read by actor_id)
 *   actor.revoke_token (idempotent; flips revoked_at on active tokens)
 *
 * Sprino-only HTTP extensions (NOT part of canonical Tessera):
 *   rotateToken        (revoke + mint atomically; race-safe via partial
 *                       unique index on actor_tokens(actor_id) WHERE
 *                       revoked_at IS NULL)
 *
 * Architectural rules (locked):
 *   1. Idempotency, redaction, and event/operation writes happen here, ONCE.
 *      Adapters parse → call → translate errors. Nothing else.
 *   2. operations.response_body MUST NOT contain the plaintext token —
 *      replay returns the redacted shape and the conflict path returns
 *      the redacted cached body. The token is held in a local variable
 *      and returned out-of-band on first call only.
 *   3. Single transaction wraps actor row + actor_tokens row + operations
 *      row for register; revoke wraps row-lock + token revoke + operation.
 *
 * Errors (translated to HTTP / JSON-RPC at the adapter layer):
 *   ActorNotFoundError          → 404 not_found
 *   LastAdminProtectedError     → 409 last_admin_protected
 *   EnvActorImmutableError      → 400 operation_unsupported
 *   ConcurrentRotationError     → 409 concurrent_rotation
 *   ActorValidationError        → 400 validation_error (with field/reason)
 */

import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '../db/client.ts';
import { actors, actorTokens } from '../db/schema.ts';
import type { ActorRow } from '../db/schema.ts';
import { hashToken } from '../auth/registry.ts';
import {
  type Actor,
  type ActorGetReq,
  type ActorListReq,
  type ActorRegisterReq,
  type ActorRevokeTokenReq,
} from '../domain/index.ts';
import {
  checkIdempotency,
  hashRequest,
  recordOperation,
} from './idempotency.ts';
import { assertCanManageActors } from './authorization.ts';

// ────────────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────────────

export class ActorNotFoundError extends Error {
  constructor(public readonly actorId: string) {
    super(`actor ${actorId} not found`);
    this.name = 'ActorNotFoundError';
  }
}

export class LastAdminProtectedError extends Error {
  constructor(public readonly actorId: string) {
    super('refusing to revoke the last active human credential');
    this.name = 'LastAdminProtectedError';
  }
}

export class EnvActorImmutableError extends Error {
  constructor(public readonly actorId: string) {
    super(
      `actor ${actorId} is sourced from SPRINO_ACTORS_JSON; recover via .env, not the API`,
    );
    this.name = 'EnvActorImmutableError';
  }
}

export class ConcurrentRotationError extends Error {
  constructor(public readonly actorId: string) {
    super(`concurrent rotate_token detected for actor ${actorId}`);
    this.name = 'ConcurrentRotationError';
  }
}

export class ActorValidationError extends Error {
  constructor(
    public readonly field: string,
    public readonly reason: string,
  ) {
    super(`validation failed: ${field}: ${reason}`);
    this.name = 'ActorValidationError';
  }
}

// ────────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────────

/**
 * 24 random bytes → base64url. 192 bits of entropy is enough that we
 * don't need a server-side pepper: brute-forcing a sha256 with that
 * input space is ~2^192 hashes regardless of GPU rig. See TECHNICAL.md
 * §Token format for the full reasoning.
 */
function mintToken(): string {
  return randomBytes(24).toString('base64url');
}

function rowToActor(r: ActorRow): Actor {
  return {
    id: r.id,
    kind: r.kind,
    display_name: r.displayName,
    agent_runtime: r.agentRuntime,
    parent_actor_id: r.parentActorId,
    created_at: r.createdAt.toISOString(),
  };
}

async function fetchActorRow(
  db: Db,
  actorId: string,
): Promise<ActorRow | undefined> {
  const rows = await db
    .select()
    .from(actors)
    .where(eq(actors.id, actorId))
    .limit(1);
  return rows[0];
}

async function assertCallerCanManageActors(
  db: Db,
  callerId: string,
): Promise<void> {
  const caller = await fetchActorRow(db, callerId);
  if (!caller) throw new ActorNotFoundError(callerId);
  assertCanManageActors({
    id: caller.id,
    kind: caller.kind,
    role: caller.role,
  });
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown };
  return e.code === '23505';
}

// ────────────────────────────────────────────────────────────────────────
// register
// ────────────────────────────────────────────────────────────────────────

export interface ActorRegisterFirstResponse {
  actor: Actor;
  token: string;
}
export interface ActorRegisterReplayResponse {
  actor: Actor;
}
export type ActorRegisterResponse =
  | ActorRegisterFirstResponse
  | ActorRegisterReplayResponse;

/**
 * Mint a new human actor and return the plaintext credential exactly once.
 *
 * Idempotency redaction (load-bearing — see actor-register-operation-replay
 * fixture in tessera/conformance/):
 *   - First call:  persist {actor} into operations.response_body. Return
 *                  {actor, token} to the caller from local memory.
 *   - Replay:      return the cached {actor} — no `token` field.
 *   - Conflict (same op_id, different payload): bubble up the cached
 *     {actor} via IdempotencyConflictError; the adapter renders 409
 *     with cached_response: {actor}, never with a token.
 */
export async function registerActor(
  db: Db,
  args: { req: ActorRegisterReq; callerId: string },
): Promise<ActorRegisterResponse> {
  await assertCallerCanManageActors(db, args.callerId);

  // v0.1.2 humans-only. Zod already enforces this; defensive guard so a
  // stray adapter that forgot to validate can't slip an agent past us.
  if (args.req.kind !== 'human') {
    throw new ActorValidationError(
      'kind',
      'Only `human` is accepted in v0.1.2.',
    );
  }

  const requestHash = hashRequest(args.req);

  const cached = await checkIdempotency(
    db,
    args.req.operation_id,
    requestHash,
  );
  if (cached) return cached as ActorRegisterReplayResponse;

  const token = mintToken();
  const tokenHash = hashToken(token);
  const actorId = uuidv7();
  const now = new Date();

  try {
    return await db.transaction(async (tx) => {
      const [actorRow] = await tx
        .insert(actors)
        .values({
          id: actorId,
          kind: 'human',
          displayName: args.req.display_name,
          agentRuntime: null,
          parentActorId: null,
          source: 'db',
          createdAt: now,
        })
        .returning();

      await tx.insert(actorTokens).values({
        id: uuidv7(),
        actorId,
        tokenHash,
        source: 'db',
        createdAt: now,
      });

      const actor = rowToActor(actorRow!);
      // REDACTED — operations.response_body must never carry the
      // plaintext credential.
      const redactedResponse: ActorRegisterReplayResponse = { actor };

      await recordOperation(tx, {
        operationId: args.req.operation_id,
        actorId: args.callerId,
        requestHash,
        responseBody: redactedResponse,
      });

      return { actor, token };
    });
  } catch (err) {
    // Lost a concurrent insert race on operation_id; reread the cached
    // (redacted) response so the second caller still gets a reasonable
    // shape and we don't accidentally leak by retrying the mint.
    const raced = await checkIdempotency(
      db,
      args.req.operation_id,
      requestHash,
    );
    if (raced) return raced as ActorRegisterReplayResponse;
    throw err;
  }
}

// ────────────────────────────────────────────────────────────────────────
// list / get
// ────────────────────────────────────────────────────────────────────────

export async function listActors(
  db: Db,
  args: { req: ActorListReq },
): Promise<{ actors: Actor[] }> {
  // Order pushed into SQL so we don't fetch-and-sort the whole table in
  // memory once it grows. Stable order keeps test fixtures and the
  // Members UI consistent across calls.
  const rows = await (args.req.kind
    ? db
        .select()
        .from(actors)
        .where(eq(actors.kind, args.req.kind))
        .orderBy(asc(actors.id))
    : db.select().from(actors).orderBy(asc(actors.id)));
  return { actors: rows.map(rowToActor) };
}

export async function getActor(
  db: Db,
  args: { req: ActorGetReq },
): Promise<{ actor: Actor }> {
  const row = await fetchActorRow(db, args.req.actor_id);
  if (!row) throw new ActorNotFoundError(args.req.actor_id);
  return { actor: rowToActor(row) };
}

// ────────────────────────────────────────────────────────────────────────
// listMembers — Sprino-internal, not Tessera
// ────────────────────────────────────────────────────────────────────────

/**
 * Members API (Sprino-internal): returns Actor + provenance + revocation
 * status enriched from `actor_tokens`. Used by the web Members UI to
 * distinguish env-source rows (which the UI must NOT offer rotate/revoke
 * for — recovery is "edit .env and restart") from db-source rows, and to
 * render an "active vs revoked" badge.
 *
 * NOT exposed via MCP — the Tessera `actor.list` verb returns the bare
 * canonical `Actor` shape and stays in lockstep with the protocol spec.
 * Adding `source` / `revoked_at` to the Tessera shape would force every
 * other implementer to surface them too, which isn't justified by the
 * spec. Keep it Sprino-only.
 */
export type Member = Actor & {
  source: 'env' | 'db';
  // ISO8601 timestamp of the most-recent revocation if the actor has zero
  // active tokens; null while at least one token is active. Computed from
  // actor_tokens, not from a column on actors.
  revoked_at: string | null;
};

export async function listMembers(
  db: Db,
  args: { req: ActorListReq },
): Promise<{ actors: Member[] }> {
  const actorRows = await (args.req.kind
    ? db
        .select()
        .from(actors)
        .where(eq(actors.kind, args.req.kind))
        .orderBy(asc(actors.id))
    : db.select().from(actors).orderBy(asc(actors.id)));
  if (actorRows.length === 0) return { actors: [] };

  const actorIds = actorRows.map((r) => r.id);
  const tokenRows = await db
    .select({
      actorId: actorTokens.actorId,
      revokedAt: actorTokens.revokedAt,
      createdAt: actorTokens.createdAt,
    })
    .from(actorTokens)
    .where(inArray(actorTokens.actorId, actorIds));

  // For each actor: revoked_at = null if any active token exists; else the
  // most recent revoked_at (so the UI can show *when* the last credential
  // was revoked). Single pass, O(tokens) — no extra round-trip per actor.
  const statusByActor = new Map<string, string | null>();
  for (const t of tokenRows) {
    const cur = statusByActor.get(t.actorId);
    if (t.revokedAt === null) {
      statusByActor.set(t.actorId, null);
      continue;
    }
    if (cur === null) continue;
    const candidate = t.revokedAt.toISOString();
    if (cur === undefined || candidate > cur) {
      statusByActor.set(t.actorId, candidate);
    }
  }

  return {
    actors: actorRows.map((r) => ({
      ...rowToActor(r),
      source: r.source as 'env' | 'db',
      revoked_at: statusByActor.has(r.id)
        ? (statusByActor.get(r.id) ?? null)
        : // No tokens at all → treat as revoked at the actor's createdAt
          // so the UI doesn't render "active" for a credential-less row.
          r.createdAt.toISOString(),
    })),
  };
}

// ────────────────────────────────────────────────────────────────────────
// revoke_token
// ────────────────────────────────────────────────────────────────────────

/**
 * Domain-level idempotent revoke. A second call against an actor with no
 * active tokens still returns {actor} with no error and writes a new
 * operation row (different operation_id; the same operation_id replays
 * via checkIdempotency before we ever reach the body of this function).
 *
 * Last-admin guard: if revoking would leave zero humans with active
 * credentials in the system, throw LastAdminProtectedError. Computed
 * inside the transaction while locking the full active-human set in
 * stable id order so concurrent revokes cannot both observe "another
 * human still exists" and drop the system to zero.
 */
export async function revokeToken(
  db: Db,
  args: { req: ActorRevokeTokenReq; callerId: string },
): Promise<{ actor: Actor }> {
  await assertCallerCanManageActors(db, args.callerId);

  const requestHash = hashRequest(args.req);

  const cached = await checkIdempotency(
    db,
    args.req.operation_id,
    requestHash,
  );
  if (cached) return cached as { actor: Actor };

  // not_found + env-immutable both happen BEFORE we open a transaction,
  // so we never write an operation row for a failed precondition.
  const pre = await fetchActorRow(db, args.req.actor_id);
  if (!pre) throw new ActorNotFoundError(args.req.actor_id);
  if (pre.source === 'env') {
    throw new EnvActorImmutableError(args.req.actor_id);
  }

  try {
    return await db.transaction(async (tx) => {
      let activeIds: string[] = [];
      if (pre.kind === 'human') {
        const activeHumans = await tx
          .select({ actorId: actors.id })
          .from(actors)
          .innerJoin(actorTokens, eq(actorTokens.actorId, actors.id))
          .where(
            and(
              eq(actors.kind, 'human'),
              isNull(actorTokens.revokedAt),
            ),
          )
          .orderBy(asc(actors.id))
          .for('update');
        activeIds = activeHumans.map((row) => row.actorId);
      }

      const [locked] = await tx
        .select()
        .from(actors)
        .where(eq(actors.id, args.req.actor_id))
        .for('update');
      if (!locked) throw new ActorNotFoundError(args.req.actor_id);

      // Last-admin guard: the active human actor-set was locked above in
      // stable order. That prevents two concurrent revokes from both
      // observing a non-zero "other human" count and committing.
      if (locked.kind === 'human') {
        if (
          activeIds.includes(args.req.actor_id) &&
          activeIds.filter((id) => id !== args.req.actor_id).length === 0
        ) {
          throw new LastAdminProtectedError(args.req.actor_id);
        }
      }

      await tx
        .update(actorTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(actorTokens.actorId, args.req.actor_id),
            isNull(actorTokens.revokedAt),
          ),
        );

      const response = { actor: rowToActor(locked) };
      await recordOperation(tx, {
        operationId: args.req.operation_id,
        actorId: args.callerId,
        requestHash,
        responseBody: response,
      });
      return response;
    });
  } catch (err) {
    const raced = await checkIdempotency(
      db,
      args.req.operation_id,
      requestHash,
    );
    if (raced) return raced as { actor: Actor };
    throw err;
  }
}

// ────────────────────────────────────────────────────────────────────────
// rotate_token (Sprino-only HTTP)
// ────────────────────────────────────────────────────────────────────────

/**
 * Revoke all active tokens for an actor and mint a fresh one. NOT a
 * Tessera verb — exposed only over /api/actors/:id/rotate_token. No
 * idempotency: the operator is expected to re-call only on explicit
 * "yes I lost the previous token" intent.
 *
 * Race-safety: the partial unique index on
 *   actor_tokens (actor_id) WHERE revoked_at IS NULL
 * is the hard guarantee. Two concurrent rotates serialize on the
 * matched-token row lock during UPDATE; the loser sees the updated
 * row, can't revoke it again, and its INSERT collides with the new
 * row from the winner, surfacing as ConcurrentRotationError.
 */
export async function rotateToken(
  db: Db,
  args: { actorId: string; callerId: string },
): Promise<{ actor: Actor; token: string }> {
  await assertCallerCanManageActors(db, args.callerId);

  const pre = await fetchActorRow(db, args.actorId);
  if (!pre) throw new ActorNotFoundError(args.actorId);
  if (pre.source === 'env') {
    throw new EnvActorImmutableError(args.actorId);
  }

  // Snapshot active token ids BEFORE the transaction. Two concurrent
  // rotates therefore start from the same view of "active". Inside the
  // transaction we revoke that exact id-set: tx1 wins, tx2 blocks on the
  // row lock, then re-evaluates and finds rowCount=0 (the row is now
  // revoked) — which we surface as ConcurrentRotationError. The partial
  // unique index on (actor_id) WHERE revoked_at IS NULL is the backstop
  // for the equally-pathological "both UPDATEs see zero" case.
  const activeBefore = await db
    .select({ id: actorTokens.id })
    .from(actorTokens)
    .where(
      and(
        eq(actorTokens.actorId, args.actorId),
        isNull(actorTokens.revokedAt),
      ),
    );
  const activeIds = activeBefore.map((r) => r.id);

  const newToken = mintToken();
  const newTokenHash = hashToken(newToken);

  try {
    return await db.transaction(async (tx) => {
      if (activeIds.length > 0) {
        const revokedRows = await tx
          .update(actorTokens)
          .set({ revokedAt: new Date() })
          .where(
            and(
              inArray(actorTokens.id, activeIds),
              isNull(actorTokens.revokedAt),
            ),
          )
          .returning({ id: actorTokens.id });
        if (revokedRows.length !== activeIds.length) {
          throw new ConcurrentRotationError(args.actorId);
        }
      }
      await tx.insert(actorTokens).values({
        id: uuidv7(),
        actorId: args.actorId,
        tokenHash: newTokenHash,
        source: 'db',
      });
      const refreshed = await fetchActorRow(tx as unknown as Db, args.actorId);
      return { actor: rowToActor(refreshed!), token: newToken };
    });
  } catch (err) {
    if (err instanceof ConcurrentRotationError) throw err;
    if (isUniqueViolation(err)) {
      throw new ConcurrentRotationError(args.actorId);
    }
    throw err;
  }
}
