// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Projects service — implements the Tessera v0.0.2 project read surface.
 *
 * Adapters stay thin: they parse request shapes, then call this module for
 * ordering, row conversion, and project reference resolution.
 */

import { asc, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '../db/client.ts';
import { projects, workflowColumns, workflowTransitions } from '../db/schema.ts';
import type { ProjectRow } from '../db/schema.ts';
import type {
  Project,
  ProjectCreateReq,
  ProjectCreateRes,
  ProjectGetReq,
  ProjectGetRes,
  ProjectListRes,
} from '../domain/index.ts';
import {
  checkIdempotency,
  hashRequest,
  recordOperation,
} from './idempotency.ts';
import { assertProjectInWorkspace } from './authorization.ts';

type ProjectLookupRef = {
  project_id?: string | null;
  slug?: string | null;
  repo_path?: string | null;
};

export async function seedDefaultWorkflowColumns(
  db: Pick<Db, 'insert'>,
  projectId: string,
): Promise<void> {
  const backlogId = uuidv7();
  const inProgressId = uuidv7();
  const inReviewId = uuidv7();
  const doneId = uuidv7();
  const now = new Date();

  await db.insert(workflowColumns).values([
    { id: backlogId, projectId, name: 'Backlog', position: 0, mapsToStatus: 'todo', isDefault: true, createdAt: now },
    { id: inProgressId, projectId, name: 'In Progress', position: 1, mapsToStatus: 'doing', isDefault: false, createdAt: now },
    { id: inReviewId, projectId, name: 'In Review', position: 2, mapsToStatus: 'doing', isDefault: false, createdAt: now },
    { id: doneId, projectId, name: 'Done', position: 3, mapsToStatus: 'done', isDefault: false, createdAt: now },
  ]);

  await db.insert(workflowTransitions).values([
    { fromColumnId: backlogId, toColumnId: inProgressId },
    { fromColumnId: inProgressId, toColumnId: inReviewId },
    { fromColumnId: inReviewId, toColumnId: doneId },
    { fromColumnId: doneId, toColumnId: inProgressId },
  ]);
}

export class ProjectNotFoundError extends Error {
  constructor(public readonly ref: ProjectLookupRef) {
    super(`project not found for ${JSON.stringify(ref)}`);
    this.name = 'ProjectNotFoundError';
  }
}

export class ProjectSlugConflictError extends Error {
  constructor(public readonly slug: string) {
    super(`project slug '${slug}' is already taken`);
    this.name = 'ProjectSlugConflictError';
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

export async function listProjects(
  db: Db,
  { workspaceId }: { workspaceId: string },
): Promise<ProjectListRes> {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.workspaceId, workspaceId))
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
  args: { req: ProjectGetReq; workspaceId: string },
): Promise<ProjectGetRes> {
  const row = await resolveProject(db, {
    project_id: args.req.project_id,
    slug: args.req.slug,
    repo_path: args.req.repo_path,
  });
  await assertProjectInWorkspace(db, { projectId: row.id, workspaceId: args.workspaceId });
  return { project: rowToProject(row) };
}

/**
 * project.create — create a new project. Idempotent via operation_id.
 * Throws ProjectSlugConflictError if the slug is already taken.
 */
export async function createProject(
  db: Db,
  { req, actorId, workspaceId }: { req: ProjectCreateReq; actorId: string; workspaceId: string },
): Promise<ProjectCreateRes> {
  const requestHash = hashRequest(req);
  const cached = await checkIdempotency(db, req.operation_id, requestHash);
  if (cached !== null) return cached as ProjectCreateRes;

  // Pre-check slug uniqueness outside the transaction so the error is clean.
  const existing = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.slug, req.slug))
    .limit(1);
  if (existing[0]) throw new ProjectSlugConflictError(req.slug);

  const projectId = uuidv7();

  try {
    return await db.transaction(async (tx) => {
      await tx.insert(projects).values({
        id: projectId,
        slug: req.slug,
        displayName: req.display_name,
        repoPath: req.repo_path ?? null,
        workspaceId,
      });

      // Seed the four default workflow columns for this new project.
      await seedDefaultWorkflowColumns(tx, projectId);

      const [inserted] = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      const res: ProjectCreateRes = { project: rowToProject(inserted!) };
      await recordOperation(tx, {
        operationId: req.operation_id,
        actorId,
        requestHash,
        responseBody: res,
      });
      return res;
    });
  } catch (err) {
    // Idempotency re-check covers concurrent creates with the same operation_id.
    const raced = await checkIdempotency(db, req.operation_id, requestHash);
    if (raced !== null) return raced as ProjectCreateRes;
    // Unique-constraint violation from a concurrent create with a different
    // operation_id hitting the same slug → surface as a clean 409.
    if (
      err instanceof Error &&
      err.message.includes('unique') &&
      err.message.toLowerCase().includes('slug')
    ) {
      throw new ProjectSlugConflictError(req.slug);
    }
    throw err;
  }
}
