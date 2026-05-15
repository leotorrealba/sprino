// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';

import { db } from '../src/db/client.ts';
import { EntitlementLimitError } from '../src/domain/index.ts';
import { actors, workspaceMembers, workspacePlans, workspaces } from '../src/db/schema.ts';
import {
  FREE_PLAN_DEFAULTS,
  getWorkspacePlan,
} from '../src/service/entitlements.ts';
import { createProject } from '../src/service/projects.ts';
import { addWorkspaceMember } from '../src/service/workspaces.ts';

import { FIXTURE_WORKSPACE_ID, seedWorkspace } from './setup.ts';

describe('workspace entitlements', () => {
  it('getWorkspacePlan returns free defaults for workspace with no plan row', async () => {
    const orphanId = await seedWorkspace({
      slug: 'no-plan-ws',
    });

    const plan = await getWorkspacePlan(db, orphanId);
    expect(plan.workspace_id).toBe(orphanId);
    expect(plan.plan).toBe('free');
    expect(plan.max_projects).toBe(FREE_PLAN_DEFAULTS.max_projects);
    expect(plan.max_members).toBe(FREE_PLAN_DEFAULTS.max_members);
    expect(plan.audit_export_enabled).toBe(false);

    const rows = await db
      .select()
      .from(workspacePlans)
      .where(eq(workspacePlans.workspaceId, orphanId))
      .limit(1);
    expect(rows.length).toBe(0);
  });

  it('getWorkspacePlan returns persisted plan for workspace with explicit pro row', async () => {
    const wsId = await seedWorkspace({ slug: 'pro-ws' });

    await db.insert(workspacePlans).values({
      workspaceId: wsId,
      plan: 'pro',
      maxProjects: 25,
      maxMembers: 20,
      auditExportEnabled: true,
    });

    const plan = await getWorkspacePlan(db, wsId);
    expect(plan.plan).toBe('pro');
    expect(plan.max_projects).toBe(25);
    expect(plan.max_members).toBe(20);
    expect(plan.audit_export_enabled).toBe(true);
  });

  it('workspace_plans row is created on workspace insert (migration bootstrap)', async () => {
    await seedWorkspace({ slug: 'bootstrap-a' });
    await seedWorkspace({ slug: 'bootstrap-b' });

    const before = await db.select().from(workspacePlans);
    expect(before).toHaveLength(0);

    await db.execute(
      sql`
        INSERT INTO workspace_plans (workspace_id, plan, max_projects, max_members, audit_export_enabled)
        SELECT id, 'free', 3, 5, FALSE
        FROM workspaces
        ON CONFLICT (workspace_id) DO NOTHING
      `,
    );

    const workspacesRows = await db.select().from(workspaces);
    const planRows = await db.select().from(workspacePlans);

    expect(planRows).toHaveLength(workspacesRows.length);
    expect(new Set(planRows.map((p) => p.workspaceId))).toEqual(
      new Set(workspacesRows.map((w) => w.id)),
    );

    const defaultPlanRow = planRows.find(
      (r) => r.workspaceId === FIXTURE_WORKSPACE_ID,
    );
    expect(defaultPlanRow?.plan).toBe('free');
    expect(defaultPlanRow?.auditExportEnabled).toBe(false);
  });

  it('createProject throws EntitlementLimitError when workspace is at max_projects', async () => {
    const wsId = await seedWorkspace({ slug: 'gated-projects-ws' });
    await db.insert(workspacePlans).values({
      workspaceId: wsId,
      plan: 'free',
      maxProjects: 1,
      maxMembers: 5,
      auditExportEnabled: false,
    });

    const [actor] = await db.select().from(actors).limit(1);
    await db.insert(workspaceMembers).values({
      workspaceId: wsId,
      actorId: actor!.id,
      role: 'admin',
    });

    await createProject(db, {
      req: {
        operation_id: uuidv7(),
        slug: 'proj-one',
        display_name: 'Project One',
      },
      actorId: actor!.id,
      workspaceId: wsId,
    });

    await expect(
      createProject(db, {
        req: {
          operation_id: uuidv7(),
          slug: 'proj-two',
          display_name: 'Project Two',
        },
        actorId: actor!.id,
        workspaceId: wsId,
      }),
    ).rejects.toThrow(EntitlementLimitError);
  });

  it('addWorkspaceMember throws EntitlementLimitError when workspace is at max_members', async () => {
    const wsId = await seedWorkspace({ slug: 'gated-members-ws' });
    await db.insert(workspacePlans).values({
      workspaceId: wsId,
      plan: 'free',
      maxProjects: 3,
      maxMembers: 1,
      auditExportEnabled: false,
    });

    const [actor] = await db.select().from(actors).limit(1);
    await db.insert(workspaceMembers).values({
      workspaceId: wsId,
      actorId: actor!.id,
      role: 'admin',
    });

    const [actor2] = await db
      .insert(actors)
      .values({
        id: uuidv7(),
        kind: 'human',
        displayName: 'Test Actor 2',
      })
      .returning();

    await expect(
      addWorkspaceMember(db, {
        workspaceId: wsId,
        req: { actor_id: actor2!.id, role: 'member' },
        adminActorId: actor!.id,
      }),
    ).rejects.toThrow(EntitlementLimitError);
  });

  it('addWorkspaceMember allows role update for existing member even at max_members', async () => {
    const wsId = await seedWorkspace({ slug: 'gated-members-upsert-ws' });
    // max_members = 2 so we can have two admins without hitting the limit during setup
    await db.insert(workspacePlans).values({
      workspaceId: wsId,
      plan: 'free',
      maxProjects: 3,
      maxMembers: 2,
      auditExportEnabled: false,
    });

    const [actor] = await db.select().from(actors).limit(1);
    // Insert two admins — we need at least two so we can safely downgrade one.
    const [actor2] = await db
      .insert(actors)
      .values({
        id: uuidv7(),
        kind: 'human',
        displayName: 'Test Actor 2 Upsert',
      })
      .returning();
    await db.insert(workspaceMembers).values([
      { workspaceId: wsId, actorId: actor!.id, role: 'admin' },
      { workspaceId: wsId, actorId: actor2!.id, role: 'admin' },
    ]);

    // Tighten the limit to 2 (already at cap) — updating actor2's role should
    // bypass the seat count check because actor2 is already a member.
    await db.insert(workspacePlans).values({
      workspaceId: wsId,
      plan: 'free',
      maxProjects: 3,
      maxMembers: 2,
      auditExportEnabled: false,
    }).onConflictDoUpdate({
      target: [workspacePlans.workspaceId],
      set: { maxMembers: 2 },
    });

    // Downgrading actor2 (non-last admin) to member must succeed even though
    // the workspace is at max_members — no new seat is consumed.
    await expect(
      addWorkspaceMember(db, {
        workspaceId: wsId,
        req: { actor_id: actor2!.id, role: 'member' },
        adminActorId: actor!.id,
      }),
    ).resolves.toBeUndefined();
  });
});
