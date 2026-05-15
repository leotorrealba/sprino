// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * G1-P1: MCP workspace resolution tests.
 *
 * Tests auto-resolution, ambiguity errors, explicit workspace_id,
 * and the new workspace.list / workspace.get tools.
 */

import { describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../src/db/client.ts';
import { actors, actorTokens, workspaceMembers } from '../src/db/schema.ts';
import { hashToken } from '../src/auth/registry.ts';
import {
  FIXTURE_ACTOR_ID,
  FIXTURE_TOKEN,
  FIXTURE_WORKSPACE_ID,
  buildTestApp,
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
