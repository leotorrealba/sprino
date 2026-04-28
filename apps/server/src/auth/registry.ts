/**
 * In-memory actor registry loaded from SPRINO_ACTORS_JSON.
 *
 * For v0.x PoC: tokens are static, set in env, rotation requires restart.
 * For v0.2+ cloud: replace with a per-tenant table-backed registry.
 */

import { z } from 'zod';

const ActorEntrySchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['human', 'agent']),
  display_name: z.string(),
  token: z.string().min(8),
  agent_runtime: z.string().nullable().optional(),
  parent_actor_id: z.string().uuid().nullable().optional(),
});
export type ActorEntry = z.infer<typeof ActorEntrySchema>;

let registry: Map<string, ActorEntry> | null = null;

export function loadActorRegistry(): Map<string, ActorEntry> {
  if (registry) return registry;
  const raw = process.env.SPRINO_ACTORS_JSON;
  if (!raw) {
    throw new Error(
      'SPRINO_ACTORS_JSON env var is required (JSON array of actor entries)',
    );
  }
  const parsed = z.array(ActorEntrySchema).parse(JSON.parse(raw));
  const m = new Map<string, ActorEntry>();
  for (const a of parsed) {
    if (m.has(a.token)) {
      throw new Error(`Duplicate token detected for actor ${a.id}`);
    }
    m.set(a.token, a);
  }
  registry = m;
  return m;
}

export function lookupActorByToken(token: string): ActorEntry | undefined {
  return loadActorRegistry().get(token);
}
