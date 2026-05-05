// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Public heartbeat + internal expiry helpers for agent sessions.
 *
 * B2 stored lifecycle metadata and exposed only the internal
 * `transitionAgentLifecycle()` primitive. B4 keeps the business logic
 * centralized here. `heartbeatAgent()` routes through
 * `transitionAgentLifecycle()` so per-actor invariants (active-only,
 * idempotent deactivate) are enforced in one place.
 *
 * `expireStaleAgents()` intentionally bypasses that per-actor primitive and
 * issues a single bulk SQL UPDATE instead. Per-actor row-locking would be
 * O(n) network round-trips and does not compose well with a background job
 * that may process thousands of stale sessions at once. This deviation from
 * the `transitionAgentLifecycle()` boundary is documented here so it is
 * explicit rather than implicit.
 */

import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { actors } from '../db/schema.ts';
import type { Actor, ActorDeactivateReq, ActorHeartbeatReq } from '../domain/index.ts';
import {
  checkIdempotency,
  hashRequest,
  recordOperation,
} from './idempotency.ts';
import {
  ActorLifecycleTransitionError,
  ActorNotFoundError,
  transitionAgentLifecycle,
} from './actors.ts';

export class AgentHeartbeatForbiddenError extends Error {
  constructor(
    public readonly actorId: string,
    public readonly targetActorId: string,
  ) {
    super('agents may heartbeat only themselves');
    this.name = 'AgentHeartbeatForbiddenError';
  }
}

export class AgentDeactivateForbiddenError extends Error {
  constructor(public readonly actorId: string) {
    super('only human actors may deactivate agent sessions');
    this.name = 'AgentDeactivateForbiddenError';
  }
}

export async function heartbeatAgent(
  db: Db,
  args: {
    req: ActorHeartbeatReq;
    callerId: string;
    now?: Date;
  },
): Promise<{ actor: Actor }> {
  if (args.req.actor_id !== args.callerId) {
    throw new AgentHeartbeatForbiddenError(
      args.callerId,
      args.req.actor_id,
    );
  }

  return transitionAgentLifecycle(db, {
    actorId: args.req.actor_id,
    transition: 'heartbeat',
    now: args.now,
  });
}

export async function deactivateAgent(
  db: Db,
  args: {
    req: ActorDeactivateReq;
    callerId: string;
    callerKind: 'human' | 'agent';
    now?: Date;
  },
): Promise<{ actor: Actor }> {
  if (args.callerKind !== 'human') {
    throw new AgentDeactivateForbiddenError(args.callerId);
  }

  const requestHash = hashRequest(args.req);

  const cached = await checkIdempotency(db, args.req.operation_id, requestHash);
  if (cached) return cached as { actor: Actor };

  // not_found happens BEFORE we open a transaction — we never write an
  // operation row for a failed-precondition (mirrors revokeToken pattern).
  const now = args.now ?? new Date();

  try {
    return await db.transaction(async (tx) => {
      // Row-lock + deactivate in one atomic step — same approach as the
      // heartbeat path in transitionAgentLifecycle, but inlined here so
      // recordOperation can share the same transaction.
      const [locked] = await tx
        .select()
        .from(actors)
        .where(eq(actors.id, args.req.actor_id))
        .for('update')
        .limit(1);
      if (!locked) throw new ActorNotFoundError(args.req.actor_id);

      if (locked.kind !== 'agent') {
        throw new ActorLifecycleTransitionError({
          actorId: args.req.actor_id,
          actorKind: locked.kind,
          transition: 'deactivate',
          code: 'actor_kind_not_agent',
        });
      }

      let actorRow = locked;
      if (locked.lifecycleState === 'active') {
        const [updated] = await tx
          .update(actors)
          .set({ lifecycleState: 'inactive', deactivatedAt: now })
          .where(eq(actors.id, args.req.actor_id))
          .returning();
        actorRow = updated!;
      }

      const result = {
        actor: {
          id: actorRow.id,
          kind: actorRow.kind,
          display_name: actorRow.displayName,
          agent_runtime: actorRow.agentRuntime,
          parent_actor_id: actorRow.parentActorId,
          created_at: actorRow.createdAt.toISOString(),
        } satisfies Actor,
      };

      await recordOperation(tx, {
        operationId: args.req.operation_id,
        actorId: args.callerId,
        requestHash,
        responseBody: result,
      });

      return result;
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

export async function expireStaleAgents(
  db: Db,
  args: {
    cutoff: Date;
    now?: Date;
  },
): Promise<{ expired_count: number; expired_actor_ids: string[] }> {
  const now = args.now ?? new Date();

  const expired = await db
    .update(actors)
    .set({
      lifecycleState: 'inactive',
      deactivatedAt: now,
    })
    .where(
      and(
        eq(actors.kind, 'agent'),
        eq(actors.lifecycleState, 'active'),
        or(
          lt(actors.lastHeartbeatAt, args.cutoff),
          and(
            isNull(actors.lastHeartbeatAt),
            lt(actors.createdAt, args.cutoff),
          ),
        ),
      ),
    )
    .returning({ actorId: actors.id });

  return {
    expired_count: expired.length,
    expired_actor_ids: expired.map((row) => row.actorId),
  };
}
