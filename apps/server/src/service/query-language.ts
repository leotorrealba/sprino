// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — D5: structured filter validation + saved-view CRUD.

import { and, desc, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '../db/client.ts';
import { savedViews } from '../db/schema.ts';
import type { SavedViewRow } from '../db/schema.ts';
import {
  TaskFiltersSchema,
  type SavedView,
  type SavedViewCreateReq,
  type SavedViewCreateRes,
  type SavedViewListRes,
  type TaskFilters,
} from '../domain/index.ts';

export { TaskFiltersSchema };

export class SavedViewNotFoundError extends Error {
  constructor(public readonly viewId: string) {
    super(`saved view ${viewId} not found`);
    this.name = 'SavedViewNotFoundError';
  }
}

function rowToSavedView(r: SavedViewRow): SavedView {
  return {
    id: r.id,
    project_id: r.projectId,
    name: r.name,
    filters: r.filters as TaskFilters,
    created_by: r.createdBy,
    created_at: r.createdAt.toISOString(),
  };
}

export function validateFilters(raw: unknown): TaskFilters {
  return TaskFiltersSchema.parse(raw);
}

export async function createSavedView(
  db: Db,
  args: { req: SavedViewCreateReq; actorId: string },
): Promise<SavedViewCreateRes> {
  const id = uuidv7();
  await db.insert(savedViews).values({
    id,
    projectId: args.req.project_id,
    name: args.req.name,
    filters: args.req.filters,
    createdBy: args.actorId,
  });
  const rows = await db.select().from(savedViews).where(eq(savedViews.id, id));
  return { saved_view: rowToSavedView(rows[0]!) };
}

export async function listSavedViews(
  db: Db,
  projectId: string,
): Promise<SavedViewListRes> {
  const rows = await db
    .select()
    .from(savedViews)
    .where(eq(savedViews.projectId, projectId))
    .orderBy(desc(savedViews.createdAt));
  return { saved_views: rows.map(rowToSavedView) };
}

export async function getSavedView(
  db: Db,
  args: { viewId: string; projectId: string },
): Promise<SavedView> {
  const rows = await db
    .select()
    .from(savedViews)
    .where(and(eq(savedViews.id, args.viewId), eq(savedViews.projectId, args.projectId)));
  if (rows.length === 0) throw new SavedViewNotFoundError(args.viewId);
  return rowToSavedView(rows[0]!);
}

export async function deleteSavedView(
  db: Db,
  args: { viewId: string; projectId: string },
): Promise<void> {
  const rows = await db
    .select({ id: savedViews.id })
    .from(savedViews)
    .where(and(eq(savedViews.id, args.viewId), eq(savedViews.projectId, args.projectId)));
  if (rows.length === 0) throw new SavedViewNotFoundError(args.viewId);
  await db.delete(savedViews).where(eq(savedViews.id, args.viewId));
}
