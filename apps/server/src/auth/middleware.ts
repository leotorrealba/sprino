// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Hono middleware: extracts Bearer token, looks up actor, attaches to context.
 *
 * Both /api/* and /mcp/* mount this. After this runs, downstream handlers
 * read the authenticated actor via c.get('actor').
 */

import type { MiddlewareHandler } from 'hono';
import type { ActorEntry } from './registry.ts';
import { lookupActorByToken } from './registry.ts';

export type AuthVars = {
  actor: ActorEntry;
};

export const tokenAuth: MiddlewareHandler<{ Variables: AuthVars }> = async (
  c,
  next,
) => {
  const auth = c.req.header('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) {
    return c.json({ error: 'missing_or_malformed_authorization' }, 401);
  }
  const actor = lookupActorByToken(m[1]!);
  if (!actor) {
    return c.json({ error: 'invalid_token' }, 403);
  }
  c.set('actor', actor);
  await next();
};
