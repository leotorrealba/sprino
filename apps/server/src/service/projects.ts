// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Projects service — implements the Tessera v0.0.2 project read surface.
 *
 * Adapters stay thin: they parse request shapes, then call this module for
 * ordering, row conversion, and project reference resolution.
 */

import { asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { projects } from '../db/schema.ts';
import type { ProjectRow } from '../db/schema.ts';
import type {
  Project,
  ProjectGetReq,
  ProjectGetRes,
  ProjectListRes,
} from '../domain/index.ts';

type ProjectLookupRef = {
  project_id?: string | null;
  slug?: string | null;
  repo_path?: string | null;
};

export class ProjectNotFoundError extends Error {
  constructor(public readonly ref: ProjectLookupRef) {
    super(`project not found for ${JSON.stringify(ref)}`);
    this.name = 'ProjectNotFoundError';
  }
}

function rowToProject(r: ProjectRow): Project {
  return {
    id: r.id,
    slug: r.slug,
    display_name: r.displayName,
    repo_path: r.repoPath,
    created_at: r.createdAt.toISOString(),
  };
}

function normalizeRepoPath(repoPath: string): string {
  const trimmed = repoPath.trim();
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
}

function repoMapProjectId(repoPath: string): string | null {
  const raw = process.env.SPRINO_REPO_PROJECT_MAP_JSON;
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        if (
          typeof e.repo_path === 'string' &&
          typeof e.project_id === 'string' &&
          normalizeRepoPath(e.repo_path) === repoPath
        ) {
          return e.project_id;
        }
      }
      return null;
    }

    if (parsed && typeof parsed === 'object') {
      const map = parsed as Record<string, unknown>;
      for (const [key, value] of Object.entries(map)) {
        if (normalizeRepoPath(key) === repoPath && typeof value === 'string') {
          return value;
        }
      }
    }
  } catch {
    return null;
  }

  return null;
}

export async function listProjects(db: Db): Promise<ProjectListRes> {
  const rows = await db
    .select()
    .from(projects)
    .orderBy(asc(projects.slug));

  return { projects: rows.map(rowToProject) };
}

export async function resolveProject(
  db: Db,
  ref: ProjectLookupRef,
): Promise<ProjectRow> {
  if (ref.project_id) {
    const rows = await db
      .select()
      .from(projects)
      .where(eq(projects.id, ref.project_id))
      .limit(1);
    const row = rows[0];
    if (row) return row;
  }

  if (ref.slug) {
    const rows = await db
      .select()
      .from(projects)
      .where(eq(projects.slug, ref.slug))
      .limit(1);
    const row = rows[0];
    if (row) return row;
  }

  if (ref.repo_path) {
    const repoPath = normalizeRepoPath(ref.repo_path);
    const mappedProjectId = repoMapProjectId(repoPath);
    if (mappedProjectId) {
      return await resolveProject(db, { project_id: mappedProjectId });
    }

    const rows = await db
      .select()
      .from(projects)
      .where(eq(projects.repoPath, repoPath))
      .limit(1);
    const row = rows[0];
    if (row) return row;
  }

  throw new ProjectNotFoundError(ref);
}

export async function getProject(
  db: Db,
  args: { req: ProjectGetReq },
): Promise<ProjectGetRes> {
  const row = await resolveProject(db, {
    project_id: args.req.project_id,
    slug: args.req.slug,
    repo_path: args.req.repo_path,
  });

  return { project: rowToProject(row) };
}
