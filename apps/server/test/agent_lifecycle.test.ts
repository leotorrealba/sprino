// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * B2 agent lifecycle storage and transition primitives.
 *
 * These tests pin both the additive database contract for lifecycle
 * persistence and the internal heartbeat/deactivate transition behavior
 * built on top of it.
 */

import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../src/db/client.ts';
import { actors } from '../src/db/schema.ts';
import {
  ActorRegisterReqSchema,
  ActorLifecycleStateSchema,
  AgentLifecycleTransitionIntentSchema,
} from '../src/domain/index.ts';
import {
  ActorLifecycleTransitionError,
  transitionAgentLifecycle,
} from '../src/service/actors.ts';
import { FIXTURE_ACTOR_ID } from './setup.ts';

const AGENT_REGISTER_FIELDS_REQUIRED =
  'Agent registration requires both `agent_runtime` and `parent_actor_id`.';

async function seedAgent(args: {
  lifecycleState?: 'active' | 'inactive';
  lastHeartbeatAt?: Date | null;
  deactivatedAt?: Date | null;
} = {}): Promise<string> {
  const actorId = uuidv7();
  await db.insert(actors).values({
    id: actorId,
    kind: 'agent',
    displayName: 'Lifecycle Agent',
    source: 'db',
    agentRuntime: 'claude-code',
    parentActorId: FIXTURE_ACTOR_ID,
    lifecycleState: args.lifecycleState ?? 'active',
    lastHeartbeatAt: args.lastHeartbeatAt,
    deactivatedAt: args.deactivatedAt,
  });
  return actorId;
}

async function fetchLifecycle(actorId: string): Promise<{
  lifecycleState: 'active' | 'inactive';
  lastHeartbeatAt: Date | null;
  deactivatedAt: Date | null;
}> {
  const [row] = await db
    .select({
      lifecycleState: actors.lifecycleState,
      lastHeartbeatAt: actors.lastHeartbeatAt,
      deactivatedAt: actors.deactivatedAt,
    })
    .from(actors)
    .where(eq(actors.id, actorId))
    .limit(1);
  if (!row) throw new Error(`missing actor ${actorId}`);
  return row;
}

describe('agent register request validation', () => {
  it('preserves the existing human actor.register request shape', () => {
    const req = {
      operation_id: '018c3e7a-0005-7000-8000-000000000010',
      display_name: 'Ada Lovelace',
      kind: 'human',
    };

    expect(ActorRegisterReqSchema.parse(req)).toEqual(req);
  });

  it('rejects human actor.register requests with agent-only fields', () => {
    const req = {
      operation_id: '018c3e7a-0005-7000-8000-000000000012',
      display_name: 'Ada Lovelace',
      kind: 'human',
      agent_runtime: 'claude-code',
      parent_actor_id: FIXTURE_ACTOR_ID,
    };

    const result = ActorRegisterReqSchema.safeParse(req);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        path: ['agent_runtime'],
        message: 'Agent-only fields are not accepted for human registration.',
      });
    }
  });

  it('accepts the agent actor.register request shape with runtime and parent actor', () => {
    const req = {
      operation_id: '018c3e7a-0005-7000-8000-000000000030',
      display_name: 'Claude Code (session)',
      kind: 'agent',
      agent_runtime: 'claude-code',
      parent_actor_id: FIXTURE_ACTOR_ID,
    };

    expect(ActorRegisterReqSchema.parse(req)).toEqual(req);
  });

  it('requires both agent fields when agent_runtime is missing', () => {
    const req = {
      operation_id: '018c3e7a-0005-7000-8000-000000000031',
      display_name: 'Claude Code (session)',
      kind: 'agent',
      parent_actor_id: FIXTURE_ACTOR_ID,
    };

    const result = ActorRegisterReqSchema.safeParse(req);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        path: ['agent_runtime'],
        message: AGENT_REGISTER_FIELDS_REQUIRED,
      });
    }
  });

  it('requires both agent fields when parent_actor_id is missing', () => {
    const req = {
      operation_id: '018c3e7a-0005-7000-8000-000000000032',
      display_name: 'Claude Code (session)',
      kind: 'agent',
      agent_runtime: 'claude-code',
    };

    const result = ActorRegisterReqSchema.safeParse(req);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        path: ['agent_runtime'],
        message: AGENT_REGISTER_FIELDS_REQUIRED,
      });
    }
  });

  it('requires parent_actor_id to be a UUID for agent actor.register requests', () => {
    const req = {
      operation_id: '018c3e7a-0005-7000-8000-000000000033',
      display_name: 'Claude Code (session)',
      kind: 'agent',
      agent_runtime: 'claude-code',
      parent_actor_id: 'not-a-uuid',
    };

    const result = ActorRegisterReqSchema.safeParse(req);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        path: ['parent_actor_id'],
      });
    }
  });

  it('normalizes non-string parent_actor_id validation errors', () => {
    const req = {
      operation_id: '018c3e7a-0005-7000-8000-000000000034',
      display_name: 'Claude Code (session)',
      kind: 'agent',
      agent_runtime: 'claude-code',
      parent_actor_id: 42,
    };

    const result = ActorRegisterReqSchema.safeParse(req);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        path: ['parent_actor_id'],
        message: 'Must be a string.',
      });
    }
  });
});

