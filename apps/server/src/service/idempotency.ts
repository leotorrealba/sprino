/**
 * Idempotency dedup for mutating verbs.
 *
 * Tessera v0.0.1 rules:
 *   - Same operation_id + same request_hash → return cached response.
 *   - Same operation_id + different request_hash → throw 409 with cached body.
 *   - Past expiry → throw 410.
 *   - First call → returns null; caller writes the operation row.
 *
 * Hash: SHA-256 of canonical-JSON (sorted keys, no whitespace) of the request.
 */

import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Db } from '../db/client.ts';
import { operations } from '../db/schema.ts';

export const OPERATION_TTL_DAYS = 30;

export class IdempotencyConflictError extends Error {
  constructor(public readonly cachedResponse: unknown) {
    super('operation_id reused with different payload');
    this.name = 'IdempotencyConflictError';
  }
}

export class OperationExpiredError extends Error {
  constructor() {
    super('operation_id is past retention');
    this.name = 'OperationExpiredError';
  }
}

/** Canonicalize an object to JSON with sorted keys, no whitespace. */
export function canonicalJson(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(sortKeys);
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      sorted[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return sorted;
  };
  return JSON.stringify(sortKeys(value));
}

export function hashRequest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * Check whether this (operation_id, request_hash) has been seen.
 * Returns the cached response if it's a valid replay, null if first call.
 * Throws on conflict / expiry.
 */
export async function checkIdempotency(
  db: Db,
  operationId: string,
  requestHash: string,
): Promise<unknown | null> {
  const rows = await db
    .select()
    .from(operations)
    .where(eq(operations.operationId, operationId));
  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt < new Date()) {
    throw new OperationExpiredError();
  }
  if (row.requestHash !== requestHash) {
    throw new IdempotencyConflictError(row.responseBody);
  }
  return row.responseBody;
}

/**
 * Persist the (operation_id, request_hash, response_body) tuple.
 * Caller is inside the same transaction as the actual mutation.
 */
export async function recordOperation(
  db: Db,
  args: {
    operationId: string;
    actorId: string;
    requestHash: string;
    responseBody: unknown;
  },
): Promise<void> {
  const expiresAt = new Date(
    Date.now() + OPERATION_TTL_DAYS * 24 * 60 * 60 * 1000,
  );
  await db.insert(operations).values({
    operationId: args.operationId,
    actorId: args.actorId,
    requestHash: args.requestHash,
    responseBody: args.responseBody as Record<string, unknown>,
    expiresAt,
  });
}
