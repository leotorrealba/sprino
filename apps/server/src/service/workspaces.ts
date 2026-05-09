// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Workspace CRUD + membership management.
 */

import { and, asc, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '../db/client.ts';
import { actors, workspaces, workspaceMembers } from '../db/schema.ts';
import type { WorkspaceRow } from '../db/schema.ts';
import type {
  Workspace,
  WorkspaceCreateReq,
  WorkspaceCreateRes,
  WorkspaceListRes,
  WorkspaceMember,
  WorkspaceMemberAddReq,
  WorkspaceMemberListRes,
} from '../domain/index.ts';

// ── Errors ───────────────────────────────────────────────────────────────

export class WorkspaceNotFoundError extends Error {
  constructor(public readonly workspaceId: string) {
    super(`workspace ${workspaceId} not found or actor is not a member`);
    this.name = 'WorkspaceNotFoundError';
  }
}

export class WorkspaceSlugConflictError extends Error {
  constructor(public readonly slug: string) {
    super(`workspace slug '${slug}' is already taken`);
    this.name = 'WorkspaceSlugConflictError';
  }
}

export class WorkspaceMemberNotFoundError extends Error {
  constructor(public readonly actorId: string) {
    super(`actor ${actorId} is not a member of this workspace`);
    this.name = 'WorkspaceMemberNotFoundError';
  }
}

export class WorkspaceAdminRequiredError extends Error {
  constructor(public readonly actorId: string) {
    super(`actor ${actorId} does not have workspace admin role`);
    this.name = 'WorkspaceAdminRequiredError';
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────

function rowToWorkspace(r: WorkspaceRow): Workspace {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    created_by: r.createdBy,
    created_at: r.createdAt.toISOString(),
  };
}

async function assertWorkspaceAdmin(
  db: Db,
  { workspaceId, actorId }: { workspaceId: string; actorId: string },
): Promise<void> {
  const [caller] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.actorId, actorId),
      ),
    )
    .limit(1);
  if (!caller) throw new WorkspaceNotFoundError(workspaceId);
  if (caller.role !== 'admin') throw new WorkspaceAdminRequiredError(actorId);
}

// ── createWorkspace ────────────────────────────────────────────────────────

export async function createWorkspace(
  db: Db,
  { req, actorId }: { req: WorkspaceCreateReq; actorId: string },
): Promise<WorkspaceCreateRes> {
  const existing = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.slug, req.slug))
    .limit(1);
  if (existing[0]) throw new WorkspaceSlugConflictError(req.slug);

  const id = uuidv7();
  return await db.transaction(async (tx) => {
    await tx.insert(workspaces).values({
      id,
      name: req.name,
      slug: req.slug,
      createdBy: actorId,
    });
    await tx.insert(workspaceMembers).values({
      workspaceId: id,
      actorId,
      role: 'admin',
    });
    const [row] = await tx
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, id))
      .limit(1);
    return { workspace: rowToWorkspace(row!) };
  });
}

// ── listWorkspacesForActor ─────────────────────────────────────────────────

export async function listWorkspacesForActor(
  db: Db,
  actorId: string,
): Promise<WorkspaceListRes> {
  const rows = await db
    .select({ workspace: workspaces })
    .from(workspaces)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, workspaces.id),
        eq(workspaceMembers.actorId, actorId),
      ),
    )
    .orderBy(asc(workspaces.slug));
  return { workspaces: rows.map((r) => rowToWorkspace(r.workspace)) };
}

// ── addWorkspaceMember ─────────────────────────────────────────────────────

export async function addWorkspaceMember(
  db: Db,
  {
    workspaceId,
    req,
    adminActorId,
  }: { workspaceId: string; req: WorkspaceMemberAddReq; adminActorId: string },
): Promise<void> {
  await assertWorkspaceAdmin(db, { workspaceId, actorId: adminActorId });

  // Verify target actor exists
  const [target] = await db
    .select({ id: actors.id })
    .from(actors)
    .where(eq(actors.id, req.actor_id))
    .limit(1);
  if (!target) throw new WorkspaceMemberNotFoundError(req.actor_id);

  await db
    .insert(workspaceMembers)
    .values({
      workspaceId,
      actorId: req.actor_id,
      role: req.role ?? 'member',
    })
    .onConflictDoUpdate({
      target: [workspaceMembers.workspaceId, workspaceMembers.actorId],
      set: { role: req.role ?? 'member' },
    });
}

// ── removeWorkspaceMember ──────────────────────────────────────────────────

export async function removeWorkspaceMember(
  db: Db,
  {
    workspaceId,
    actorId,
    adminActorId,
  }: { workspaceId: string; actorId: string; adminActorId: string },
): Promise<void> {
  await assertWorkspaceAdmin(db, { workspaceId, actorId: adminActorId });

  const deleted = await db
    .delete(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.actorId, actorId),
      ),
    )
    .returning({ actorId: workspaceMembers.actorId });
  if (deleted.length === 0) throw new WorkspaceMemberNotFoundError(actorId);
}

// ── listWorkspaceMembers ───────────────────────────────────────────────────

export async function listWorkspaceMembers(
  db: Db,
  { workspaceId, actorId }: { workspaceId: string; actorId: string },
): Promise<WorkspaceMemberListRes> {
  const [caller] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.actorId, actorId),
      ),
    )
    .limit(1);
  if (!caller) throw new WorkspaceNotFoundError(workspaceId);

  const rows = await db
    .select()
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(asc(workspaceMembers.actorId));

  return {
    members: rows.map((r): WorkspaceMember => ({
      workspace_id: r.workspaceId,
      actor_id: r.actorId,
      role: r.role as 'admin' | 'member',
      joined_at: r.joinedAt.toISOString(),
    })),
  };
}

// ── Auth middleware helpers ────────────────────────────────────────────────

export type WorkspaceResolution =
  | { kind: 'resolved'; workspaceId: string; role: 'admin' | 'member' }
  | { kind: 'none' }
  | { kind: 'ambiguous' };

export async function resolveWorkspaceForActor(
  db: Db,
  actorId: string,
): Promise<WorkspaceResolution> {
  const rows = await db
    .select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.actorId, actorId));

  if (rows.length === 1) {
    return {
      kind: 'resolved',
      workspaceId: rows[0]!.workspaceId,
      role: rows[0]!.role as 'admin' | 'member',
    };
  }
  if (rows.length === 0) return { kind: 'none' };
  return { kind: 'ambiguous' };
}

export async function resolveWorkspaceById(
  db: Db,
  { workspaceId, actorId }: { workspaceId: string; actorId: string },
): Promise<{ workspaceId: string; name: string; slug: string; role: 'admin' | 'member' } | null> {
  const [row] = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      role: workspaceMembers.role,
    })
    .from(workspaces)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, workspaces.id),
        eq(workspaceMembers.actorId, actorId),
      ),
    )
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!row) return null;
  return {
    workspaceId: row.id,
    name: row.name,
    slug: row.slug,
    role: row.role as 'admin' | 'member',
  };
}
