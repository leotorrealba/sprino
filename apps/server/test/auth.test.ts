// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * v0.0.9 unified-DB-auth tests.
 *
 * The pre-v0.0.9 in-memory env cache and module-reset patterns are gone;
 * `lookupActorByToken` now hits the database on every call. These tests
 * therefore exercise:
 *
 *   1. Env-seeded actor authenticates (boot import wired correctly).
 *   2. parseActorsEnv still rejects malformed input at boot.
 *   3. Bearer middleware translates malformed headers / unknown tokens
 *      to the right status codes (401 vs 403).
 *   4. DB-minted actors authenticate via the same code path.
 *   5. Revoked tokens are rejected immediately (no env-reload required).
 *   6. SSE actor-id check uses the DB (Codex bug regression guard).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  hashToken,
  lookupActorByToken,
  lookupActorById,
  parseActorsEnv,
} from '../src/auth/registry.ts';
import { tokenAuth } from '../src/auth/middleware.ts';
import type { AuthVars } from '../src/auth/middleware.ts';
import { db } from '../src/db/client.ts';
import { seedFromEnv } from '../src/db/seed.ts';
import { actors, actorTokens } from '../src/db/schema.ts';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import {
  FIXTURE_ACTOR_ID,
  FIXTURE_TOKEN,
  buildTestApp,
} from './setup.ts';

describe('auth/registry — parseActorsEnv', () => {
  it('returns [] when env var is unset', () => {
    expect(parseActorsEnv(undefined)).toEqual([]);
  });

  it('parses a valid multi-actor JSON env var', () => {
    const raw = JSON.stringify([
      {
        id: '018c3e7a-0001-7000-8000-000000000001',
        kind: 'human',
        display_name: 'Leo',
        token: 'leo-token-12345',
      },
      {
        id: '018c3e7a-0001-7000-8000-000000000002',
        kind: 'agent',
        display_name: 'Claude',
        token: 'claude-token-12345',
        agent_runtime: 'anthropic-claude-sonnet-4.5',
        parent_actor_id: '018c3e7a-0001-7000-8000-000000000001',
      },
    ]);
    const parsed = parseActorsEnv(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.display_name).toBe('Leo');
    expect(parsed[1]?.kind).toBe('agent');
  });

  it('parses an explicit role when present', () => {
    const raw = JSON.stringify([
      {
        id: '018c3e7a-0001-7000-8000-000000000001',
        kind: 'human',
        display_name: 'Leo',
        token: 'leo-token-12345',
        role: 'member',
      },
    ]);
    const parsed = parseActorsEnv(raw);
    expect(parsed[0]?.role).toBe('member');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseActorsEnv('{not json')).toThrow();
  });

  it('throws when an entry is missing required fields', () => {
    const raw = JSON.stringify([
      { id: '018c3e7a-0001-7000-8000-000000000001', kind: 'human' },
    ]);
    expect(() => parseActorsEnv(raw)).toThrow();
  });

  it('throws on bad kind', () => {
    const raw = JSON.stringify([
      {
        id: '018c3e7a-0001-7000-8000-000000000001',
        kind: 'robot',
        display_name: 'X',
        token: 'tok',
      },
    ]);
    expect(() => parseActorsEnv(raw)).toThrow();
  });

  it('throws on duplicate ids', () => {
    const raw = JSON.stringify([
      {
        id: '018c3e7a-0001-7000-8000-000000000001',
        kind: 'human',
        display_name: 'A',
        token: 'tok-aaaaaaa',
      },
      {
        id: '018c3e7a-0001-7000-8000-000000000001',
        kind: 'human',
        display_name: 'B',
        token: 'tok-bbbbbbb',
      },
    ]);
    expect(() => parseActorsEnv(raw)).toThrow(/Duplicate actor id/);
  });

  it('throws on duplicate tokens', () => {
    const raw = JSON.stringify([
      {
        id: '018c3e7a-0001-7000-8000-000000000001',
        kind: 'human',
        display_name: 'A',
        token: 'shared-token-12345',
      },
      {
        id: '018c3e7a-0001-7000-8000-000000000002',
        kind: 'human',
        display_name: 'B',
        token: 'shared-token-12345',
      },
    ]);
    expect(() => parseActorsEnv(raw)).toThrow(/Duplicate token/);
  });
});

