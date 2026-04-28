/**
 * Singleton Postgres pool + Drizzle instance.
 *
 * Scripts (migrate.ts, cleanup-operations.ts) import `db` directly.
 * Hono app stores it on the app context so handlers reach it via c.var.db.
 */

import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is required');
}

export const pool = new pg.Pool({
  connectionString: url,
  max: 10,
});

export const db = drizzle(pool, { schema });
export type Db = typeof db;

export async function closeDb(): Promise<void> {
  await pool.end();
}
