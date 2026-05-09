// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { db } from '../src/db/client.ts';
import { workspaceMembers } from '../src/db/schema.ts';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import {
  FIXTURE_ACTOR_ID,
  FIXTURE_PROJECT_ID,
  FIXTURE_TOKEN,
  FIXTURE_WORKSPACE_ID,
  buildTestApp,
  seedDbActor,
  seedWorkspace,
} from './setup.ts';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const withWs = (token: string, wsId: string) => ({
  authorization: `Bearer ${token}`,
  'x-workspace-id': wsId,
});

describe('workspace management', () => {
  it('createWorkspace round-trip: created workspace listed for creator', async () => {
    const app = buildTestApp();
    const r = await app.fetch(
      new Request('http://test/api/workspaces', {
        method: 'POST',
        headers: { ...auth(FIXTURE_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Acme Corp', slug: 'acme' }),
      }),
    );
    expect(r.status).toBe(201);
    const body = await r.json() as { workspace: { id: string; slug: string } };
    expect(body.workspace.slug).toBe('acme');

    const listR = await app.fetch(
      new Request('http://test/api/workspaces', {
        headers: auth(FIXTURE_TOKEN),
      }),
    );
    expect(listR.status).toBe(200);
    const listBody = await listR.json() as { workspaces: { id: string }[] };
    expect(listBody.workspaces.map((w) => w.id)).toContain(body.workspace.id);
  });

  it('createWorkspace returns 409 on duplicate slug', async () => {
    const app = buildTestApp();
    const body = JSON.stringify({ name: 'Dup', slug: 'dup-slug' });
    const headers = { ...auth(FIXTURE_TOKEN), 'content-type': 'application/json' };
    await app.fetch(new Request('http://test/api/workspaces', { method: 'POST', headers, body }));
    const r2 = await app.fetch(new Request('http://test/api/workspaces', { method: 'POST', headers, body }));
    expect(r2.status).toBe(409);
  });

  it('listWorkspacesForActor returns only actor-member workspaces', async () => {
    const app = buildTestApp();
    const otherId = await seedWorkspace({ slug: 'other-ws' });

    const r = await app.fetch(
      new Request('http://test/api/workspaces', { headers: auth(FIXTURE_TOKEN) }),
    );
    const listBody = await r.json() as { workspaces: { id: string }[] };
    expect(listBody.workspaces.map((w) => w.id)).toContain(FIXTURE_WORKSPACE_ID);
    expect(listBody.workspaces.map((w) => w.id)).not.toContain(otherId);
  });
});

describe('workspace membership management', () => {
  it('admin can add a member → member appears in list', async () => {
    const app = buildTestApp();
    const { actorId } = await seedDbActor({ displayName: 'New Guy', kind: 'human' });

    const addR = await app.fetch(
      new Request(`http://test/api/workspaces/${FIXTURE_WORKSPACE_ID}/members`, {
        method: 'POST',
        headers: { ...withWs(FIXTURE_TOKEN, FIXTURE_WORKSPACE_ID), 'content-type': 'application/json' },
        body: JSON.stringify({ actor_id: actorId, role: 'member' }),
      }),
    );
    expect(addR.status).toBe(201);

    const listR = await app.fetch(
      new Request(`http://test/api/workspaces/${FIXTURE_WORKSPACE_ID}/members`, {
        headers: withWs(FIXTURE_TOKEN, FIXTURE_WORKSPACE_ID),
      }),
    );
    const listBody = await listR.json() as { members: { actor_id: string }[] };
    expect(listBody.members.map((m) => m.actor_id)).toContain(actorId);
  });

  it('admin can remove a member', async () => {
    const app = buildTestApp();
    const { actorId } = await seedDbActor({ displayName: 'To Remove', kind: 'human' });

    // Confirm they're a member
    const preList = await app.fetch(
      new Request(`http://test/api/workspaces/${FIXTURE_WORKSPACE_ID}/members`, {
        headers: withWs(FIXTURE_TOKEN, FIXTURE_WORKSPACE_ID),
      }),
    );
    const prebody = await preList.json() as { members: { actor_id: string }[] };
    expect(prebody.members.map((m) => m.actor_id)).toContain(actorId);

    const delR = await app.fetch(
      new Request(`http://test/api/workspaces/${FIXTURE_WORKSPACE_ID}/members/${actorId}`, {
        method: 'DELETE',
        headers: withWs(FIXTURE_TOKEN, FIXTURE_WORKSPACE_ID),
      }),
    );
    expect(delR.status).toBe(204);
  });

  it('non-admin workspace member cannot add members → 403', async () => {
    const app = buildTestApp();
    const { token: memberToken } = await seedDbActor({
      displayName: 'Just A Member',
      kind: 'human',
      role: 'member',
    });

    // Force the seeded actor to have 'member' workspace role
    const [memberRow] = await db
      .select({ actorId: workspaceMembers.actorId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, FIXTURE_WORKSPACE_ID))
      .orderBy(workspaceMembers.actorId);
    // The last inserted actor should have role='member' from seedDbActor
    // Try to add a random actor — should be forbidden
    const r = await app.fetch(
      new Request(`http://test/api/workspaces/${FIXTURE_WORKSPACE_ID}/members`, {
        method: 'POST',
        headers: { ...withWs(memberToken, FIXTURE_WORKSPACE_ID), 'content-type': 'application/json' },
        body: JSON.stringify({ actor_id: uuidv7() }),
      }),
    );
    expect(r.status).toBe(403);
  });
});

describe('workspace isolation', () => {
  it('project in workspace A returns 403 for actor scoped to workspace B', async () => {
    const app = buildTestApp();
    const wsB = await seedWorkspace({ slug: 'ws-b-iso' });
    const { actorId, token: tokenB } = await seedDbActor({ displayName: 'Actor B', kind: 'human' });
    await db.insert(workspaceMembers).values({ workspaceId: wsB, actorId, role: 'admin' });

    const r = await app.fetch(
      new Request(`http://test/api/projects/${FIXTURE_PROJECT_ID}`, {
        headers: withWs(tokenB, wsB),
      }),
    );
    expect(r.status).toBe(403);
  });

  it('task creation in wrong workspace → 403', async () => {
    const app = buildTestApp();
    const wsB = await seedWorkspace({ slug: 'ws-b-task' });
    const { actorId, token: tokenB } = await seedDbActor({ displayName: 'Actor B2', kind: 'human' });
    await db.insert(workspaceMembers).values({ workspaceId: wsB, actorId, role: 'admin' });

    const r = await app.fetch(
      new Request('http://test/api/tasks', {
        method: 'POST',
        headers: { ...withWs(tokenB, wsB), 'content-type': 'application/json' },
        body: JSON.stringify({
          operation_id: uuidv7(),
          project_id: FIXTURE_PROJECT_ID,
          title: 'Cross-workspace task',
        }),
      }),
    );
    expect(r.status).toBe(403);
  });

  it('task listing in wrong workspace → 403', async () => {
    const app = buildTestApp();
    const wsB = await seedWorkspace({ slug: 'ws-b-list' });
    const { actorId, token: tokenB } = await seedDbActor({ displayName: 'Actor B3', kind: 'human' });
    await db.insert(workspaceMembers).values({ workspaceId: wsB, actorId, role: 'admin' });

    const r = await app.fetch(
      new Request(`http://test/api/tasks?project_id=${FIXTURE_PROJECT_ID}`, {
        headers: withWs(tokenB, wsB),
      }),
    );
    expect(r.status).toBe(403);
  });

  it('default workspace: single-actor auto-selects without X-Workspace-ID header', async () => {
    const app = buildTestApp();
    const r = await app.fetch(
      new Request(`http://test/api/projects/${FIXTURE_PROJECT_ID}`, {
        headers: auth(FIXTURE_TOKEN),
      }),
    );
    expect(r.status).toBe(200);
  });

  it('actor with 2+ workspaces and no header → 400 workspace_id_required', async () => {
    const app = buildTestApp();
    const ws2 = await seedWorkspace({ slug: 'second-ws-test' });
    await db.insert(workspaceMembers).values({
      workspaceId: ws2,
      actorId: FIXTURE_ACTOR_ID,
      role: 'member',
    });

    const r = await app.fetch(
      new Request('http://test/api/projects', {
        headers: auth(FIXTURE_TOKEN),
      }),
    );
    expect(r.status).toBe(400);
    const body = await r.json() as { error: string };
    expect(body.error).toBe('workspace_id_required');
  });
});
