// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db/client.ts';
import { actors } from '../src/db/schema.ts';
import {
  expireStaleAgents,
  heartbeatAgent,
} from '../src/service/agent-lifecycle.ts';
import {
  FIXTURE_ACTOR_ID,
  FIXTURE_AGENT_ID,
  FIXTURE_AGENT_TOKEN,
  FIXTURE_TOKEN,
  buildTestApp,
  seedDbActor,
} from './setup.ts';

const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function bearerForToken(
  token: string,
  body: unknown,
  method = 'POST',
): RequestInit {
  return {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

async function fetchLifecycle(actorId: string): Promise<{
  lifecycleState: 'active' | 'inactive';
  lastHeartbeatAt: Date | null;
  deactivatedAt: Date | null;
  createdAt: Date;
}> {
  const [row] = await db
    .select({
      lifecycleState: actors.lifecycleState,
      lastHeartbeatAt: actors.lastHeartbeatAt,
      deactivatedAt: actors.deactivatedAt,
      createdAt: actors.createdAt,
    })
    .from(actors)
    .where(eq(actors.id, actorId))
    .limit(1);
  if (!row) throw new Error(`missing actor ${actorId}`);
  return row;
}

describe('agent heartbeat surface', () => {
  it('accepts HTTP self-heartbeat for an active agent and returns the actor envelope', async () => {
    const app = buildTestApp();

    const before = await fetchLifecycle(FIXTURE_AGENT_ID);
    expect(before.lastHeartbeatAt).toBeNull();

    const res = await app.fetch(
      new Request(
        `http://test/api/actors/${FIXTURE_AGENT_ID}/heartbeat`,
        bearerForToken(FIXTURE_AGENT_TOKEN, {}),
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      actor: Record<string, unknown>;
    };
    expect(body.actor).toMatchObject({
      id: FIXTURE_AGENT_ID,
      kind: 'agent',
    });
    expect(body.actor.created_at).toMatch(ISO_DATETIME_RE);
    expect(body.actor).not.toHaveProperty('lifecycle_state');
    expect(body.actor).not.toHaveProperty('last_heartbeat_at');
    expect(body.actor).not.toHaveProperty('deactivated_at');

    const after = await fetchLifecycle(FIXTURE_AGENT_ID);
    expect(after.lifecycleState).toBe('active');
    expect(after.lastHeartbeatAt).not.toBeNull();
    expect(after.deactivatedAt).toBeNull();
  });

  it('accepts MCP self-heartbeat with structuredContent/text parity', async () => {
    const app = buildTestApp();

    const res = await app.fetch(
      new Request(
        'http://test/mcp',
        bearerForToken(FIXTURE_AGENT_TOKEN, {
          jsonrpc: '2.0',
          id: 401,
          method: 'tools/call',
          params: {
            name: 'sprino.actor.heartbeat',
            arguments: { actor_id: FIXTURE_AGENT_ID },
          },
        }),
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        content: Array<{ type: string; text: string }>;
        structuredContent: { actor: Record<string, unknown> };
      };
    };
    expect(body.result.structuredContent.actor.id).toBe(FIXTURE_AGENT_ID);
    expect(body.result.structuredContent.actor.kind).toBe('agent');
    expect(body.result.structuredContent.actor).not.toHaveProperty(
      'lifecycle_state',
    );
    expect(body.result.content[0]?.text).toBe(
      JSON.stringify(body.result.structuredContent),
    );
  });

  it('rejects heartbeating another actor over HTTP and MCP', async () => {
    const app = buildTestApp();
    const other = await seedDbActor({
      displayName: 'Other Agent',
      kind: 'agent',
      agentRuntime: 'codex',
      parentActorId: FIXTURE_ACTOR_ID,
    });

    const httpRes = await app.fetch(
      new Request(
        `http://test/api/actors/${other.actorId}/heartbeat`,
        bearerForToken(FIXTURE_AGENT_TOKEN, {}),
      ),
    );
    expect(httpRes.status).toBe(403);
    const httpBody = (await httpRes.json()) as {
      _error: {
        code: string;
        details: { field: string; reason: string };
      };
    };
    expect(httpBody._error.code).toBe('forbidden');
    expect(httpBody._error.details).toMatchObject({
      field: 'actor_id',
      reason: 'Agents may heartbeat only themselves.',
    });

    const mcpRes = await app.fetch(
      new Request(
        'http://test/mcp',
        bearerForToken(FIXTURE_AGENT_TOKEN, {
          jsonrpc: '2.0',
          id: 402,
          method: 'tools/call',
          params: {
            name: 'sprino.actor.heartbeat',
            arguments: { actor_id: other.actorId },
          },
        }),
      ),
    );
    expect(mcpRes.status).toBe(200);
    const mcpBody = (await mcpRes.json()) as {
      error: {
        code: number;
        message: string;
        data: { actor_id: string; target_actor_id: string; reason: string };
      };
    };
    expect(mcpBody.error.code).toBe(-32003);
    expect(mcpBody.error.message).toBe('forbidden');
    expect(mcpBody.error.data).toMatchObject({
      actor_id: FIXTURE_AGENT_ID,
      target_actor_id: other.actorId,
      reason: 'actor_mismatch',
    });
  });

  it('rejects heartbeat for inactive agents with a stable adapter error contract', async () => {
    const app = buildTestApp();
    await db
      .update(actors)
      .set({ lifecycleState: 'inactive' })
      .where(eq(actors.id, FIXTURE_AGENT_ID));

    const httpRes = await app.fetch(
      new Request(
        `http://test/api/actors/${FIXTURE_AGENT_ID}/heartbeat`,
        bearerForToken(FIXTURE_AGENT_TOKEN, {}),
      ),
    );
    expect(httpRes.status).toBe(409);
    const httpBody = (await httpRes.json()) as {
      _error: {
        code: string;
        details: {
          field: string;
          reason: string;
        };
      };
    };
    expect(httpBody._error.code).toBe('invalid_lifecycle_transition');
    expect(httpBody._error.details).toMatchObject({
      field: 'actor_id',
      reason:
        'Agent lifecycle transition is not allowed from the current state.',
    });
  });
});

describe('agent expiry', () => {
  it('expires stale agents using created_at when no heartbeat has been observed', async () => {
    const stale = await seedDbActor({
      displayName: 'Stale Agent',
      kind: 'agent',
      agentRuntime: 'codex',
      parentActorId: FIXTURE_ACTOR_ID,
    });
    await db
      .update(actors)
      .set({
        createdAt: new Date('2026-04-29T09:00:00.000Z'),
      })
      .where(eq(actors.id, stale.actorId));

    const result = await expireStaleAgents(db, {
      cutoff: new Date('2026-04-29T09:30:00.000Z'),
      now: new Date('2026-04-29T10:00:00.000Z'),
    });

    expect(result.expired_actor_ids).toContain(stale.actorId);
    const lifecycle = await fetchLifecycle(stale.actorId);
    expect(lifecycle.lifecycleState).toBe('inactive');
    expect(lifecycle.lastHeartbeatAt).toBeNull();
    expect(lifecycle.deactivatedAt?.toISOString()).toBe(
      '2026-04-29T10:00:00.000Z',
    );
  });

  it('does not falsely expire active agents under normal heartbeat cadence', async () => {
    const now = new Date('2026-04-29T10:00:00.000Z');

    await heartbeatAgent(db, {
      req: { actor_id: FIXTURE_AGENT_ID },
      callerId: FIXTURE_AGENT_ID,
      now: new Date('2026-04-29T09:58:00.000Z'),
    });

    const result = await expireStaleAgents(db, {
      cutoff: new Date('2026-04-29T09:55:00.000Z'),
      now,
    });

    expect(result.expired_actor_ids).not.toContain(FIXTURE_AGENT_ID);
    expect(result.expired_count).toBe(0);
    const lifecycle = await fetchLifecycle(FIXTURE_AGENT_ID);
    expect(lifecycle.lifecycleState).toBe('active');
    expect(lifecycle.deactivatedAt).toBeNull();
  });

  it('preserves last heartbeat metadata and is idempotent across repeated cleanup runs', async () => {
    const stale = await seedDbActor({
      displayName: 'Stale With Heartbeat',
      kind: 'agent',
      agentRuntime: 'codex',
      parentActorId: FIXTURE_ACTOR_ID,
    });
    await db
      .update(actors)
      .set({
        lastHeartbeatAt: new Date('2026-04-29T09:00:00.000Z'),
      })
      .where(eq(actors.id, stale.actorId));

    const first = await expireStaleAgents(db, {
      cutoff: new Date('2026-04-29T09:30:00.000Z'),
      now: new Date('2026-04-29T10:00:00.000Z'),
    });
    expect(first.expired_actor_ids).toContain(stale.actorId);

    const afterFirst = await fetchLifecycle(stale.actorId);
    expect(afterFirst.lastHeartbeatAt?.toISOString()).toBe(
      '2026-04-29T09:00:00.000Z',
    );
    expect(afterFirst.deactivatedAt?.toISOString()).toBe(
      '2026-04-29T10:00:00.000Z',
    );

    const second = await expireStaleAgents(db, {
      cutoff: new Date('2026-04-29T09:45:00.000Z'),
      now: new Date('2026-04-29T10:05:00.000Z'),
    });
    expect(second.expired_actor_ids).not.toContain(stale.actorId);
    expect(second.expired_count).toBe(0);

    const afterSecond = await fetchLifecycle(stale.actorId);
    expect(afterSecond.deactivatedAt?.toISOString()).toBe(
      '2026-04-29T10:00:00.000Z',
    );
  });
});
