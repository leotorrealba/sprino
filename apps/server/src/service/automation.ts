// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — D5: automation rule CRUD + bounded rule engine.
//
// Dependency note: this module writes task mutations (UPDATE tasks + INSERT events)
// directly via Drizzle instead of calling service/tasks.ts, to keep the
// dependency graph acyclic (tasks.ts → automation.ts, never the reverse).
//
// Chaining: applyAutomationRules is called with depth=0 from tasks.ts.
// Rule-triggered mutations pass depth=1 back into applyAutomationRules,
// which returns immediately — one level of chaining max.

import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '../db/client.ts';
import { automationRules, events, tasks } from '../db/schema.ts';
import type { AutomationRuleRow } from '../db/schema.ts';
import {
  type AutomationRule,
  type AutomationRuleCreateReq,
  type AutomationRuleCreateRes,
  type AutomationRuleListRes,
} from '../domain/index.ts';

// Type that works for both direct db and transactions
type DbLike = Pick<Db, 'select' | 'insert' | 'update' | 'delete'>;

export class AutomationRuleNotFoundError extends Error {
  constructor(public readonly ruleId: string) {
    super(`automation rule ${ruleId} not found`);
    this.name = 'AutomationRuleNotFoundError';
  }
}

function rowToRule(r: AutomationRuleRow): AutomationRule {
  return {
    id: r.id,
    project_id: r.projectId,
    name: r.name,
    trigger_field: r.triggerField as 'status' | 'assignee_id',
    trigger_value: r.triggerValue,
    action_field: r.actionField as 'status' | 'assignee_id',
    action_value: r.actionValue,
    is_active: r.isActive,
    created_by: r.createdBy,
    created_at: r.createdAt.toISOString(),
  };
}

export async function createAutomationRule(
  db: DbLike,
  args: { req: AutomationRuleCreateReq; actorId: string },
): Promise<AutomationRuleCreateRes> {
  const id = uuidv7();
  await db.insert(automationRules).values({
    id,
    projectId: args.req.project_id,
    name: args.req.name,
    triggerField: args.req.trigger_field,
    triggerValue: args.req.trigger_value ?? null,
    actionField: args.req.action_field,
    actionValue: args.req.action_value ?? null,
    isActive: true,
    createdBy: args.actorId,
  });
  const rows = await db.select().from(automationRules).where(eq(automationRules.id, id));
  return { automation_rule: rowToRule(rows[0]!) };
}

export async function listAutomationRules(
  db: DbLike,
  projectId: string,
): Promise<AutomationRuleListRes> {
  const rows = await db
    .select()
    .from(automationRules)
    .where(eq(automationRules.projectId, projectId));
  return { automation_rules: rows.map(rowToRule) };
}

export async function deleteAutomationRule(
  db: DbLike,
  args: { ruleId: string; projectId: string },
): Promise<void> {
  const rows = await db
    .select({ id: automationRules.id })
    .from(automationRules)
    .where(and(eq(automationRules.id, args.ruleId), eq(automationRules.projectId, args.projectId)));
  if (rows.length === 0) throw new AutomationRuleNotFoundError(args.ruleId);
  await db.delete(automationRules).where(eq(automationRules.id, args.ruleId));
}

export async function applyAutomationRules(
  db: DbLike,
  args: {
    taskId: string;
    projectId: string;
    actorId: string;
    triggerField: 'status' | 'assignee_id';
    newValue: string | null;
    depth: number;
  },
): Promise<void> {
  // one-level chaining cap: depth 0 and 1 can fire, depth 2+ cannot
  if (args.depth >= 2) return;

  const allRules = await db
    .select()
    .from(automationRules)
    .where(
      and(
        eq(automationRules.projectId, args.projectId),
        eq(automationRules.isActive, true),
        eq(automationRules.triggerField, args.triggerField),
      ),
    );

  const fired = allRules.filter(
    (r) => r.triggerValue === null || r.triggerValue === args.newValue,
  );

  for (const rule of fired) {
    const taskRows = await db.select().from(tasks).where(eq(tasks.id, args.taskId));
    if (taskRows.length === 0) continue;
    const task = taskRows[0]!;

    if (rule.actionField === 'status' && rule.actionValue) {
      const newStatus = rule.actionValue as 'todo' | 'doing' | 'done' | 'blocked';
      await db
        .update(tasks)
        .set({ status: newStatus, version: task.version + 1, updatedAt: new Date() })
        .where(eq(tasks.id, args.taskId));
      await db.insert(events).values({
        id: uuidv7(),
        taskId: args.taskId,
        actorId: args.actorId,
        kind: 'status_changed',
        payload: { from: task.status, to: newStatus, automated: true, rule_id: rule.id },
        operationId: uuidv7(),
        createdAt: new Date(),
      });
      await applyAutomationRules(db, {
        taskId: args.taskId,
        projectId: args.projectId,
        actorId: args.actorId,
        triggerField: 'status',
        newValue: newStatus,
        depth: args.depth + 1,
      });
    } else if (rule.actionField === 'assignee_id') {
      const newAssigneeId = rule.actionValue ?? null;
      await db
        .update(tasks)
        .set({ assigneeId: newAssigneeId, version: task.version + 1, updatedAt: new Date() })
        .where(eq(tasks.id, args.taskId));
      await db.insert(events).values({
        id: uuidv7(),
        taskId: args.taskId,
        actorId: args.actorId,
        kind: 'assigned',
        payload: { from: task.assigneeId, to: newAssigneeId, automated: true, rule_id: rule.id },
        operationId: uuidv7(),
        createdAt: new Date(),
      });
      await applyAutomationRules(db, {
        taskId: args.taskId,
        projectId: args.projectId,
        actorId: args.actorId,
        triggerField: 'assignee_id',
        newValue: newAssigneeId,
        depth: args.depth + 1,
      });
    }
  }
}
