// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Pagination contract — shared limits + schema factory.
 *
 * Phase 6 (resource limits) hardens the list verbs against runaway queries.
 * Each list endpoint declares its own max limit; this module is the single
 * source of truth for those caps so they cannot drift between schemas,
 * service code, and docs.
 *
 * Behavior on exceed: ZodError → adapter maps to 400 `validation_error`.
 * No silent clamping. Callers must learn the contract; quiet truncation
 * hides client bugs.
 */

import { z } from 'zod';

export const DEFAULT_LIMIT = 50;

export const MAX_LIMITS = {
  events: 1000,
  tasks: 500,
  agents: 100,
} as const;

/**
 * Build a pagination sub-schema with a per-endpoint max limit.
 *
 * `z.coerce.number()` accepts query-string values and rejects malformed
 * inputs (`abc`, empty) with a validation error rather than treating them
 * as absent — same convention as EventListReqSchema in v0.0.x.
 */
export function paginationSchema(maxLimit: number) {
  return z.object({
    limit: z.coerce.number().int().min(1).max(maxLimit).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  });
}
