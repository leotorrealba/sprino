/**
 * Stream 3A: unit tests for the actor registry + Bearer-token middleware.
 *
 * Why these are separate from conformance tests:
 *   The conformance suite exercises the happy path (one actor, valid token).
 *   Production safety needs the failure modes too: malformed env, duplicate
 *   tokens, missing/garbled Authorization headers, unknown tokens, and the
 *   401-vs-403 distinction (which downstream agents may rely on for retry
 *   logic).
 *
 * Registry cache:
 *   `loadActorRegistry` caches the parsed registry in a module-level
 *   variable. Tests use `vi.resetModules()` + dynamic re-import to get a
 *   fresh module per assertion when we need to test load-time errors.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TWO_ACTORS = [
  {
    id: '018c3e7a-0001-7000-8000-000000000001',
    kind: 'human',
    display_name: 'Leonardo',
    token: 'leo-token-12345',
    agent_runtime: null,
  },
  {
    id: '018c3e7a-0001-7000-8000-000000000002',
    kind: 'agent',
    display_name: 'Claude',
    token: 'claude-token-12345',
    agent_runtime: 'anthropic-claude-sonnet-4.5',
    parent_actor_id: '018c3e7a-0001-7000-8000-000000000001',
  },
];

const ORIGINAL_ENV = process.env.SPRINO_ACTORS_JSON;

describe('auth/registry — loadActorRegistry', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.SPRINO_ACTORS_JSON = ORIGINAL_ENV;
  });

  it('parses a valid multi-actor JSON env var', async () => {
    process.env.SPRINO_ACTORS_JSON = JSON.stringify(TWO_ACTORS);
    const { loadActorRegistry } = await import('../src/auth/registry.ts');

    const m = loadActorRegistry();
    expect(m.size).toBe(2);
    expect(m.get('leo-token-12345')?.display_name).toBe('Leonardo');
    expect(m.get('claude-token-12345')?.kind).toBe('agent');
    expect(m.get('claude-token-12345')?.agent_runtime).toBe(
      'anthropic-claude-sonnet-4.5',
    );
    expect(m.get('claude-token-12345')?.parent_actor_id).toBe(
      '018c3e7a-0001-7000-8000-000000000001',
    );
  });

  it('caches the parsed map across calls (same reference returned)', async () => {
    process.env.SPRINO_ACTORS_JSON = JSON.stringify(TWO_ACTORS);
    const { loadActorRegistry } = await import('../src/auth/registry.ts');

    const a = loadActorRegistry();
    const b = loadActorRegistry();
    expect(a).toBe(b);
  });

  it('throws when SPRINO_ACTORS_JSON is unset', async () => {
    delete process.env.SPRINO_ACTORS_JSON;
    const { loadActorRegistry } = await import('../src/auth/registry.ts');

    expect(() => loadActorRegistry()).toThrow(/SPRINO_ACTORS_JSON/);
  });

  it('throws when SPRINO_ACTORS_JSON is not valid JSON', async () => {
    process.env.SPRINO_ACTORS_JSON = '{not json';
    const { loadActorRegistry } = await import('../src/auth/registry.ts');

    expect(() => loadActorRegistry()).toThrow();
  });

  it('throws when an entry is missing required fields', async () => {
    process.env.SPRINO_ACTORS_JSON = JSON.stringify([
      { id: '018c3e7a-0001-7000-8000-000000000001', kind: 'human' },
    ]);
    const { loadActorRegistry } = await import('../src/auth/registry.ts');

    expect(() => loadActorRegistry()).toThrow();
  });

  it('throws when kind is not human or agent', async () => {
    process.env.SPRINO_ACTORS_JSON = JSON.stringify([
      { ...TWO_ACTORS[0], kind: 'robot' },
    ]);
    const { loadActorRegistry } = await import('../src/auth/registry.ts');

    expect(() => loadActorRegistry()).toThrow();
  });

  it('throws when token is shorter than 8 chars', async () => {
    process.env.SPRINO_ACTORS_JSON = JSON.stringify([
      { ...TWO_ACTORS[0], token: 'short' },
    ]);
    const { loadActorRegistry } = await import('../src/auth/registry.ts');

    expect(() => loadActorRegistry()).toThrow();
  });

  it('throws when two actors share a token', async () => {
    process.env.SPRINO_ACTORS_JSON = JSON.stringify([
      TWO_ACTORS[0],
      { ...TWO_ACTORS[1], token: TWO_ACTORS[0]!.token },
    ]);
    const { loadActorRegistry } = await import('../src/auth/registry.ts');

    expect(() => loadActorRegistry()).toThrow(/Duplicate token/);
  });
});

describe('auth/registry — lookupActorByToken', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.SPRINO_ACTORS_JSON = ORIGINAL_ENV;
  });

  it('returns the actor for a known token', async () => {
    process.env.SPRINO_ACTORS_JSON = JSON.stringify(TWO_ACTORS);
    const { lookupActorByToken } = await import('../src/auth/registry.ts');

    expect(lookupActorByToken('leo-token-12345')?.kind).toBe('human');
  });

  it('returns undefined for an unknown token', async () => {
    process.env.SPRINO_ACTORS_JSON = JSON.stringify(TWO_ACTORS);
    const { lookupActorByToken } = await import('../src/auth/registry.ts');

    expect(lookupActorByToken('not-a-real-token')).toBeUndefined();
  });
});

describe('auth/middleware — tokenAuth (401 vs 403)', () => {
  // FIXTURE_TOKEN = 'test-leo-token' resolves to the Leonardo actor seeded
  // by env-setup.ts. We reset modules and restore env explicitly so that
  // earlier registry tests (which load TWO_ACTORS into the cache) cannot
  // leak through.
  beforeEach(() => {
    vi.resetModules();
    process.env.SPRINO_ACTORS_JSON = ORIGINAL_ENV;
  });

  function appWithAuth() {
    return import('../src/auth/middleware.ts').then(({ tokenAuth }) => {
      const app = new Hono();
      app.use('*', tokenAuth);
      app.get('/whoami', (c) => {
        // biome-ignore lint/suspicious/noExplicitAny: hono ctx generics
        const actor = (c as any).get('actor');
        return c.json({ id: actor.id, kind: actor.kind });
      });
      return app;
    });
  }

  it('returns 401 when Authorization header is missing', async () => {
    const app = await appWithAuth();
    const res = await app.fetch(new Request('http://t/whoami'));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: 'missing_or_malformed_authorization',
    });
  });

  it('returns 401 when Authorization header is not a Bearer scheme', async () => {
    const app = await appWithAuth();
    const res = await app.fetch(
      new Request('http://t/whoami', {
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
      }),
    );

    expect(res.status).toBe(401);
  });

  it('returns 401 when Bearer is present but value is empty', async () => {
    const app = await appWithAuth();
    const res = await app.fetch(
      new Request('http://t/whoami', {
        headers: { authorization: 'Bearer ' },
      }),
    );

    // "Bearer " (trailing space, no token) does not match /^Bearer\s+(.+)$/
    expect(res.status).toBe(401);
  });

  it('returns 403 when token is well-formed but unknown', async () => {
    const app = await appWithAuth();
    const res = await app.fetch(
      new Request('http://t/whoami', {
        headers: { authorization: 'Bearer ghost-token-not-registered' },
      }),
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'invalid_token' });
  });

  it('passes through and attaches the actor on a valid token', async () => {
    const app = await appWithAuth();
    const res = await app.fetch(
      new Request('http://t/whoami', {
        headers: { authorization: 'Bearer test-leo-token' },
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: '018c3e7a-0001-7000-8000-000000000001',
      kind: 'human',
    });
  });

  it('accepts case-insensitive Bearer scheme', async () => {
    const app = await appWithAuth();
    const res = await app.fetch(
      new Request('http://t/whoami', {
        headers: { authorization: 'bearer test-leo-token' },
      }),
    );

    expect(res.status).toBe(200);
  });
});
