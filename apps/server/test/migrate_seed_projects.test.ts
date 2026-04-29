// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db/client.ts';
import { seedProjects } from '../src/db/migrate.ts';
import { projects } from '../src/db/schema.ts';
import {
  FIXTURE_PROJECT_ID,
  FIXTURE_PROJECT_SLUG,
} from './setup.ts';

describe('project seed merge strategy', () => {
  it('merges a slug collision with a changed incoming id without boot failure', async () => {
    await expect(
      seedProjects(db, {
        SPRINO_PROJECTS_JSON: JSON.stringify([
          {
            id: '018c3e7a-0002-7000-8000-000000000099',
            slug: FIXTURE_PROJECT_SLUG,
            display_name: 'Sprino Renamed',
            repo_path: '/tmp/sprino',
          },
        ]),
      }),
    ).resolves.toBeUndefined();

    const rows = await db.select().from(projects).where(eq(projects.slug, FIXTURE_PROJECT_SLUG));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(FIXTURE_PROJECT_ID);
    expect(rows[0]!.displayName).toBe('Sprino Renamed');
    expect(rows[0]!.repoPath).toBe('/tmp/sprino');
  });

  it('is deterministic across repeated runs on a non-empty database', async () => {
    const env = {
      SPRINO_PROJECTS_JSON: JSON.stringify([
        {
          id: '018c3e7a-0002-7000-8000-000000000099',
          slug: FIXTURE_PROJECT_SLUG,
          display_name: 'Sprino Renamed Again',
          repo_path: '/tmp/sprino-again',
        },
      ]),
    };

    await seedProjects(db, env);
    await seedProjects(db, env);

    const rows = await db.select().from(projects).where(eq(projects.slug, FIXTURE_PROJECT_SLUG));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(FIXTURE_PROJECT_ID);
    expect(rows[0]!.displayName).toBe('Sprino Renamed Again');
    expect(rows[0]!.repoPath).toBe('/tmp/sprino-again');
  });
});
