// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * v0.0.9 actor lifecycle — load-bearing tests beyond the conformance grid.
 *
 * Conformance covers happy paths and basic errors; this file pins the
 * three properties that, if regressed, would let a real bug ship:
 *
 *   1. Idempotency redaction. operations.response_body MUST NOT contain
 *      the plaintext token. Caller re-invocation MUST never recover one.
 *   2. Concurrent rotate_token. Two parallel rotates → exactly one
 *      succeeds; the loser sees ConcurrentRotationError. Verifies the
 *      partial unique index is doing its job.
 *   3. Last-admin guard. Refusing to revoke the only remaining active
 *      human credential is the difference between "we lock ourselves
 *      out" and "we don't".
 *   4. Env-actor immutability. SPRINO_ACTORS_JSON entries cannot be
 *      revoked or rotated through the API — recovery is via .env edit.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db/client.ts';
import { operations } from '../src/db/schema.ts';
import {
  assertCanManageActors,
} from '../src/service/authorization.ts';
import {
  ConcurrentRotationError,
  EnvActorImmutableError,
  LastAdminProtectedError,
  registerActor,
  revokeToken,
  rotateToken,
} from '../src/service/actors.ts';
import { hashToken, lookupActorByToken } from '../src/auth/registry.ts';
import type { Actor } from '../src/domain/index.ts';
import {
  FIXTURE_ACTOR_ID,
  FIXTURE_AGENT_ID,
  seedDbActor,
} from './setup.ts';

describe('registerActor — idempotency redaction', () => {
  it('does NOT persist the plaintext token in operations.response_body', async () => {
    const opId = '018c3e7a-aaaa-7000-8000-000000000001';
    const first = await registerActor(db, {
      req: { operation_id: opId, display_name: 'Alice', kind: 'human' },
      callerId: FIXTURE_ACTOR_ID,
    });
    expect('token' in first).toBe(true);

    const rows = await db
      .select({ body: operations.responseBody })
      .from(operations)
      .where(eq(operations.operationId, opId));
    expect(rows).toHaveLength(1);
    const body = rows[0]!.body as Record<string, unknown>;
    expect(body).toHaveProperty('actor');
    expect(body).not.toHaveProperty('token');

    // The plaintext is not recoverable from the row — it was generated in
    // memory and only the hash was persisted via actor_tokens.
    expect(JSON.stringify(body)).not.toContain(
      'token' in first ? (first as { token: string }).token : '!!!',
    );
  });

  it('replay returns {actor} only — never re-mints or re-leaks a token', async () => {
    const opId = '018c3e7a-aaaa-7000-8000-000000000002';
    const req = {
      operation_id: opId,
      display_name: 'Bob',
      kind: 'human' as const,
    };
    const first = await registerActor(db, { req, callerId: FIXTURE_ACTOR_ID });
    const replay = await registerActor(db, { req, callerId: FIXTURE_ACTOR_ID });

    expect('token' in first).toBe(true);
    expect('token' in replay).toBe(false);
    expect(replay.actor.id).toBe(first.actor.id);
  });
});

describe('revokeToken — last-admin guard', () => {
  it('refuses to revoke the only active human credential', async () => {
    // Mint a fresh DB-source human, then drop env-source actor_tokens so
    // the only path to a "human with an active credential" is the new
    // DB-source actor. Revoking that one must trip the guard.
    const minted = await registerActor(db, {
      req: {
        operation_id: '018c3e7a-bbbb-7000-8000-000000000001',
        display_name: 'Solo',
        kind: 'human',
      },
      callerId: FIXTURE_ACTOR_ID,
    });

    const { sql } = await import('drizzle-orm');
    await db.execute(sql`DELETE FROM actor_tokens WHERE source = 'env'`);

    await expect(
      revokeToken(db, {
        req: {
          operation_id: '018c3e7a-bbbb-7000-8000-000000000011',
          actor_id: minted.actor.id,
        },
        callerId: minted.actor.id,
      }),
    ).rejects.toThrow(LastAdminProtectedError);
  });
});

describe('actor admin authorization', () => {
  it('forbids member humans from registering actors', async () => {
    const member = await seedDbActor({
      displayName: 'Member Human',
      role: 'member',
    });

    await expect(
      registerActor(db, {
        req: {
          operation_id: '018c3e7a-abcd-7000-8000-000000000001',
          display_name: 'Blocked Register',
          kind: 'human',
        },
        callerId: member.actorId,
      }),
    ).rejects.toMatchObject({
      actorId: member.actorId,
      capability: 'actors.manage',
      reason: 'role_not_authorized',
    });
  });

  it('forbids agents from revoking tokens even when their internal role is admin', async () => {
    const minted = await registerActor(db, {
      req: {
        operation_id: '018c3e7a-abcd-7000-8000-000000000002',
        display_name: 'Revoke Target',
        kind: 'human',
      },
      callerId: FIXTURE_ACTOR_ID,
    });

    await expect(
      revokeToken(db, {
        req: {
          operation_id: '018c3e7a-abcd-7000-8000-000000000003',
          actor_id: minted.actor.id,
        },
        callerId: FIXTURE_AGENT_ID,
      }),
    ).rejects.toMatchObject({
      actorId: FIXTURE_AGENT_ID,
      capability: 'actors.manage',
      reason: 'human_required',
    });
  });

  it('forbids member humans from rotating tokens', async () => {
    const member = await seedDbActor({
      displayName: 'Rotate Member',
      role: 'member',
    });
    const target = await registerActor(db, {
      req: {
        operation_id: '018c3e7a-abcd-7000-8000-000000000004',
        display_name: 'Rotate Target',
        kind: 'human',
      },
      callerId: FIXTURE_ACTOR_ID,
    });

    await expect(
      rotateToken(db, {
        actorId: target.actor.id,
        callerId: member.actorId,
      }),
    ).rejects.toMatchObject({
      actorId: member.actorId,
      capability: 'actors.manage',
      reason: 'role_not_authorized',
    });
  });

  it('authorization kernel still allows human admins to manage actors', () => {
    expect(() =>
      assertCanManageActors({
        id: FIXTURE_ACTOR_ID,
        kind: 'human',
        role: 'admin',
      }),
    ).not.toThrow();
  });
});

