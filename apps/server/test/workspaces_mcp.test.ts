// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * G1-P1/P2: MCP workspace resolution and management tests.
 *
 * Tests auto-resolution, ambiguity errors, explicit workspace_id,
 * the new workspace.list / workspace.get tools (G1-P1),
 * and workspace.create + member CRUD tools (G1-P2).
 */

import { describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../src/db/client.ts';
import { actors, actorTokens, workspaceMembers, workspacePlans } from '../src/db/schema.ts';
import { hashToken } from '../src/auth/registry.ts';
import {
  FIXTURE_ACTOR_ID,
  FIXTURE_TOKEN,
  FIXTURE_WORKSPACE_ID,
  buildTestApp,
  seedDbActor,
  seedWorkspace,
} from './setup.ts';

// ── helpers ────────────────────────────────────────────────────────────────

function mcpCall(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
}

async function seedActorWithNoWorkspace(): Promise<{ actorId: string; token: string }> {
  const actorId = uuidv7();
  const token = `test-no-ws-${crypto.randomUUID()}`;
  // Insert actor directly without enrolling in FIXTURE_WORKSPACE_ID
  await db.insert(actors).values({
    id: actorId,
    kind: 'human',
    role: 'admin',
    displayName: 'No Workspace Actor',
    agentRuntime: null,
    parentActorId: null,
    source: 'db',
  });
  await db.insert(actorTokens).values({
    id: uuidv7(),
    actorId,
    tokenHash: hashToken(token),
    source: 'db',
  });
  // Deliberately NOT inserting a workspace_members row
  return { actorId, token };
}

// ── describe blocks ────────────────────────────────────────────────────────

describe('MCP workspace resolution', () => {
  it('single-workspace actor: project.list auto-resolves workspace without workspace_id', async () => {
    const app = buildTestApp();
    const res = await app.fetch(
      mcpCall(FIXTURE_TOKEN, 'sprino.project.list', {}),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { structuredContent: { projects: unknown[] } };
      error?: { code: number; message: string };
    };
    // Should succeed (no error) — auto-resolved to FIXTURE_WORKSPACE_ID
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
    expect(Array.isArray(body.result!.structuredContent.projects)).toBe(true);
  });

  it('multi-workspace actor: project.list without workspace_id → -32003 workspace_id_required', async () => {
    const app = buildTestApp();
    // Add the fixture actor to a second workspace → now ambiguous
    const ws2 = await seedWorkspace({ slug: 'mcp-ws2-ambig' });
    await db.insert(workspaceMembers).values({
      workspaceId: ws2,
      actorId: FIXTURE_ACTOR_ID,
      role: 'member',
    });

    const res = await app.fetch(
      mcpCall(FIXTURE_TOKEN, 'sprino.project.list', {}),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      error?: { code: number; message: string; data?: { hint?: string } };
    };
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe(-32003);
    expect(body.error!.message).toBe('workspace_id_required');
    expect(typeof body.error!.data?.hint).toBe('string');
  });

  it('explicit workspace_id in args: uses that workspace', async () => {
    const app = buildTestApp();
    const res = await app.fetch(
      mcpCall(FIXTURE_TOKEN, 'sprino.project.list', {
        workspace_id: FIXTURE_WORKSPACE_ID,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { structuredContent: { projects: unknown[] } };
      error?: { code: number; message: string };
    };
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
    expect(Array.isArray(body.result!.structuredContent.projects)).toBe(true);
  });

  it('workspace_id actor is not a member of → -32003 workspace_not_found_or_not_member', async () => {
    const app = buildTestApp();
    const foreignWs = await seedWorkspace({ slug: 'mcp-foreign-ws' });
    // FIXTURE_ACTOR is NOT a member of foreignWs

    const res = await app.fetch(
      mcpCall(FIXTURE_TOKEN, 'sprino.project.list', {
        workspace_id: foreignWs,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      error?: { code: number; message: string };
    };
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe(-32003);
    expect(body.error!.message).toBe('workspace_not_found_or_not_member');
  });
});

describe('MCP sprino.workspace.list', () => {
  it('returns all workspaces the calling actor is a member of', async () => {
    const app = buildTestApp();
    const ws2 = await seedWorkspace({ slug: 'mcp-list-ws2' });
    await db.insert(workspaceMembers).values({
      workspaceId: ws2,
      actorId: FIXTURE_ACTOR_ID,
      role: 'member',
    });

    const res = await app.fetch(
      mcpCall(FIXTURE_TOKEN, 'sprino.workspace.list', {}),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { structuredContent: { workspaces: { id: string }[] } };
      error?: { code: number; message: string };
    };
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
    const ids = body.result!.structuredContent.workspaces.map((w) => w.id);
    expect(ids).toContain(FIXTURE_WORKSPACE_ID);
    expect(ids).toContain(ws2);
  });

  it('returns empty array when actor has no workspaces', async () => {
    const app = buildTestApp();
    const { token } = await seedActorWithNoWorkspace();

    const res = await app.fetch(
      mcpCall(token, 'sprino.workspace.list', {}),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { structuredContent: { workspaces: unknown[] } };
      error?: { code: number; message: string };
    };
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
    expect(body.result!.structuredContent.workspaces).toEqual([]);
  });
});

describe('MCP sprino.workspace.get', () => {
  it('returns workspace details for a workspace the actor is a member of', async () => {
    const app = buildTestApp();
    const res = await app.fetch(
      mcpCall(FIXTURE_TOKEN, 'sprino.workspace.get', {
        workspace_id: FIXTURE_WORKSPACE_ID,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { structuredContent: { workspace: { id: string; slug: string } } };
      error?: { code: number; message: string };
    };
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
    expect(body.result!.structuredContent.workspace.id).toBe(FIXTURE_WORKSPACE_ID);
    expect(body.result!.structuredContent.workspace.slug).toBe('default');
  });

  it('returns workspace_not_found_or_not_member for workspace actor is not in', async () => {
    const app = buildTestApp();
    const foreignWs = await seedWorkspace({ slug: 'mcp-get-foreign' });
    // FIXTURE_ACTOR is NOT a member of foreignWs

    const res = await app.fetch(
      mcpCall(FIXTURE_TOKEN, 'sprino.workspace.get', {
        workspace_id: foreignWs,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      error?: { code: number; message: string };
    };
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe(-32003);
    expect(body.error!.message).toBe('workspace_not_found_or_not_member');
  });
});

// ── G1-P2 tests ────────────────────────────────────────────────────────────

describe('MCP sprino.workspace.create', () => {
  it('creates a workspace and makes the calling actor an admin', async () => {
    const app = buildTestApp();
    const res = await app.fetch(
      mcpCall(FIXTURE_TOKEN, 'sprino.workspace.create', { name: 'Acme Corp', slug: 'acme-corp' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { structuredContent: { workspace: { id: string; name: string; slug: string; created_by: string } } };
      error?: { code: number; message: string };
    };
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
    const ws = body.result!.structuredContent.workspace;
    expect(ws.name).toBe('Acme Corp');
    expect(ws.slug).toBe('acme-corp');
    expect(ws.created_by).toBe(FIXTURE_ACTOR_ID);

    // Verify actor is now a member by calling sprino.workspace.list
    const listRes = await app.fetch(
      mcpCall(FIXTURE_TOKEN, 'sprino.workspace.list', {}),
    );
    const listBody = (await listRes.json()) as {
      result?: { structuredContent: { workspaces: { id: string; slug: string }[] } };
    };
    const workspaces = listBody.result!.structuredContent.workspaces;
    expect(workspaces.some((w) => w.slug === 'acme-corp')).toBe(true);
  });

  it('slug conflict → slug_conflict error', async () => {
    const app = buildTestApp();
    // Create first workspace
    await app.fetch(
      mcpCall(FIXTURE_TOKEN, 'sprino.workspace.create', { name: 'Acme', slug: 'acme-dup' }),
    );
    // Try to create second workspace with same slug
    const res2 = await app.fetch(
      mcpCall(FIXTURE_TOKEN, 'sprino.workspace.create', { name: 'Acme2', slug: 'acme-dup' }),
    );
    expect(res2.status).toBe(200);
    const body = (await res2.json()) as {
      error?: { code: number; message: string };
    };
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe(-32009);
    expect(body.error!.message).toBe('slug_conflict');
  });

  it('invalid slug pattern → invalid_params error', async () => {
    const app = buildTestApp();
    const res = await app.fetch(
      mcpCall(FIXTURE_TOKEN, 'sprino.workspace.create', { name: 'Acme', slug: 'UPPER_CASE' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      error?: { code: number; message: string };
    };
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe(-32602);
  });
});

describe('MCP sprino.workspace.member.list', () => {
  it('returns all members of a workspace the actor belongs to', async () => {
    const app = buildTestApp();
    // Create a fresh workspace via the API — actor becomes admin automatically
    const createRes = await app.fetch(
      mcpCall(FIXTURE_TOKEN, 'sprino.workspace.create', { name: 'Member List WS', slug: 'member-list-ws' }),
    );
    const createBody = (await createRes.json()) as {
      result?: { structuredContent: { workspace: { id: string } } };
    };
    const wsId = createBody.result!.structuredContent.workspace.id;

    const res = await app.fetch(
      mcpCall(FIXTURE_TOKEN, 'sprino.workspace.member.list', { workspace_id: wsId }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { structuredContent: { members: { workspace_id: string; actor_id: string; role: string; joined_at: string }[] } };
      error?: { code: number; message: string };
    };
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
    const members = body.result!.structuredContent.members;
    expect(Array.isArray(members)).toBe(true);
    expect(members.length).toBe(1);
    expect(members[0]!.actor_id).toBe(FIXTURE_ACTOR_ID);
    expect(members[0]!.role).toBe('admin');
    expect(members[0]!.workspace_id).toBe(wsId);
  });

  it('non-member cannot list members → workspace_not_found_or_not_member', async () => {
    const app = buildTestApp();
    // Create actor2 with its own token (not a member of the new workspace)
    const { token: token2 } = await seedDbActor({ displayName: 'Actor2 MemberList' });

    // Create workspace with fixture actor (actor1)
    const createRes = await app.fetch(
      mcpCall(FIXTURE_TOKEN, 'sprino.workspace.create', { name: 'Private WS', slug: 'private-member-list-ws' }),
    );
    const createBody = (await createRes.json()) as {
      result?: { structuredContent: { workspace: { id: string } } };
    };
    const wsId = createBody.result!.structuredContent.workspace.id;

    // actor2 tries to list members of wsId — not a member
    const res = await app.fetch(
      mcpCall(token2, 'sprino.workspace.member.list', { workspace_id: wsId }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      error?: { code: number; message: string };
    };
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe(-32003);
    expect(body.error!.message).toBe('workspace_not_found_or_not_member');
  });
});

describe('MCP sprino.workspace.member.add', () => {
  it('admin can add a new member', async () => {
    const app = buildTestApp();
    // Create workspace with fixture actor (becomes admin)
    const createRes = await app.fetch(
      mcpCall(FIXTURE_TOKEN, 'sprino.workspace.create', { name: 'Add Member WS', slug: 'add-member-ws' }),
    );
    const createBody = (await createRes.json()) as {
      result?: { structuredContent: { workspace: { id: string } } };
    };
    const wsId = createBody.result!.structuredContent.workspace.id;

    // Create actor2
    const { actorId: actorId2 } = await seedDbActor({ displayName: 'Actor2 AddMember' });

    // actor1 (admin) adds actor2
    const addRes = await app.fetch(
      mcpCall(FIXTURE_TOKEN, 'sprino.workspace.member.add', {
        workspace_id: wsId,
        actor_id: actorId2,
      }),
    );
    expect(addRes.status).toBe(200);
    const addBody = (await addRes.json()) as {
      result?: { structuredContent: { ok: boolean } };
      error?: { code: number; message: string };
    };
    expect(addBody.error).toBeUndefined();
    expect(addBody.result!.structuredContent.ok).toBe(true);

    // Verify: member.list now includes actor2
    const listRes = await app.fetch(
      mcpCall(FIXTURE_TOKEN, 'sprino.workspace.member.list', { workspace_id: wsId }),
    );
    const listBody = (await listRes.json()) as {
      result?: { structuredContent: { members: { actor_id: string }[] } };
    };
    const memberIds = listBody.result!.structuredContent.members.map((m) => m.actor_id);
    expect(memberIds).toContain(actorId2);
  });

  it('non-admin cannot add members → workspace_admin_required', async () => {
    const app = buildTestApp();
    // actor1 creates workspace (is admin)
    const createRes = await app.fetch(
      mcpCall(FIXTURE_TOKEN, 'sprino.workspace.create', { name: 'Admin Guard WS', slug: 'admin-guard-ws' }),
    );
    const createBody = (await createRes.json()) as {
      result?: { structuredContent: { workspace: { id: string } } };
    };
    const wsId = createBody.result!.structuredContent.workspace.id;

    // Create actor2 and add as regular member
    const { actorId: actorId2, token: token2 } = await seedDbActor({ displayName: 'Actor2 NonAdmin' });
    await app.fetch(
      mcpCall(FIXTURE_TOKEN, 'sprino.workspace.member.add', {
        workspace_id: wsId,
        actor_id: actorId2,
        role: 'member',
      }),
    );

    // Create actor3
    const { actorId: actorId3 } = await seedDbActor({ displayName: 'Actor3 Target' });

    // actor2 (non-admin member) tries to add actor3
    const res = await app.fetch(
      mcpCall(token2, 'sprino.workspace.member.add', {
        workspace_id: wsId,
        actor_id: actorId3,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      error?: { code: number; message: string };
    };
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe(-32003);
    expect(body.error!.message).toBe('workspace_admin_required');
  });

  it('exceeding max_members → entitlement_limit error', async () => {
    const app = buildTestApp();
    // Create workspace with fixture actor (becomes admin, 1 member)
    const createRes = await app.fetch(
      mcpCall(FIXTURE_TOKEN, 'sprino.workspace.create', { name: 'Max Members WS', slug: 'max-members-ws' }),
    );
    const createBody = (await createRes.json()) as {
      result?: { structuredContent: { workspace: { id: string } } };
    };
    const wsId = createBody.result!.structuredContent.workspace.id;

    // Insert a workspace_plans row with max_members = 1
    await db.insert(workspacePlans).values({
      workspaceId: wsId,
      plan: 'free',
      maxProjects: 10,
      maxMembers: 1,
      auditExportEnabled: false,
    }).onConflictDoUpdate({
      target: [workspacePlans.workspaceId],
      set: { maxMembers: 1 },
    });

    // Try to add actor2 — should fail with entitlement_limit
    const { actorId: actorId2 } = await seedDbActor({ displayName: 'Actor2 MaxMembers' });
    const res = await app.fetch(
      mcpCall(FIXTURE_TOKEN, 'sprino.workspace.member.add', {
        workspace_id: wsId,
        actor_id: actorId2,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      error?: { code: number; message: string };
    };
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe(-32003);
    expect(body.error!.message).toBe('entitlement_limit');
  });
});

describe('MCP sprino.workspace.member.remove', () => {
  it('admin can remove a member', async () => {
    const app = buildTestApp();
    // Create workspace with fixture actor (admin)
    const createRes = await app.fetch(
      mcpCall(FIXTURE_TOKEN, 'sprino.workspace.create', { name: 'Remove Member WS', slug: 'remove-member-ws' }),
    );
    const createBody = (await createRes.json()) as {
      result?: { structuredContent: { workspace: { id: string } } };
    };
    const wsId = createBody.result!.structuredContent.workspace.id;

    // Add actor2 as member
    const { actorId: actorId2 } = await seedDbActor({ displayName: 'Actor2 Remove' });
    await app.fetch(
      mcpCall(FIXTURE_TOKEN, 'sprino.workspace.member.add', {
        workspace_id: wsId,
        actor_id: actorId2,
      }),
    );

    // actor1 removes actor2
    const removeRes = await app.fetch(
      mcpCall(FIXTURE_TOKEN, 'sprino.workspace.member.remove', {
        workspace_id: wsId,
        actor_id: actorId2,
      }),
    );
    expect(removeRes.status).toBe(200);
    const removeBody = (await removeRes.json()) as {
      result?: { structuredContent: { ok: boolean } };
      error?: { code: number; message: string };
    };
    expect(removeBody.error).toBeUndefined();
    expect(removeBody.result!.structuredContent.ok).toBe(true);

    // Verify: member.list no longer includes actor2
    const listRes = await app.fetch(
      mcpCall(FIXTURE_TOKEN, 'sprino.workspace.member.list', { workspace_id: wsId }),
    );
    const listBody = (await listRes.json()) as {
      result?: { structuredContent: { members: { actor_id: string }[] } };
    };
    const memberIds = listBody.result!.structuredContent.members.map((m) => m.actor_id);
    expect(memberIds).not.toContain(actorId2);
  });

  it('cannot remove last admin → last_admin_protected', async () => {
    const app = buildTestApp();
    // Create workspace — fixture actor is the only admin
    const createRes = await app.fetch(
      mcpCall(FIXTURE_TOKEN, 'sprino.workspace.create', { name: 'Last Admin WS', slug: 'last-admin-ws' }),
    );
    const createBody = (await createRes.json()) as {
      result?: { structuredContent: { workspace: { id: string } } };
    };
    const wsId = createBody.result!.structuredContent.workspace.id;

    // Attempt to remove the only admin (self-removal)
    const res = await app.fetch(
      mcpCall(FIXTURE_TOKEN, 'sprino.workspace.member.remove', {
        workspace_id: wsId,
        actor_id: FIXTURE_ACTOR_ID,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      error?: { code: number; message: string };
    };
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe(-32009);
    expect(body.error!.message).toBe('last_admin_protected');
  });

  it('removing non-member → member_not_found', async () => {
    const app = buildTestApp();
    // Create workspace with fixture actor (admin)
    const createRes = await app.fetch(
      mcpCall(FIXTURE_TOKEN, 'sprino.workspace.create', { name: 'Non Member Remove WS', slug: 'non-member-remove-ws' }),
    );
    const createBody = (await createRes.json()) as {
      result?: { structuredContent: { workspace: { id: string } } };
    };
    const wsId = createBody.result!.structuredContent.workspace.id;

    // Create actor3 who was never added to the workspace
    const { actorId: actorId3 } = await seedDbActor({ displayName: 'Actor3 NonMember' });

    const res = await app.fetch(
      mcpCall(FIXTURE_TOKEN, 'sprino.workspace.member.remove', {
        workspace_id: wsId,
        actor_id: actorId3,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      error?: { code: number; message: string };
    };
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe(-32004);
    expect(body.error!.message).toBe('member_not_found');
  });
});
