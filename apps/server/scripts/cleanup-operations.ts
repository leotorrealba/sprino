/**
 * Daily cron: prune expired idempotency records.
 *
 *   bun --filter '@sprino/server' cleanup-operations
 *
 * Tessera v0.0.1 retains operation rows for 30 days. After that the
 * `expires_at` column has passed and replays MUST 410 Gone. We delete
 * them in a single statement; the index on operations.expires_at keeps
 * this O(matched-rows).
 */

import { lt } from 'drizzle-orm';
import { db, closeDb } from '../src/db/client.ts';
import { operations } from '../src/db/schema.ts';

async function main(): Promise<void> {
  const cutoff = new Date();
  const result = await db
    .delete(operations)
    .where(lt(operations.expiresAt, cutoff))
    .returning({ operationId: operations.operationId });

  console.log(
    `Deleted ${result.length} expired operation row(s) (expires_at < ${cutoff.toISOString()})`,
  );

  await closeDb();
}

main().catch((err) => {
  console.error('cleanup-operations failed:', err);
  process.exit(1);
});
