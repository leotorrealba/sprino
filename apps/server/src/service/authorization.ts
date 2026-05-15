// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Centralized authorization helpers.
 *
 * Keep policy checks here so adapters and business services can share one
 * decision source and one error taxonomy.
 */

import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { projects } from '../db/schema.ts';

export type AuthorizationCapability = 'actors.manage';

export type AuthorizationSubject = {
  id: string;
  kind: 'human' | 'agent';
  role: 'admin' | 'member';
};

export class AuthorizationForbiddenError extends Error {
  constructor(
    public readonly actorId: string,
    public readonly capability: AuthorizationCapability,
    public readonly reason: 'human_required' | 'role_not_authorized',
  ) {
    super(
      reason === 'human_required'
        ? 'only human actors may manage actors'
        : 'actor role is not authorized to manage actors',
    );
    this.name = 'AuthorizationForbiddenError';
  }
}

export class WorkspaceIsolationError extends Error {
  constructor(
    public readonly projectId: string,
    public readonly workspaceId: string,
  ) {
    super(`project ${projectId} does not belong to workspace ${workspaceId}`);
    this.name = 'WorkspaceIsolationError';
  }
}

export function assertCanManageActors(
  actor: AuthorizationSubject,
): void {
  if (actor.kind !== 'human') {
    throw new AuthorizationForbiddenError(
      actor.id,
      'actors.manage',
      'human_required',
    );
  }
  if (actor.role !== 'admin') {
    throw new AuthorizationForbiddenError(
      actor.id,
      'actors.manage',
      'role_not_authorized',
    );
  }
}

export async function assertProjectInWorkspace(
  db: Pick<Db, 'select'>,
  { projectId, workspaceId }: { projectId: string; workspaceId: string },
): Promise<void> {
  const [row] = await db
    .select({ workspaceId: projects.workspaceId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  // Only throw WorkspaceIsolationError if the project exists but belongs to a different workspace.
  // ProjectNotFoundError is handled upstream (caller already threw it before this point).
  if (row && row.workspaceId !== workspaceId) {
    throw new WorkspaceIsolationError(projectId, workspaceId);
  }
}
