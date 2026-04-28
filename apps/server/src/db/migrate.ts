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
import { db, closeDb } from './client.ts';
import { projects } from './schema.ts';
import { seedFromEnv } from './seed.ts';

interface ProjectEntry {
  id: string;
  slug: string;
  display_name: string;
  repo_path?: string | null;
}

async function seedProjects(): Promise<void> {
  const projectsJson = process.env.SPRINO_PROJECTS_JSON;
  const projectId = process.env.SPRINO_DEFAULT_PROJECT_ID;
  const projectSlug = process.env.SPRINO_DEFAULT_PROJECT_SLUG;

  if (projectsJson) {
    const parsed = JSON.parse(projectsJson) as ProjectEntry[];
    for (const p of parsed) {
      await db
        .insert(projects)
        .values({
          id: p.id,
          slug: p.slug,
          displayName: p.display_name,
          repoPath: p.repo_path ?? null,
        })
        .onConflictDoUpdate({
          target: projects.id,
          set: {
            slug: p.slug,
            displayName: p.display_name,
            repoPath: p.repo_path ?? null,
          },
        });
    }
    console.log(`Seeded ${parsed.length} project(s) from SPRINO_PROJECTS_JSON`);
  } else if (projectId && projectSlug) {
    const displayName =
      process.env.SPRINO_DEFAULT_PROJECT_DISPLAY_NAME?.trim() || 'Sprino';
    await db
      .insert(projects)
      .values({
        id: projectId,
        slug: projectSlug,
        displayName,
        repoPath: null,
      })
      .onConflictDoNothing({ target: projects.id });
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

  await seedProjects();

  await closeDb();
  console.log('Done.');
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
