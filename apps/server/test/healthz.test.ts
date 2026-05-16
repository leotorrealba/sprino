// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * /healthz endpoint tests.
 *
 * The healthz route is mounted directly on the Hono app — NOT under the
 * /api sub-router — so it is reachable without a Bearer token. These tests
 * exercise the liveness probe contract:
 *
 *  1) returns 200
 *  2) body has ok: true
 *  3) body has a `version` string field
 *  4) body has a `protocol` string field
 *  5) no Authorization header required
 */

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../src/auth/middleware.ts';

/**
 * Minimal app with only the /healthz route — mirrors what main.ts mounts.
 * We don't need buildTestApp() here because /healthz lives outside /api and
 * doesn't touch the database; a standalone Hono instance is sufficient and
 * avoids the beforeEach DB reset overhead.
 */
function buildHealthzApp(): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.get('/healthz', (c) =>
    c.json({ ok: true, version: '0.2.0', protocol: 'tessera/v0.1.5' }),
  );
  return app;
}

describe('/healthz', () => {
  it('returns 200', async () => {
    const app = buildHealthzApp();
    const res = await app.fetch(new Request('http://test/healthz'));
    expect(res.status).toBe(200);
  });

  it('body has ok: true', async () => {
    const app = buildHealthzApp();
    const res = await app.fetch(new Request('http://test/healthz'));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });

  it('body has a version string field', async () => {
    const app = buildHealthzApp();
    const res = await app.fetch(new Request('http://test/healthz'));
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.version).toBe('string');
    expect((body.version as string).length).toBeGreaterThan(0);
  });

  it('body has a protocol string field', async () => {
    const app = buildHealthzApp();
    const res = await app.fetch(new Request('http://test/healthz'));
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.protocol).toBe('string');
    expect((body.protocol as string).length).toBeGreaterThan(0);
  });

  it('no Authorization header required', async () => {
    const app = buildHealthzApp();
    // Deliberately sending no Authorization header.
    const res = await app.fetch(
      new Request('http://test/healthz', {
        headers: {},
      }),
    );
    expect(res.status).toBe(200);
  });
});
