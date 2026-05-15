// SPDX-License-Identifier: AGPL-3.0-or-later
// D5-P1: query filter validation + saved-view CRUD tests
import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db/client.ts';
import { savedViews } from '../src/db/schema.ts';
import { eq } from 'drizzle-orm';
import {
  TaskFiltersSchema,
  validateFilters,
  createSavedView,
  listSavedViews,
  deleteSavedView,
  SavedViewNotFoundError,
} from '../src/service/query-language.ts';
import { listTasks, createTask } from '../src/service/tasks.ts';
import {
  FIXTURE_ACTOR_ID,
  FIXTURE_PROJECT_ID,
  FIXTURE_WORKSPACE_ID,
} from './setup.ts';

// ── TaskFiltersSchema validation ──────────────────────────────────────────────

describe('TaskFiltersSchema', () => {
  it('accepts a valid empty object', () => {
    expect(() => TaskFiltersSchema.parse({})).not.toThrow();
  });

  it('accepts valid status array', () => {
    const f = TaskFiltersSchema.parse({ status: ['todo', 'doing'] });
    expect(f.status).toEqual(['todo', 'doing']);
  });

  it('rejects title_contains over 200 chars', () => {
    expect(() =>
      TaskFiltersSchema.parse({ title_contains: 'x'.repeat(201) }),
    ).toThrow();
  });

  it('accepts title_contains up to 200 chars', () => {
    const f = TaskFiltersSchema.parse({ title_contains: 'x'.repeat(200) });
    expect(f.title_contains?.length).toBe(200);
  });

  it('rejects invalid status enum values', () => {
    expect(() => TaskFiltersSchema.parse({ status: ['nope'] })).toThrow();
  });
});

describe('validateFilters', () => {
  it('returns parsed filters', () => {
    const f = validateFilters({ status: ['todo'], title_contains: 'auth' });
    expect(f.status).toEqual(['todo']);
    expect(f.title_contains).toBe('auth');
  });

  it('throws ZodError on invalid input', () => {
    expect(() => validateFilters({ title_contains: 'x'.repeat(300) })).toThrow();
  });
});

// ── saved-view CRUD ───────────────────────────────────────────────────────────

describe('createSavedView + listSavedViews', () => {
  it('persists a view and returns it in list', async () => {
    const res = await createSavedView(db, {
      req: {
        project_id: FIXTURE_PROJECT_ID,
        name: 'My view',
        filters: { status: ['todo'] },
      },
      actorId: FIXTURE_ACTOR_ID,
    });
    expect(res.saved_view.name).toBe('My view');
    expect(res.saved_view.filters.status).toEqual(['todo']);

    const list = await listSavedViews(db, FIXTURE_PROJECT_ID);
    expect(list.saved_views.some((v) => v.id === res.saved_view.id)).toBe(true);
  });

  it('scopes views to the project', async () => {
    await createSavedView(db, {
      req: { project_id: FIXTURE_PROJECT_ID, name: 'Scoped', filters: {} },
      actorId: FIXTURE_ACTOR_ID,
    });
    const list = await listSavedViews(db, uuidv7()); // random project
    expect(list.saved_views).toHaveLength(0);
  });

  it('orders by created_at descending', async () => {
    await createSavedView(db, {
      req: { project_id: FIXTURE_PROJECT_ID, name: 'First', filters: {} },
      actorId: FIXTURE_ACTOR_ID,
    });
    await createSavedView(db, {
      req: { project_id: FIXTURE_PROJECT_ID, name: 'Second', filters: {} },
      actorId: FIXTURE_ACTOR_ID,
    });
    const list = await listSavedViews(db, FIXTURE_PROJECT_ID);
    expect(list.saved_views[0]!.name).toBe('Second');
  });
});

describe('deleteSavedView', () => {
  it('removes the row', async () => {
    const { saved_view } = await createSavedView(db, {
      req: { project_id: FIXTURE_PROJECT_ID, name: 'To delete', filters: {} },
      actorId: FIXTURE_ACTOR_ID,
    });
    await deleteSavedView(db, { viewId: saved_view.id, projectId: FIXTURE_PROJECT_ID });
    const rows = await db.select().from(savedViews).where(eq(savedViews.id, saved_view.id));
    expect(rows).toHaveLength(0);
  });

  it('throws SavedViewNotFoundError on missing id', async () => {
    await expect(
      deleteSavedView(db, { viewId: uuidv7(), projectId: FIXTURE_PROJECT_ID }),
    ).rejects.toBeInstanceOf(SavedViewNotFoundError);
  });

  it('throws SavedViewNotFoundError when project_id does not match', async () => {
    const { saved_view } = await createSavedView(db, {
      req: { project_id: FIXTURE_PROJECT_ID, name: 'Wrong project', filters: {} },
      actorId: FIXTURE_ACTOR_ID,
    });
    await expect(
      deleteSavedView(db, { viewId: saved_view.id, projectId: uuidv7() }),
    ).rejects.toBeInstanceOf(SavedViewNotFoundError);
  });
});

// ── listTasks filter extensions ───────────────────────────────────────────────

describe('listTasks — title_contains', () => {
  it('returns tasks whose title matches case-insensitively', async () => {
    await createTask(db, {
      req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'Auth flow design' },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });
    await createTask(db, {
      req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'Pagination bug fix' },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });

    const res = await listTasks(db, {
      req: { project_id: FIXTURE_PROJECT_ID, title_contains: 'auth' },
      workspaceId: FIXTURE_WORKSPACE_ID,
    });
    expect(res.tasks.every((t) => t.title.toLowerCase().includes('auth'))).toBe(true);
    expect(res.tasks.some((t) => t.title.includes('Auth'))).toBe(true);
  });

  it('returns empty array when no title matches', async () => {
    await createTask(db, {
      req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'Unrelated task' },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });
    const res = await listTasks(db, {
      req: { project_id: FIXTURE_PROJECT_ID, title_contains: 'zzznomatch' },
      workspaceId: FIXTURE_WORKSPACE_ID,
    });
    expect(res.tasks).toHaveLength(0);
  });
});

describe('listTasks — sprint_id', () => {
  it('returns only tasks assigned to the sprint', async () => {
    const { task: taskA } = await createTask(db, {
      req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'Sprint task' },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });
    await createTask(db, {
      req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'Not in sprint' },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });

    // Insert sprint + sprint_task directly
    const { sprints, sprintTasks } = await import('../src/db/schema.ts');
    const sprintId = uuidv7();
    await db.insert(sprints).values({
      id: sprintId,
      projectId: FIXTURE_PROJECT_ID,
      name: 'Sprint 1',
      status: 'planning',
      startsOn: '2026-06-01',
      endsOn: '2026-06-14',
      version: 1,
      createdBy: FIXTURE_ACTOR_ID,
    });
    await db.insert(sprintTasks).values({ sprintId, taskId: taskA.id });

    const res = await listTasks(db, {
      req: { project_id: FIXTURE_PROJECT_ID, sprint_id: sprintId },
      workspaceId: FIXTURE_WORKSPACE_ID,
    });
    expect(res.tasks).toHaveLength(1);
    expect(res.tasks[0]!.id).toBe(taskA.id);
  });
});
