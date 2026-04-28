// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Stream 4C: end-to-end concurrency stress test for task.update_status.
 *
 * Complements events.test.ts (3B), which proved that 4 actors all racing
 * to the same target status select exactly one winner. This file pushes
 * harder on the 4C-specific guarantees:
 *
 *   - Each actor targets a DIFFERENT status (doing/done/blocked/todo) so
 *     the *content* of the winning write — not just the version bump — is
 *     observable.
 *   - Each actor uses a DISTINCT operation_id (fresh uuidv7) so the
 *     idempotency cache cannot short-circuit any of them; every actor
 *     truly contests the row.
 *   - The winner's actor_id is asserted on the resulting status_changed
 *     event (no torn writes; the event's actor must be the operation that
 *     actually committed).
 *   - Final task.status equals the winner's target (no last-write
 *     ambiguity).
 *   - Final task.version === 2 (incremented exactly once across all
 *     four contenders).
 *   - Total wall-clock runtime under 5s (per spec; serializing under
 *     Postgres SELECT ... FOR UPDATE must not deadlock or stall).
 *
 * Why service-level (not HTTP fetch): the auth registry binds tokens to
 * actors at module load and rotation requires a process restart, so
 * issuing four PATCH requests as four distinct actors at the HTTP layer
 * would require an in-process registry-mutation hack that adds nothing
 * the service layer can't already prove. The concurrency primitive lives
 * in service/tasks.ts, and that's where this test exercises it.
 */

import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it } from 'vitest';

import { db } from '../src/db/client.ts';
import { actors, tasks as tasksTable } from '../src/db/schema.ts';
import { eq } from 'drizzle-orm';
import {
  VersionMismatchError,
  createTask,
  updateTaskStatus,
} from '../src/service/tasks.ts';
import { listEvents } from '../src/service/events.ts';
import {
  FIXTURE_ACTOR_ID,
  FIXTURE_PROJECT_ID,
} from './setup.ts';

async function seedAgent(id: string, displayName: string): Promise<void> {
  await db.insert(actors).values({
    id,
    kind: 'agent',
    displayName,
    agentRuntime: 'test-runtime',
    parentActorId: FIXTURE_ACTOR_ID,
  });
}

async function createOneTask(): Promise<{ id: string; version: number }> {
  const res = await createTask(db, {
    req: {
      operation_id: uuidv7(),
      project_id: FIXTURE_PROJECT_ID,
      title: 'concurrency stress target',
    },
    actorId: FIXTURE_ACTOR_ID,
  });
  return { id: res.task.id, version: res.task.version };
}

describe('concurrency: 4 actors, 4 different target statuses', () => {
  it('selects exactly one winner; final state is consistent and runs <5s', async () => {
    // Seed 3 agent actors so each contender has a distinct actor_id.
    const agentIds = [
      '018c3e7a-0001-7000-8000-00000000c001',
      '018c3e7a-0001-7000-8000-00000000c002',
      '018c3e7a-0001-7000-8000-00000000c003',
    ] as const;
    await Promise.all(
      agentIds.map((id, i) => seedAgent(id, `Concurrency Agent ${i + 1}`)),
    );

    const allActorIds = [FIXTURE_ACTOR_ID, ...agentIds] as const;
    // Each actor targets a different status — per spec.
    const targetStatuses = ['doing', 'done', 'blocked', 'todo'] as const;

    const { id: taskId, version } = await createOneTask();
    expect(version).toBe(1);

    const t0 = performance.now();
    const results = await Promise.allSettled(
      allActorIds.map((actorId, i) =>
        updateTaskStatus(db, {
          req: {
            // Distinct operation_id per actor — idempotency cache must not
            // collapse any of these into a cached prior result.
            operation_id: uuidv7(),
            task_id: taskId,
            status: targetStatuses[i]!,
            if_match: 1,
          },
          actorId,
        }),
      ),
    );
    const elapsedMs = performance.now() - t0;

    // Spec: total runtime <5s. Postgres FOR UPDATE serializes the four
    // contenders, so this is a sanity check that the lock isn't held
    // longer than it should be (no missed COMMIT/ROLLBACK paths).
    expect(elapsedMs).toBeLessThan(5_000);

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof updateTaskStatus>>> =>
        r.status === 'fulfilled',
    );
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(3);

    // All three losers must fail with VersionMismatchError specifically —
    // not some unrelated failure (DB pool exhaustion, etc.).
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(VersionMismatchError);
    }

    const winnerIndex = results.findIndex((r) => r.status === 'fulfilled');
    expect(winnerIndex).toBeGreaterThanOrEqual(0);
    const winnerActorId = allActorIds[winnerIndex]!;
    const expectedWinnerStatus = targetStatuses[winnerIndex]!;

    // Identify the winner from the fulfilled result.
    const winnerResult = fulfilled[0]!.value;
    const winnerStatus = winnerResult.task.status;
    expect(winnerResult.task.version).toBe(2);
    expect(winnerStatus).toBe(expectedWinnerStatus);

    // Read the canonical task row from the DB — must match the winner.
    // (Defends against any test-only mutation that could mask a bug where
    // the in-memory return differs from the persisted row.)
    const [persistedTask] = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, taskId));
    expect(persistedTask).toBeDefined();
    expect(persistedTask!.version).toBe(2);
    expect(persistedTask!.status).toBe(winnerStatus);

    // Event log: only the winner's status_changed should be present
    // (losers throw VersionMismatchError before commit, so their event
    // rows roll back with the rest of the tx). Exactly 2 events total:
    // the original `created` plus the single winning `status_changed`.
    const { events: list } = await listEvents(db, {
      req: { project_id: FIXTURE_PROJECT_ID, task_id: taskId },
    });
    expect(list.length).toBe(2);

    const statusEvent = list.find((e) => e.kind === 'status_changed');
    expect(statusEvent).toBeDefined();
    // The event must be attributed to the actor whose write actually
    // committed — torn-write scenarios would assign it to a loser.
    expect(statusEvent!.actor_id).toBe(winnerActorId);
    expect(statusEvent!.task_id).toBe(taskId);

    const createdEvent = list.find((e) => e.kind === 'created');
    expect(createdEvent).toBeDefined();
    expect(createdEvent!.actor_id).toBe(FIXTURE_ACTOR_ID);
  });
});