describe('agent lifecycle storage primitives', () => {
  it('pins the actor lifecycle enum values', async () => {
    const result = await db.execute<{ enumlabel: string }>(sql`
      select e.enumlabel
      from pg_type t
      join pg_enum e on e.enumtypid = t.oid
      where t.typname = 'actor_lifecycle_state'
      order by e.enumsortorder
    `);

    expect(result.rows.map((row) => row.enumlabel)).toEqual([
      'active',
      'inactive',
    ]);
  });

  it('pins lifecycle columns and explicit defaults', async () => {
    const result = await db.execute<{
      column_name: string;
      data_type: string;
      is_nullable: 'YES' | 'NO';
      column_default: string | null;
    }>(sql`
      select
        c.column_name,
        c.data_type,
        c.is_nullable,
        c.column_default
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = 'actors'
        and c.column_name in (
          'lifecycle_state',
          'last_heartbeat_at',
          'deactivated_at'
        )
      order by c.column_name
    `);

    expect(result.rows).toEqual([
      {
        column_name: 'deactivated_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'YES',
        column_default: null,
      },
      {
        column_name: 'last_heartbeat_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'YES',
        column_default: null,
      },
      {
        column_name: 'lifecycle_state',
        data_type: 'USER-DEFINED',
        is_nullable: 'NO',
        column_default: "'active'::actor_lifecycle_state",
      },
    ]);
  });

  it('defaults fresh agent sessions to active with no heartbeat or deactivation time', async () => {
    const actorId = uuidv7();
    const result = await db.execute<{
      id: string;
      lifecycle_state: string;
      last_heartbeat_at: Date | null;
      deactivated_at: Date | null;
    }>(sql`
      insert into actors (
        id,
        kind,
        display_name,
        source,
        agent_runtime,
        parent_actor_id
      )
      values (
        ${actorId},
        'agent',
        'Default Active Agent',
        'db',
        'claude-code',
        ${FIXTURE_ACTOR_ID}
      )
      returning id, lifecycle_state, last_heartbeat_at, deactivated_at
    `);

    expect(result.rows).toEqual([
      {
        id: actorId,
        lifecycle_state: 'active',
        last_heartbeat_at: null,
        deactivated_at: null,
      },
    ]);
  });

  it('documents the storage contract for null heartbeat and inactive state', async () => {
    const result = await db.execute<{
      column_name: string;
      column_default: string | null;
      is_nullable: 'YES' | 'NO';
    }>(sql`
      select column_name, column_default, is_nullable
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'actors'
        and column_name in ('last_heartbeat_at', 'deactivated_at')
      order by column_name
    `);

    expect(result.rows).toEqual([
      {
        column_name: 'deactivated_at',
        column_default: null,
        is_nullable: 'YES',
      },
      {
        column_name: 'last_heartbeat_at',
        column_default: null,
        is_nullable: 'YES',
      },
    ]);

    // B2-P1 intentionally persists only the active/not-active boundary.
    expect(actors.lifecycleState.enumValues).toEqual(['active', 'inactive']);
  });

  it('pins lifecycle indexes for state and agent liveness scans', async () => {
    const result = await db.execute<{
      indexname: string;
      indexdef: string;
    }>(sql`
      select indexname, indexdef
      from pg_indexes
      where schemaname = 'public'
        and tablename = 'actors'
        and indexname in (
          'actors_lifecycle_state_idx',
          'actors_agent_liveness_idx'
        )
      order by indexname
    `);

    expect(result.rows).toEqual([
      {
        indexname: 'actors_agent_liveness_idx',
        indexdef:
          'CREATE INDEX actors_agent_liveness_idx ON public.actors USING btree (kind, lifecycle_state, last_heartbeat_at)',
      },
      {
        indexname: 'actors_lifecycle_state_idx',
        indexdef:
          'CREATE INDEX actors_lifecycle_state_idx ON public.actors USING btree (lifecycle_state)',
      },
    ]);
  });

  it('exposes lifecycle fields in the Drizzle actor schema', () => {
    expect(actors.lifecycleState.name).toBe('lifecycle_state');
    expect(actors.lastHeartbeatAt.name).toBe('last_heartbeat_at');
    expect(actors.deactivatedAt.name).toBe('deactivated_at');
  });
});

