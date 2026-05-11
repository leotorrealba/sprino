// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { db } from '../src/db/client.ts';
import { workspacePlans, workspaces } from '../src/db/schema.ts';
import {
  FREE_PLAN_DEFAULTS,
  getWorkspacePlan,
} from '../src/service/entitlements.ts';

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
});
