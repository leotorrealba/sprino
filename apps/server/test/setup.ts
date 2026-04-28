// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Test setup: spin up the Hono app against a real Postgres, with a clean
 * schema reset before each test.
 *
 * Database selection:
 *   - Requires TEST_DATABASE_URL to be set. Tests TRUNCATE all tables, so we
 *     refuse to run against the dev DATABASE_URL by default — it would wipe
 *     the founder's dogfood tasks. Bootstrap a test DB with:
 *       createdb sprino_test
 *       TEST_DATABASE_URL=postgres://$(whoami)@localhost:5432/sprino_test \
 *         bun --filter @sprino/server db:migrate
 *   - Tests TRUNCATE all tables CASCADE before each run, then re-seed the
 *     actor + project that the conformance fixtures reference.
 *
 * Why fetch() and not a real listening server:
 *   Hono's `app.fetch` accepts a Web Request and returns a Web Response —
 *   we get full HTTP-shaped tests with zero port management.
 */

// Env mutations run in env-setup.ts (loaded first via vitest.config.ts) so
// that ES-module import hoisting can't capture stale DATABASE_URL values.

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeEach } from 'vitest';

import { tokenAuth } from '../src/auth/middleware.ts';
import type { ActorEntry } from '../src/auth/registry.ts';
import { closeDb, db } from '../src/db/client.ts';
import type { Db } from '../src/db/client.ts';
import { actors, projects } from '../src/db/schema.ts';
import { buildHttpRoutes } from '../src/adapters/http/routes.ts';
import { sseHandler } from '../src/adapters/http/sse.ts';
import { buildMcpRoutes } from '../src/adapters/mcp/server.ts';

// IDs and tokens that the conformance fixtures reference.
export const FIXTURE_ACTOR_ID = '018c3e7a-0001-7000-8000-000000000001';
export const FIXTURE_PROJECT_ID = '018c3e7a-0002-7000-8000-000000000001';
export const FIXTURE_PROJECT_SLUG = 'sprino';
export const FIXTURE_TOKEN = 'test-leo-token';

type Env = { Variables: { actor: ActorEntry; db: Db } };

export function buildTestApp(): Hono<Env> {
  const app = new Hono<Env>();

  app.use('*', async (c, next) => {
    c.set('db', db);
    await next();
  });

  // Mirror main.ts: SSE route MUST be registered before /api so its
  // ticket auth wins over the global Bearer middleware.
  app.get('/api/events/stream', sseHandler);

  const api = new Hono<Env>();
  api.use('*', tokenAuth);
  api.route('/', buildHttpRoutes());
  app.route('/api', api);

  const mcp = new Hono<Env>();
  mcp.use('*', tokenAuth);
  mcp.route('/', buildMcpRoutes());
  app.route('/mcp', mcp);

  return app;
}

export async function resetDb(): Promise<void> {
  await db.execute(
    sql`TRUNCATE TABLE events, operations, tasks, projects, actors RESTART IDENTITY CASCADE`,
  );

  await db.insert(actors).values({
    id: FIXTURE_ACTOR_ID,
    kind: 'human',
    displayName: 'Leonardo',
    agentRuntime: null,
    parentActorId: null,
  });

  await db.insert(projects).values({
    id: FIXTURE_PROJECT_ID,
    slug: FIXTURE_PROJECT_SLUG,
    displayName: 'Sprino',
    repoPath: null,
  });
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeDb();
});
