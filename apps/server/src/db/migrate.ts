/**
 * Drizzle migration runner. Run with:
 *   bun --filter '@sprino/server' db:migrate
 *
 * Reads SQL files from src/db/migrations/, applies in order, tracks state
 * in __drizzle_migrations__ table.
 *
 * After migrations apply, seeds:
 *   - SPRINO_ACTORS_JSON actors (idempotent ON CONFLICT DO NOTHING)
 *   - SPRINO_DEFAULT_PROJECT_ID project (idempotent)
 *
 * Seeding makes the first dev run "just work" without manual SQL.
 */

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { db, closeDb } from './client.ts';
import { actors, projects } from './schema.ts';

interface ActorEntry {
  id: string;
  kind: 'human' | 'agent';
  display_name: string;
  agent_runtime?: string | null;
  parent_actor_id?: string | null;
  // token is intentionally NOT persisted — it's a runtime auth secret.
}

interface ProjectEntry {
  id: string;
  slug: string;
  display_name: string;
  repo_path?: string | null;
}

async function seed(): Promise<void> {
  const json = process.env.SPRINO_ACTORS_JSON;
  const projectsJson = process.env.SPRINO_PROJECTS_JSON;
  const projectId = process.env.SPRINO_DEFAULT_PROJECT_ID;
  const projectSlug = process.env.SPRINO_DEFAULT_PROJECT_SLUG;

  if (json) {
    const parsed = JSON.parse(json) as ActorEntry[];
    for (const a of parsed) {
      await db
        .insert(actors)
        .values({
          id: a.id,
          kind: a.kind,
          displayName: a.display_name,
          agentRuntime: a.agent_runtime ?? null,
          parentActorId: a.parent_actor_id ?? null,
        })
        .onConflictDoNothing({ target: actors.id });
    }
    console.log(`Seeded ${parsed.length} actor(s) from SPRINO_ACTORS_JSON`);
  }

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
    await db
      .insert(projects)
      .values({
        id: projectId,
        slug: projectSlug,
        displayName: 'Sprino',
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

  await seed();

  await closeDb();
  console.log('Done.');
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
