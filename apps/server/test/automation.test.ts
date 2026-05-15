// SPDX-License-Identifier: AGPL-3.0-or-later
// D5-P2: automation rule CRUD + bounded rule engine tests
import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db/client.ts';
import {
  createAutomationRule,
  listAutomationRules,
  deleteAutomationRule,
  AutomationRuleNotFoundError,
} from '../src/service/automation.ts';
import { createTask, updateTaskStatus } from '../src/service/tasks.ts';
import {
  FIXTURE_ACTOR_ID,
  FIXTURE_PROJECT_ID,
  FIXTURE_WORKSPACE_ID,
} from './setup.ts';

async function makeTask(title: string) {
  const res = await createTask(db, {
    req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title },
    actorId: FIXTURE_ACTOR_ID,
    workspaceId: FIXTURE_WORKSPACE_ID,
  });
  return res.task;
}

// ── Rule CRUD ─────────────────────────────────────────────────────────────────

describe('createAutomationRule + listAutomationRules', () => {
  it('persists a rule and returns it in list', async () => {
    const res = await createAutomationRule(db, {
      req: {
        project_id: FIXTURE_PROJECT_ID,
        name: 'Done → unassign',
        trigger_field: 'status',
        trigger_value: 'done',
        action_field: 'assignee_id',
        action_value: null,
      },
      actorId: FIXTURE_ACTOR_ID,
    });
    expect(res.automation_rule.name).toBe('Done → unassign');
    expect(res.automation_rule.is_active).toBe(true);

    const list = await listAutomationRules(db, FIXTURE_PROJECT_ID);
    expect(list.automation_rules.some((r) => r.id === res.automation_rule.id)).toBe(true);
  });

  it('scopes rules to the project', async () => {
    await createAutomationRule(db, {
      req: {
        project_id: FIXTURE_PROJECT_ID,
        name: 'Scoped rule',
        trigger_field: 'status',
        trigger_value: 'done',
        action_field: 'status',
        action_value: 'todo',
      },
      actorId: FIXTURE_ACTOR_ID,
    });
    const list = await listAutomationRules(db, uuidv7()); // random project
    expect(list.automation_rules).toHaveLength(0);
  });
});

describe('deleteAutomationRule', () => {
  it('removes the rule', async () => {
    const { automation_rule } = await createAutomationRule(db, {
      req: {
        project_id: FIXTURE_PROJECT_ID,
        name: 'To delete',
        trigger_field: 'status',
        trigger_value: 'done',
        action_field: 'assignee_id',
        action_value: null,
      },
      actorId: FIXTURE_ACTOR_ID,
    });
    await deleteAutomationRule(db, { ruleId: automation_rule.id, projectId: FIXTURE_PROJECT_ID });
    const list = await listAutomationRules(db, FIXTURE_PROJECT_ID);
    expect(list.automation_rules.some((r) => r.id === automation_rule.id)).toBe(false);
  });

  it('throws AutomationRuleNotFoundError on missing id', async () => {
    await expect(
      deleteAutomationRule(db, { ruleId: uuidv7(), projectId: FIXTURE_PROJECT_ID }),
    ).rejects.toBeInstanceOf(AutomationRuleNotFoundError);
  });
});

// ── Rule engine ───────────────────────────────────────────────────────────────

describe('automation rule engine — status trigger', () => {
  it('unassigns task when status changes to done', async () => {
    const { actors, actorTokens } = await import('../src/db/schema.ts');
    const memberId = uuidv7();
    await db.insert(actors).values({
      id: memberId,
      kind: 'human',
      role: 'member',
      displayName: 'Member',
      source: 'db',
    });
    await db.insert(actorTokens).values({
      id: uuidv7(),
      actorId: memberId,
      tokenHash: `hash-${memberId}`,
      source: 'db',
    });

    const task = await makeTask('Task to auto-unassign');

    // Assign the task directly via DB
    const { tasks } = await import('../src/db/schema.ts');
    const { eq } = await import('drizzle-orm');
    await db.update(tasks).set({ assigneeId: memberId }).where(eq(tasks.id, task.id));

    // Create the rule: status=done → assignee_id=null
    await createAutomationRule(db, {
      req: {
        project_id: FIXTURE_PROJECT_ID,
        name: 'Done → unassign',
        trigger_field: 'status',
        trigger_value: 'done',
        action_field: 'assignee_id',
        action_value: null,
      },
      actorId: FIXTURE_ACTOR_ID,
    });

    await updateTaskStatus(db, {
      req: {
        operation_id: uuidv7(),
        task_id: task.id,
        status: 'done',
        if_match: task.version,
      },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });

    const rows = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(rows[0]!.assigneeId).toBeNull();
  });

  it('does not fire inactive rules', async () => {
    const { automationRules, tasks } = await import('../src/db/schema.ts');
    const { eq } = await import('drizzle-orm');
    const task = await makeTask('Task with inactive rule');

    const { automation_rule } = await createAutomationRule(db, {
      req: {
        project_id: FIXTURE_PROJECT_ID,
        name: 'Inactive rule',
        trigger_field: 'status',
        trigger_value: 'doing',
        action_field: 'status',
        action_value: 'done',
      },
      actorId: FIXTURE_ACTOR_ID,
    });
    await db
      .update(automationRules)
      .set({ isActive: false })
      .where(eq(automationRules.id, automation_rule.id));

    await updateTaskStatus(db, {
      req: { operation_id: uuidv7(), task_id: task.id, status: 'doing', if_match: task.version },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });

    const rows = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(rows[0]!.status).toBe('doing');
  });
});

describe('automation rule engine — one-level chain cap', () => {
  it('rule B fires when rule A changes status, but no further rules fire', async () => {
    const { tasks } = await import('../src/db/schema.ts');
    const { eq } = await import('drizzle-orm');

    const task = await makeTask('Chain test task');

    // Rule A: status=doing → status=done  (fires at depth 0)
    await createAutomationRule(db, {
      req: {
        project_id: FIXTURE_PROJECT_ID,
        name: 'A: doing → done',
        trigger_field: 'status',
        trigger_value: 'doing',
        action_field: 'status',
        action_value: 'done',
      },
      actorId: FIXTURE_ACTOR_ID,
    });

    // Rule B: status=done → status=todo  (fires at depth 1)
    await createAutomationRule(db, {
      req: {
        project_id: FIXTURE_PROJECT_ID,
        name: 'B: done → todo',
        trigger_field: 'status',
        trigger_value: 'done',
        action_field: 'status',
        action_value: 'todo',
      },
      actorId: FIXTURE_ACTOR_ID,
    });

    // Rule C: status=todo → status=doing  (must NOT fire — would be depth 2)
    await createAutomationRule(db, {
      req: {
        project_id: FIXTURE_PROJECT_ID,
        name: 'C: todo → doing (must not fire)',
        trigger_field: 'status',
        trigger_value: 'todo',
        action_field: 'status',
        action_value: 'doing',
      },
      actorId: FIXTURE_ACTOR_ID,
    });

    // Trigger: set status=doing → fires rule A (depth 0)
    await updateTaskStatus(db, {
      req: { operation_id: uuidv7(), task_id: task.id, status: 'doing', if_match: task.version },
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
    });

    const rows = await db.select().from(tasks).where(eq(tasks.id, task.id));
    // Rule A: doing→done, Rule B: done→todo at depth 1, Rule C must NOT fire.
    // Final status: 'todo' (not 'doing').
    expect(rows[0]!.status).toBe('todo');
  });
});
