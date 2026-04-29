// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Centralized authorization helpers.
 *
 * Keep policy checks here so adapters and business services can share one
 * decision source and one error taxonomy.
 */

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
