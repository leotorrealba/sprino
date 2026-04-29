// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Hono middleware: extracts Bearer token, looks up actor, attaches to context.
 *
 * Both /api/* and /mcp/* mount this. After this runs, downstream handlers
 * read the authenticated actor via c.get('actor').
 */

import type { MiddlewareHandler } from 'hono';
import type { Db } from '../db/client.ts';
import type { ActorEntry } from './registry.ts';
import { lookupActorByToken } from './registry.ts';

export type AuthVars = {
  actor: ActorEntry;
  db: Db;
};

export type AuthEnv = {
  Variables: AuthVars;
};

/**
 * Bearer-token middleware. Resolves to an actor via the unified DB path —
 * env-seeded credentials and runtime-minted credentials both live in
 * actor_tokens. Revoke is effective on the next request; no env reload
 * needed. See auth/registry.ts for the full design rationale.
 */
export const tokenAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const auth = c.req.header('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) {
    return c.json({ error: 'missing_or_malformed_authorization' }, 401);
  }
  const actor = await lookupActorByToken(c.get('db'), m[1]!);
  if (!actor) {
    return c.json({ error: 'invalid_token' }, 403);
  }
  c.set('actor', actor);
  await next();
};
