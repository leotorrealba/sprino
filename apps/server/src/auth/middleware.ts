// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
import type { MiddlewareHandler } from 'hono';
import type { Db } from '../db/client.ts';
import type { ActorEntry } from './registry.ts';
import { lookupActorByToken } from './registry.ts';
import {
  resolveWorkspaceById,
  resolveWorkspaceForActor,
} from '../service/workspaces.ts';

export type WorkspaceEntry = {
  id: string;
  name: string;
  slug: string;
  role: 'admin' | 'member';
};

export type AuthVars = {
  actor: ActorEntry;
  db: Db;
  workspace?: WorkspaceEntry;
};

export type AuthEnv = {
  Variables: AuthVars;
};

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

/**
 * Resolve workspace from X-Workspace-ID header or auto-select when the
 * actor belongs to exactly one workspace. Must run AFTER tokenAuth.
 *
 * On success, sets c.var.workspace.
 * If header present but actor is not a member → 403.
 * If header absent and actor has 0 or 2+ workspaces → 400 workspace_id_required.
 */
export const workspaceAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const db = c.get('db');
  const actor = c.get('actor');
  const headerWsId = c.req.header('x-workspace-id');

  if (headerWsId) {
    const resolved = await resolveWorkspaceById(db, {
      workspaceId: headerWsId,
      actorId: actor.id,
    });
    if (!resolved) {
      return c.json({ error: 'workspace_not_found_or_not_member' }, 403);
    }
    c.set('workspace', {
      id: resolved.workspaceId,
      name: resolved.name,
      slug: resolved.slug,
      role: resolved.role,
    });
    return next();
  }

  // No header — try auto-select
  const resolution = await resolveWorkspaceForActor(db, actor.id);
  if (resolution.kind === 'resolved') {
    // Fetch workspace name/slug for context
    const resolved = await resolveWorkspaceById(db, {
      workspaceId: resolution.workspaceId,
      actorId: actor.id,
    });
    if (resolved) {
      c.set('workspace', {
        id: resolved.workspaceId,
        name: resolved.name,
        slug: resolved.slug,
        role: resolved.role,
      });
    }
    return next();
  }

  return c.json({ error: 'workspace_id_required' }, 400);
};
