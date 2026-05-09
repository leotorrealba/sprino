// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Concurrent revoke regression: two admins must never be able to revoke the
 * last two active human credentials at the same time.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db/client.ts';
import { actors, actorTokens, workspaces } from '../src/db/schema.ts';
import {
  LastAdminProtectedError,
  revokeToken,
} from '../src/service/actors.ts';
import { seedDbActor, FIXTURE_WORKSPACE_ID } from './setup.ts';

async function setupTwoHumanAdmins(): Promise<{ a: string; b: string }> {
  await db.execute(sql`DELETE FROM actor_tokens WHERE source = 'env'`);
  const a = await seedDbActor({
    displayName: 'Race Admin A',
    role: 'admin',
  });
  const b = await seedDbActor({
    displayName: 'Race Admin B',
    role: 'admin',
  });
  return { a: a.actorId, b: b.actorId };
}

describe('last-admin revoke race', () => {
  it('allows at most one of two concurrent revokes against the final active humans', async () => {
    const { a, b } = await setupTwoHumanAdmins();

    const results = await Promise.allSettled([
      revokeToken(db, {
        req: {
          operation_id: '018c3e7a-aace-7000-8000-000000000001',
          actor_id: a,
        },
        callerId: b,
      }),
      revokeToken(db, {
        req: {
          operation_id: '018c3e7a-bbce-7000-8000-000000000002',
          actor_id: b,
        },
        callerId: a,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(LastAdminProtectedError);

    const activeHumans = await db
      .selectDistinct({ actorId: actorTokens.actorId })
      .from(actorTokens)
      .innerJoin(actors, eq(actorTokens.actorId, actors.id))
      .where(
        and(
          isNull(actorTokens.revokedAt),
          eq(actors.kind, 'human'),
        ),
      );

    expect(activeHumans).toHaveLength(1);
    expect([a, b]).toContain(activeHumans[0]!.actorId);
  });

  it('stays stable across repeated runs', async () => {
    for (let i = 0; i < 12; i += 1) {
      await db.execute(
        sql`TRUNCATE TABLE events, operations, tasks, projects, workspace_members, workspaces, actor_tokens, actors RESTART IDENTITY CASCADE`,
      );
      // Re-insert fixture workspace so seedDbActor (which inserts workspace_members) can succeed.
      await db.insert(workspaces).values({
        id: FIXTURE_WORKSPACE_ID,
        name: 'Default',
        slug: 'default',
        createdBy: null,
      });
      const { a, b } = await setupTwoHumanAdmins();
      const results = await Promise.allSettled([
        revokeToken(db, {
          req: {
            operation_id: `018c3e7a-ab${i.toString(16).padStart(2, '0')}-7000-8000-000000000001`,
            actor_id: a,
          },
          callerId: b,
        }),
        revokeToken(db, {
          req: {
            operation_id: `018c3e7a-cd${i.toString(16).padStart(2, '0')}-7000-8000-000000000002`,
            actor_id: b,
          },
          callerId: a,
        }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        results.filter((r) => r.status === 'rejected')[0]?.reason,
      ).toBeInstanceOf(LastAdminProtectedError);
    }
  });
});
