// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Sprino server entry point.
 *
 * Single Hono process, two adapters mounted:
 *   /api/*    — REST adapter for the web UI
 *   /mcp      — JSON-RPC 2.0 adapter for MCP-over-HTTP
 *
 * Both adapters share:
 *   - the same Postgres pool (db/client.ts)
 *   - the same per-actor token middleware (auth/middleware.ts)
 *   - the same service/* business logic (eng review, locked)
 *
 * Run:
 *   bun --filter '@sprino/server' dev
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { ActorEntry } from './auth/registry.ts';
import { tokenAuth } from './auth/middleware.ts';
import { db, closeDb } from './db/client.ts';
import type { Db } from './db/client.ts';
import { seedFromEnv } from './db/seed.ts';
import { buildHttpRoutes } from './adapters/http/routes.ts';
import { sseHandler } from './adapters/http/sse.ts';
import { buildMcpRoutes } from './adapters/mcp/server.ts';

type Env = {
  Variables: { actor: ActorEntry; db: Db };
};

async function buildApp(): Promise<Hono<Env>> {
  // Reconcile env-seeded actors + tokens with the DB. Idempotent: safe to
  // re-run on every boot. Token recovery flow is "edit .env and restart".
  await seedFromEnv(db);

  const app = new Hono<Env>();

  app.use('*', async (c, next) => {
    c.set('db', db);
    await next();
  });

  app.get('/healthz', (c) =>
    c.json({ ok: true, version: '0.0.9', protocol: 'tessera/v0.1.2' }),
  );

  // /api/events/stream — SSE feed. Mounted DIRECTLY on the app (NOT under
  // the `api` router) so it bypasses the global Bearer middleware. Auth is
  // a short-lived signed ticket on the query string, verified inside the
  // handler. Order matters: this route MUST be registered before
  // `app.route('/api', api)` below — Hono matches routes in registration
  // order, and we want this specific path to win over the catch-all
  // Bearer-protected mount.
  app.get('/api/events/stream', sseHandler);

  // /api/* — REST. Auth required.
  const api = new Hono<Env>();
  api.use('*', tokenAuth);
  api.route('/', buildHttpRoutes());
  app.route('/api', api);

  // /mcp — JSON-RPC 2.0 over HTTP. Auth required.
  // Tokens come from MCP server config (NEVER tool inputs — see SECURITY note
  // in design doc §Secrets & Auth).
  const mcp = new Hono<Env>();
  mcp.use('*', tokenAuth);
  mcp.route('/', buildMcpRoutes());
  app.route('/mcp', mcp);

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  return app;
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3001);
  const app = await buildApp();

  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`Sprino server listening on http://localhost:${info.port}`);
    console.log(`  /api/*  — REST  (Bearer token required)`);
    console.log(`  /mcp    — JSON-RPC 2.0 (Bearer token required)`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\nReceived ${signal}, shutting down...`);
    server.close();
    await closeDb();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('Fatal error during server boot:', err);
    process.exit(1);
  });
}

export { buildApp };