describe('agent lifecycle domain and service transitions', () => {
  it('pins the internal lifecycle state and transition intent domains', () => {
    expect(ActorLifecycleStateSchema.options).toEqual(['active', 'inactive']);
    expect(AgentLifecycleTransitionIntentSchema.options).toEqual([
      'heartbeat',
      'deactivate',
    ]);
  });

  it('records heartbeat only for active agents without changing lifecycle state', async () => {
    const now = new Date('2026-04-29T12:00:00.000Z');
    const actorId = await seedAgent();

    const result = await transitionAgentLifecycle(db, {
      actorId,
      transition: 'heartbeat',
      now,
    });

    expect(result.actor).toMatchObject({
      id: actorId,
      kind: 'agent',
      agent_runtime: 'claude-code',
      parent_actor_id: FIXTURE_ACTOR_ID,
    });
    expect(await fetchLifecycle(actorId)).toEqual({
      lifecycleState: 'active',
      lastHeartbeatAt: now,
      deactivatedAt: null,
    });
  });

  it('deactivates an active agent while preserving heartbeat metadata', async () => {
    const lastHeartbeatAt = new Date('2026-04-29T11:55:00.000Z');
    const now = new Date('2026-04-29T12:00:00.000Z');
    const actorId = await seedAgent({ lastHeartbeatAt });

    const result = await transitionAgentLifecycle(db, {
      actorId,
      transition: 'deactivate',
      now,
    });

    expect(result.actor).toMatchObject({
      id: actorId,
      kind: 'agent',
      agent_runtime: 'claude-code',
      parent_actor_id: FIXTURE_ACTOR_ID,
    });
    expect(await fetchLifecycle(actorId)).toEqual({
      lifecycleState: 'inactive',
      lastHeartbeatAt,
      deactivatedAt: now,
    });
  });

  it('treats deactivation of an inactive agent as domain-idempotent', async () => {
    const firstDeactivatedAt = new Date('2026-04-29T11:00:00.000Z');
    const actorId = await seedAgent({
      lifecycleState: 'inactive',
      deactivatedAt: firstDeactivatedAt,
    });

    await transitionAgentLifecycle(db, {
      actorId,
      transition: 'deactivate',
      now: new Date('2026-04-29T12:00:00.000Z'),
    });

    expect(await fetchLifecycle(actorId)).toEqual({
      lifecycleState: 'inactive',
      lastHeartbeatAt: null,
      deactivatedAt: firstDeactivatedAt,
    });
  });

  it('rejects heartbeat for inactive agents with an explicit error contract', async () => {
    const actorId = await seedAgent({ lifecycleState: 'inactive' });

    await expect(
      transitionAgentLifecycle(db, {
        actorId,
        transition: 'heartbeat',
        now: new Date('2026-04-29T12:00:00.000Z'),
      }),
    ).rejects.toMatchObject({
      name: 'ActorLifecycleTransitionError',
      code: 'invalid_lifecycle_transition',
      actorId,
      transition: 'heartbeat',
      fromState: 'inactive',
      toState: 'active',
    });
  });

  it('rejects lifecycle transitions for human actors with an explicit error contract', async () => {
    await expect(
      transitionAgentLifecycle(db, {
        actorId: FIXTURE_ACTOR_ID,
        transition: 'deactivate',
        now: new Date('2026-04-29T12:00:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(ActorLifecycleTransitionError);
    await expect(
      transitionAgentLifecycle(db, {
        actorId: FIXTURE_ACTOR_ID,
        transition: 'deactivate',
        now: new Date('2026-04-29T12:00:00.000Z'),
      }),
    ).rejects.toMatchObject({
      name: 'ActorLifecycleTransitionError',
      code: 'actor_kind_not_agent',
      actorId: FIXTURE_ACTOR_ID,
      actorKind: 'human',
      transition: 'deactivate',
    });
  });
});
