// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * A1 authorization-foundation tests.
 *
 * Packet A1-P1 is storage-only: pin the database contract for actor roles
 * before role hydration and service-level authorization land in later packets.
 */

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../src/db/client.ts';
import { assertCanManageActors } from '../src/service/authorization.ts';

describe('actor role storage primitives', () => {
  it('persists an explicitly assigned role', async () => {
    const actorId = uuidv7();
    const result = await db.execute<{ id: string; role: string }>(sql`
      insert into actors (id, kind, display_name, source, role)
      values (${actorId}, 'human', 'Explicit Member', 'db', 'member')
      returning id, role
    `);

    expect(result.rows).toEqual([{ id: actorId, role: 'member' }]);
  });

  it('defaults fresh human actors to admin', async () => {
    const actorId = uuidv7();
    const result = await db.execute<{ id: string; role: string }>(sql`
      insert into actors (id, kind, display_name, source)
      values (${actorId}, 'human', 'Default Human', 'db')
      returning id, role
    `);

    expect(result.rows).toEqual([{ id: actorId, role: 'admin' }]);
  });

  it('defaults fresh agent actors to admin', async () => {
    const actorId = uuidv7();
    const result = await db.execute<{ id: string; role: string }>(sql`
      insert into actors (id, kind, display_name, source)
      values (${actorId}, 'agent', 'Default Agent', 'db')
      returning id, role
    `);

    expect(result.rows).toEqual([{ id: actorId, role: 'admin' }]);
  });
});

describe('authorization service kernel', () => {
  it('allows human admins to manage actors', () => {
    expect(() =>
      assertCanManageActors({
        id: uuidv7(),
        kind: 'human',
        role: 'admin',
      }),
    ).not.toThrow();
  });

  it('forbids non-admin humans from managing actors', () => {
    expect(() =>
      assertCanManageActors({
        id: uuidv7(),
        kind: 'human',
        role: 'member',
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[AuthorizationForbiddenError: actor role is not authorized to manage actors]`,
    );
  });

  it('forbids agents from managing actors even when their role is admin', () => {
    expect(() =>
      assertCanManageActors({
        id: uuidv7(),
        kind: 'agent',
        role: 'admin',
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[AuthorizationForbiddenError: only human actors may manage actors]`,
    );
  });

  it('surfaces a reusable forbidden error taxonomy', () => {
    try {
      assertCanManageActors({
        id: '018c3e7a-0001-7000-8000-000000000001',
        kind: 'human',
        role: 'member',
      });
      throw new Error('expected authorization failure');
    } catch (err) {
      expect(err).toMatchObject({
        name: 'AuthorizationForbiddenError',
        actorId: '018c3e7a-0001-7000-8000-000000000001',
        capability: 'actors.manage',
        reason: 'role_not_authorized',
      });
    }
  });
});
