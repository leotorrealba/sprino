// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Agents service — read-only registry view.
 *
 * Phase 6 (resource limits) introduces `agents.list` so dogfood UIs and
 * MCP clients can enumerate the agent actors registered with this Sprino
 * instance. Agent identities live in the in-memory registry loaded from
 * `SPRINO_ACTORS_JSON` (see auth/registry.ts) — there is no separate
 * `agents` table in v0.0.x.
 *
 * Tokens are NEVER returned. Callers see id/kind/display_name/runtime/parent
 * only. The handler runs after auth middleware, so any caller already had
 * a valid token before reaching this code path.
 */

import { loadActorRegistry } from '../auth/registry.ts';
import {
  DEFAULT_LIMIT,
  type Agent,
  type AgentListReq,
  type AgentListRes,
} from '../domain/index.ts';

export function listAgents(args: { req: AgentListReq }): AgentListRes {
  // Bounds (limit ≤ 100, offset ≥ 0) are enforced by AgentListReqSchema.
  const limit = args.req.limit ?? DEFAULT_LIMIT;
  const offset = args.req.offset ?? 0;

  const all: Agent[] = [];
  for (const entry of loadActorRegistry().values()) {
    if (entry.kind !== 'agent') continue;
    all.push({
      id: entry.id,
      kind: 'agent',
      display_name: entry.display_name,
      agent_runtime: entry.agent_runtime ?? null,
      parent_actor_id: entry.parent_actor_id ?? null,
    });
  }
  // Stable order across calls so pagination is deterministic.
  all.sort((a, b) => a.id.localeCompare(b.id));

  return { agents: all.slice(offset, offset + limit) };
}