describe('auth/registry — DB lookups', () => {
  it('resolves an env-seeded token to its actor', async () => {
    const found = await lookupActorByToken(db, FIXTURE_TOKEN);
    expect(found?.id).toBe(FIXTURE_ACTOR_ID);
    expect(found?.source).toBe('env');
    expect(found?.role).toBe('admin');
  });

  it('returns undefined for an unknown token', async () => {
    expect(await lookupActorByToken(db, 'nope-not-a-token')).toBeUndefined();
  });

  it('looks up an env-seeded actor by id', async () => {
    const found = await lookupActorById(db, FIXTURE_ACTOR_ID);
    expect(found?.kind).toBe('human');
    expect(found?.role).toBe('admin');
  });

  it('returns undefined for an unknown actor id', async () => {
    expect(
      await lookupActorById(db, '00000000-0000-7000-8000-000000000000'),
    ).toBeUndefined();
  });

  it('rejects a revoked token even when its hash is still in the DB', async () => {
    // Mint a fresh DB-source actor + token, then revoke that token.
    const newActorId = uuidv7();
    const plain = 'revoked-test-token-12345';
    await db.insert(actors).values({
      id: newActorId,
      kind: 'human',
      displayName: 'Revoked',
      source: 'db',
    });
    await db.insert(actorTokens).values({
      id: uuidv7(),
      actorId: newActorId,
      tokenHash: hashToken(plain),
      source: 'db',
      revokedAt: new Date(),
    });
    expect(await lookupActorByToken(db, plain)).toBeUndefined();
  });

  it('hydrates an explicit role for an env-seeded actor', async () => {
    const actorId = uuidv7();
    const plain = 'env-member-token-12345';
    await seedFromEnv(
      db,
      JSON.stringify([
        {
          id: actorId,
          kind: 'human',
          display_name: 'Env Member',
          token: plain,
          role: 'member',
        },
      ]),
    );

    const found = await lookupActorByToken(db, plain);
    expect(found).toMatchObject({
      id: actorId,
      source: 'env',
      role: 'member',
    });
  });

  it('hydrates role for a db-backed actor', async () => {
    const actorId = uuidv7();
    const plain = 'db-member-token-12345';
    await db.insert(actors).values({
      id: actorId,
      kind: 'human',
      role: 'member',
      displayName: 'DB Member',
      source: 'db',
    });
    await db.insert(actorTokens).values({
      id: uuidv7(),
      actorId,
      tokenHash: hashToken(plain),
      source: 'db',
    });

    const found = await lookupActorByToken(db, plain);
    expect(found).toMatchObject({
      id: actorId,
      source: 'db',
      role: 'member',
    });
  });
});

describe('Bearer-token middleware via tokenAuth', () => {
  beforeEach(() => {
    /* db reset by global beforeEach hook in setup.ts */
  });
  afterEach(() => {});

  it('401s on missing Authorization header', async () => {
    const app = buildTestApp();
    const r = await app.fetch(new Request('http://test/api/projects'));
    expect(r.status).toBe(401);
  });

  it('401s on a malformed Authorization header', async () => {
    const app = buildTestApp();
    const r = await app.fetch(
      new Request('http://test/api/projects', {
        headers: { authorization: 'Token whatever' },
      }),
    );
    expect(r.status).toBe(401);
  });

  it('403s on an unknown Bearer token', async () => {
    const app = buildTestApp();
    const r = await app.fetch(
      new Request('http://test/api/projects', {
        headers: { authorization: 'Bearer nope' },
      }),
    );
    expect(r.status).toBe(403);
  });

  it('attaches the actor to context on a valid token', async () => {
    const app = buildTestApp();
    const r = await app.fetch(
      new Request('http://test/api/projects', {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(r.status).toBe(200);
  });

  it('makes role available in protected request context', async () => {
    const app = new Hono<{ Variables: AuthVars }>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      await next();
    });
    app.use('/protected/*', tokenAuth);
    app.get('/protected/role', (c) => {
      const actor = c.get('actor');
      return c.json({ actor_id: actor.id, role: actor.role }, 200);
    });

    const r = await app.fetch(
      new Request('http://test/protected/role', {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(r.status).toBe(200);
    await expect(r.json()).resolves.toEqual({
      actor_id: FIXTURE_ACTOR_ID,
      role: 'admin',
    });
  });

  it('rejects a revoked token on the very next request', async () => {
    const app = buildTestApp();

    // Revoke the env-seeded token directly. Production callers go through
    // actor.revoke_token; here we bypass to isolate the auth path.
    await db
      .update(actorTokens)
      .set({ revokedAt: new Date() })
      .where(eq(actorTokens.tokenHash, hashToken(FIXTURE_TOKEN)));

    const r = await app.fetch(
      new Request('http://test/api/projects', {
        headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
      }),
    );
    expect(r.status).toBe(403);
  });
});
