// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Public heartbeat + internal expiry helpers for agent sessions.
 *
 * B2 stored lifecycle metadata and exposed only the internal
 * `transitionAgentLifecycle()` primitive. B4 keeps the business logic
 * centralized by layering the public self-heartbeat rule and the stale
 * session cleanup scan on top of that primitive.
 */

import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { actors } from '../db/schema.ts';
import type { Actor, ActorHeartbeatReq } from '../domain/index.ts';
import { transitionAgentLifecycle } from './actors.ts';

export class AgentHeartbeatForbiddenError extends Error {
  constructor(
    public readonly actorId: string,
    public readonly targetActorId: string,
  ) {
    super('agents may heartbeat only themselves');
    this.name = 'AgentHeartbeatForbiddenError';
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
