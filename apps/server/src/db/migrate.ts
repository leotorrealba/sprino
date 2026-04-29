// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Drizzle migration runner. Run with:
 *   bun --filter '@sprino/server' db:migrate
 *
 * Reads SQL files from src/db/migrations/, applies in order, tracks state
 * in __drizzle_migrations__ table.
 *
 * After migrations apply, seeds:
 *   - SPRINO_ACTORS_JSON via db/seed.ts (idempotent UPSERT into actors +
 *     actor_tokens with source='env'; tokens stored as sha256 hashes only).
 *   - SPRINO_DEFAULT_PROJECT_ID / SPRINO_PROJECTS_JSON projects.
 *
 * Seeding makes the first dev run "just work" without manual SQL.
 */

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, or } from 'drizzle-orm';
import { db, closeDb } from './client.ts';
import { projects } from './schema.ts';
import { seedFromEnv } from './seed.ts';
import type { Db } from './client.ts';

interface ProjectEntry {
  id: string;
  slug: string;
  display_name: string;
  repo_path?: string | null;
}

type ProjectSeedEnv = Record<string, string | undefined>;

async function upsertSeedProject(
  db: Db,
  entry: ProjectEntry,
): Promise<void> {
  const existing = await db
    .select()
    .from(projects)
    .where(or(eq(projects.id, entry.id), eq(projects.slug, entry.slug)))
    .limit(1);

  const row = existing[0];
  if (!row) {
    await db.insert(projects).values({
      id: entry.id,
      slug: entry.slug,
      displayName: entry.display_name,
      repoPath: entry.repo_path ?? null,
    });
    return;
  }

  await db
    .update(projects)
    .set({
      slug: entry.slug,
      displayName: entry.display_name,
      repoPath: entry.repo_path ?? null,
    })
    .where(eq(projects.id, row.id));
}

export async function seedProjects(
  db: Db,
  env: ProjectSeedEnv = process.env,
): Promise<void> {
  const projectsJson = env.SPRINO_PROJECTS_JSON;
  const projectId = env.SPRINO_DEFAULT_PROJECT_ID;
  const projectSlug = env.SPRINO_DEFAULT_PROJECT_SLUG;

  if (projectsJson) {
    const parsed = JSON.parse(projectsJson) as ProjectEntry[];
    for (const p of parsed) {
      await upsertSeedProject(db, p);
    }
    console.log(`Seeded ${parsed.length} project(s) from SPRINO_PROJECTS_JSON`);
  } else if (projectId && projectSlug) {
    const displayName =
      env.SPRINO_DEFAULT_PROJECT_DISPLAY_NAME?.trim() || 'Sprino';
    await upsertSeedProject(db, {
      id: projectId,
      slug: projectSlug,
      display_name: displayName,
      repo_path: null,
    });
    console.log(`Seeded default project: ${projectSlug} (${projectId})`);
  }
}

async function main(): Promise<void> {
  console.log('Running migrations...');
  await migrate(db, { migrationsFolder: './src/db/migrations' });
  console.log('Migrations applied.');

  const result = await seedFromEnv(db);
  console.log(
    `Seeded actors: imported=${result.importedActors} new_tokens=${result.newTokens} revoked_removed=${result.revokedRemoved}`,
  );

  await seedProjects(db);

  await closeDb();
  console.log('Done.');
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
