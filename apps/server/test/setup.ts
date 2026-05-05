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
import { v7 as uuidv7 } from 'uuid';

import { tokenAuth } from '../src/auth/middleware.ts';
import type { AuthEnv } from '../src/auth/middleware.ts';
import { closeDb, db } from '../src/db/client.ts';
import { actors, actorTokens, projects, tasks } from '../src/db/schema.ts';
import { seedFromEnv } from '../src/db/seed.ts';
import { buildHttpRoutes } from '../src/adapters/http/routes.ts';
import { sseHandler } from '../src/adapters/http/sse.ts';
import { buildMcpRoutes } from '../src/adapters/mcp/server.ts';
import { hashToken } from '../src/auth/registry.ts';

// IDs and tokens that the conformance fixtures reference.
export const FIXTURE_ACTOR_ID = '018c3e7a-0001-7000-8000-000000000001';
export const FIXTURE_PROJECT_ID = '018c3e7a-0002-7000-8000-000000000001';
export const FIXTURE_PROJECT_SLUG = 'sprino';
export const FIXTURE_TOKEN = 'test-leo-token';
export const FIXTURE_AGENT_ID = '018c3e7a-0001-7000-8000-0000000000a1';
export const FIXTURE_AGENT_TOKEN = 'test-agent-token';
// Attachment conformance fixtures reference this task id.
export const FIXTURE_TASK_ID = '018c3e7a-0003-7000-8000-000000000001';

export function buildTestApp(): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.use('*', async (c, next) => {
    c.set('db', db);
    await next();
  });

  // Mirror main.ts: SSE route MUST be registered before /api so its
  // ticket auth wins over the global Bearer middleware.
  app.get('/api/events/stream', sseHandler);

  const api = new Hono<AuthEnv>();
  api.use('*', tokenAuth);
  api.route('/', buildHttpRoutes());
  app.route('/api', api);

  const mcp = new Hono<AuthEnv>();
  mcp.use('*', tokenAuth);
  mcp.route('/', buildMcpRoutes());
  app.route('/mcp', mcp);

  return app;
}

export async function resetDb(): Promise<void> {
  // actor_tokens MUST come before actors in the truncate list — even with
  // CASCADE, listing both is defensive against future FKs. attachments is
  // listed explicitly so its sequence resets cleanly even if FK CASCADE
  // ordering differs across Postgres versions.
  await db.execute(
    sql`TRUNCATE TABLE attachments, events, operations, tasks, projects, actor_tokens, actors RESTART IDENTITY CASCADE`,
  );

  // Re-import env actors (FIXTURE_ACTOR_ID + agent) into actors +
  // actor_tokens with source='env'. This replaces the bespoke INSERT
  // we used in v0.0.8 — there's now exactly one path that knows how
  // to import env credentials, and it lives in db/seed.ts.
  await seedFromEnv(db);

  await db.insert(projects).values({
    id: FIXTURE_PROJECT_ID,
    slug: FIXTURE_PROJECT_SLUG,
    displayName: 'Sprino',
    repoPath: null,
  });
}

export async function seedDbActor(args: {
  id?: string;
  token?: string;
  displayName: string;
  kind?: 'human' | 'agent';
  role?: 'admin' | 'member';
  agentRuntime?: string | null;
  parentActorId?: string | null;
}): Promise<{ actorId: string; token: string }> {
  const actorId = args.id ?? uuidv7();
  const token = args.token ?? `test-token-${crypto.randomUUID()}`;
  await db.insert(actors).values({
    id: actorId,
    kind: args.kind ?? 'human',
    role: args.role ?? 'admin',
    displayName: args.displayName,
    agentRuntime: args.agentRuntime ?? null,
    parentActorId: args.parentActorId ?? null,
    source: 'db',
  });
  await db.insert(actorTokens).values({
    id: uuidv7(),
    actorId,
    tokenHash: hashToken(token),
    source: 'db',
  });
  return { actorId, token };
}

export async function seedFixtureTask(
  taskId: string = FIXTURE_TASK_ID,
): Promise<void> {
  await db.insert(tasks).values({
    id: taskId,
    projectId: FIXTURE_PROJECT_ID,
    title: 'Fixture task for attachment conformance',
    description: '',
    status: 'todo',
    createdBy: FIXTURE_ACTOR_ID,
  });
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeDb();
});