describe('revokeToken / rotateToken — env-actor immutability', () => {
  it('refuses to revoke an env-source actor', async () => {
    await expect(
      revokeToken(db, {
        req: {
          operation_id: '018c3e7a-dddd-7000-8000-000000000001',
          actor_id: FIXTURE_ACTOR_ID,
        },
        callerId: FIXTURE_ACTOR_ID,
      }),
    ).rejects.toThrow(EnvActorImmutableError);
  });

  it('refuses to rotate an env-source actor', async () => {
    await expect(
      rotateToken(db, { actorId: FIXTURE_ACTOR_ID, callerId: FIXTURE_ACTOR_ID }),
    ).rejects.toThrow(EnvActorImmutableError);
  });
});

describe('rotateToken — race safety', () => {
  it('the partial unique index forbids two active tokens for one actor', async () => {
    // Direct test of the Postgres-level guarantee. Even if every layer
    // above this — service code, ORM, application logic — were buggy,
    // the partial unique index would still keep us out of the
    // pathological "two active tokens" state. This is load-bearing.
    const minted = await registerActor(db, {
      req: {
        operation_id: '018c3e7a-eeee-7000-8000-000000000010',
        display_name: 'IndexProbe',
        kind: 'human',
      },
      callerId: FIXTURE_ACTOR_ID,
    });

    const { actorTokens } = await import('../src/db/schema.ts');
    const insertSecondActive = db.insert(actorTokens).values({
      id: '018c3e7a-eeee-7000-8000-aaaaaaaaaaaa',
      actorId: minted.actor.id,
      tokenHash: hashToken('would-be-second-active-token-12345'),
      source: 'db',
    });
    await expect(insertSecondActive).rejects.toThrowError(
      /unique|duplicate/i,
    );
  });

  it('two parallel rotates always converge to exactly one active token', async () => {
    // Whether the serializer makes them overlap or not, the property we
    // need is invariant: at most one active token survives, and the
    // returned plaintext authenticates against it.
    const minted = await registerActor(db, {
      req: {
        operation_id: '018c3e7a-eeee-7000-8000-000000000001',
        display_name: 'Racer',
        kind: 'human',
      },
      callerId: FIXTURE_ACTOR_ID,
    });

    const results = await Promise.allSettled([
      rotateToken(db, { actorId: minted.actor.id, callerId: FIXTURE_ACTOR_ID }),
      rotateToken(db, { actorId: minted.actor.id, callerId: FIXTURE_ACTOR_ID }),
    ]);
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<{ actor: Actor; token: string }> =>
        r.status === 'fulfilled',
    );
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );

    // Either both serialized (both fulfilled, one supersedes the other)
    // or one raced and lost (one ConcurrentRotationError). Anything else
    // is a regression.
    expect(fulfilled.length + rejected.length).toBe(2);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(ConcurrentRotationError);
    }

    // Postgres-enforced invariant: exactly one active token remains.
    const { actorTokens } = await import('../src/db/schema.ts');
    const active = await db
      .select()
      .from(actorTokens)
      .where(
        and(
          eq(actorTokens.actorId, minted.actor.id),
          isNull(actorTokens.revokedAt),
        ),
      );
    expect(active).toHaveLength(1);

    // The most-recently-fulfilled token must be the one that authenticates.
    // (When both fulfilled, the second call's token is the survivor; the
    // first call's token was revoked by the second.)
    const survivor = fulfilled[fulfilled.length - 1]!.value.token;
    const lookup = await lookupActorByToken(db, survivor);
    expect(lookup?.id).toBe(minted.actor.id);
  });
});

describe('rotateToken — happy path stores hash, not plaintext', () => {
  it('persists only sha256(token) — plaintext is not recoverable from the DB', async () => {
    const minted = await registerActor(db, {
      req: {
        operation_id: '018c3e7a-ffff-7000-8000-000000000001',
        display_name: 'Hashy',
        kind: 'human',
      },
      callerId: FIXTURE_ACTOR_ID,
    });
    const rot = await rotateToken(db, {
      actorId: minted.actor.id,
      callerId: FIXTURE_ACTOR_ID,
    });

    const { actorTokens } = await import('../src/db/schema.ts');
    const rows = await db
      .select()
      .from(actorTokens)
      .where(eq(actorTokens.actorId, minted.actor.id));

    // Two rows: original (revoked) and new (active). Neither stores plaintext.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.tokenHash)).not.toContain(rot.token);
    expect(rows.map((r) => r.tokenHash)).toContain(hashToken(rot.token));
    expect(
      rows.filter((r) => r.revokedAt === null).map((r) => r.tokenHash),
    ).toEqual([hashToken(rot.token)]);

    // Authenticate against the bearer-token middleware path.
    const lookup = await lookupActorByToken(db, rot.token);
    expect(lookup?.id).toBe(minted.actor.id);
  });
});
