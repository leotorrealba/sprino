// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Agents service — read-only registry view (Sprino-only `agents.list`).
 *
 * v0.0.9: backed by the DB (actors WHERE kind='agent') instead of the
 * deprecated in-memory env registry. Both env-seeded and runtime-minted
 * agents appear here. Tokens are NEVER returned.
 */

import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { actors } from '../db/schema.ts';
import {
  DEFAULT_LIMIT,
  type Agent,
  type AgentListReq,
  type AgentListRes,
} from '../domain/index.ts';

export async function listAgents(
  db: Db,
  args: { req: AgentListReq },
): Promise<AgentListRes> {
  const limit = args.req.limit ?? DEFAULT_LIMIT;
  const offset = args.req.offset ?? 0;

  const rows = await db
    .select()
    .from(actors)
    .where(eq(actors.kind, 'agent'));
  rows.sort((a, b) => a.id.localeCompare(b.id));

  const all: Agent[] = rows.map((r) => ({
    id: r.id,
    kind: 'agent',
    display_name: r.displayName,
    agent_runtime: r.agentRuntime,
    parent_actor_id: r.parentActorId,
  }));
  return { agents: all.slice(offset, offset + limit) };
}
