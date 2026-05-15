// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * E2-P1: Audit event enrichment — governance fields on read/write paths.
 */

import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db/client.ts';
import { createTask } from '../src/service/tasks.ts';
import { listEvents } from '../src/service/events.ts';
import {
  FIXTURE_ACTOR_ID,
  FIXTURE_PROJECT_ID,
  FIXTURE_WORKSPACE_ID,
} from './setup.ts';

describe('audit: event enrichment (E2-P1)', () => {
  it('listEvents includes workspace_id matching project workspace', async () => {
    const res = await createTask(db, {
      req: {
        operation_id: uuidv7(),
        project_id: FIXTURE_PROJECT_ID,
        title: 'audit workspace trace',
      },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });

    const { events } = await listEvents(db, {
      req: { project_id: FIXTURE_PROJECT_ID, task_id: res.task.id },
    });

    expect(events.length).toBeGreaterThanOrEqual(1);
    for (const e of events) {
      expect(e.workspace_id).toBe(FIXTURE_WORKSPACE_ID);
    }
  });

  it('createTask event payload has no _governance wrapper (workspace_id is a top-level event field, not in payload)', async () => {
    const res = await createTask(db, {
      req: {
        operation_id: uuidv7(),
        project_id: FIXTURE_PROJECT_ID,
        title: 'audit governance envelope',
      },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });

    expect(res.event.kind).toBe('created');
    // workspace_id must NOT be embedded in the Tessera payload (protocol contract).
    // It is surfaced as a top-level field on EventWithActor via listEvents.
    expect(res.event.payload._governance).toBeUndefined();

    // Verify workspace_id is accessible via the read path (listEvents JOIN).
    const { events } = await listEvents(db, {
      req: { project_id: FIXTURE_PROJECT_ID, task_id: res.task.id },
    });
    const created = events.find((e) => e.id === res.event.id);
    expect(created).toBeDefined();
    expect(created?.workspace_id).toBe(FIXTURE_WORKSPACE_ID);
  });
});
