// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from 'drizzle-orm';

import type { Db } from '../db/client.ts';
import { workspacePlans } from '../db/schema.ts';
import { PlanSchema, type WorkspacePlan } from '../domain/index.ts';

/** Stable sentinel when no DB row exists (no write on read — evaluation-only fallback). */
const FREE_PLAN_DEFAULT_UPDATED_AT = '1970-01-01T00:00:00.000Z';

/** Free-tier defaults when no `workspace_plans` row exists (explicit gating fallback). */
export const FREE_PLAN_DEFAULTS = {
  plan: 'free',
  max_projects: 3,
  max_members: 5,
  audit_export_enabled: false,
} satisfies Pick<
  WorkspacePlan,
  'plan' | 'max_projects' | 'max_members' | 'audit_export_enabled'
>;

function rowToWorkspacePlan(
  workspaceId: string,
  row: {
    workspaceId: string;
    plan: string;
    maxProjects: number;
    maxMembers: number;
    auditExportEnabled: boolean;
    updatedAt: Date;
  },
): WorkspacePlan {
  return {
    workspace_id: workspaceId,
    plan: PlanSchema.parse(row.plan),
    max_projects: row.maxProjects,
    max_members: row.maxMembers,
    audit_export_enabled: row.auditExportEnabled,
    updated_at: row.updatedAt.toISOString(),
  };
}

/** Read persisted workspace plan or return free-tier defaults (no INSERT / UPDATE). */
export async function getWorkspacePlan(
  db: Db,
  workspaceId: string,
): Promise<WorkspacePlan> {
  const rows = await db
    .select()
    .from(workspacePlans)
    .where(eq(workspacePlans.workspaceId, workspaceId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return {
      workspace_id: workspaceId,
      ...FREE_PLAN_DEFAULTS,
      updated_at: FREE_PLAN_DEFAULT_UPDATED_AT,
    };
  }

  return rowToWorkspacePlan(workspaceId, row);
}
