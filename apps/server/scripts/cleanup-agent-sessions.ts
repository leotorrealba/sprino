// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Daily or sub-hourly cron: expire stale agent sessions.
 *
 *   SPRINO_AGENT_HEARTBEAT_TTL_MS=600000 \
 *     bun --filter '@sprino/server' cleanup-agent-sessions
 */

import { closeDb, db } from '../src/db/client.ts';
import { expireStaleAgents } from '../src/service/agent-lifecycle.ts';

const DEFAULT_HEARTBEAT_TTL_MS = 10 * 60 * 1000;

function readHeartbeatTtlMs(): number {
  const raw = process.env.SPRINO_AGENT_HEARTBEAT_TTL_MS;
  if (!raw) return DEFAULT_HEARTBEAT_TTL_MS;
  const ttlMs = Number(raw);
  if (!Number.isFinite(ttlMs) || !Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new Error('SPRINO_AGENT_HEARTBEAT_TTL_MS must be a positive integer');
  }
  return ttlMs;
}

async function main(): Promise<void> {
  const ttlMs = readHeartbeatTtlMs();
  const now = new Date();
  const cutoff = new Date(now.getTime() - ttlMs);
  const result = await expireStaleAgents(db, { cutoff, now });

  console.log(
    `Expired ${result.expired_count} agent session(s) with heartbeat cutoff ${cutoff.toISOString()}`,
  );

  await closeDb();
}

main().catch((err) => {
  console.error('cleanup-agent-sessions failed:', err);
  process.exit(1);
});
