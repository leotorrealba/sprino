// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * E2-P2: Audit export — service, HTTP routes, workspace isolation.
 */

import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.ts';
import {
  actors,
  actorTokens,
  events,
  projects,
  workspaceMembers,
  workspacePlans,
} from '../src/db/schema.ts';
import { hashToken } from '../src/auth/registry.ts';
import { seedDefaultWorkflowColumns } from '../src/service/projects.ts';
import { createTask, updateTaskStatus } from '../src/service/tasks.ts';
import { exportAuditEvents } from '../src/service/audit-export.ts';
import {
  FIXTURE_ACTOR_ID,
  FIXTURE_PROJECT_ID,
  FIXTURE_TOKEN,
  FIXTURE_WORKSPACE_ID,
  buildTestApp,
  seedWorkspace,
} from './setup.ts';

const withWs = (token: string, wsId: string) => ({
  authorization: `Bearer ${token}`,
  'x-workspace-id': wsId,
});

async function seedProjectInWorkspace(workspaceId: string): Promise<string> {
  const projectId = uuidv7();
  await db.insert(projects).values({
    id: projectId,
    slug: `p-${projectId.slice(0, 8)}`,
    displayName: 'Audit export project',
    repoPath: null,
    workspaceId,
  });
  await seedDefaultWorkflowColumns(db, projectId);
  return projectId;
}

async function seedActorInWorkspace(
  workspaceId: string,
): Promise<{ actorId: string; token: string }> {
  const actorId = uuidv7();
  const token = `test-audit-${crypto.randomUUID()}`;
  await db.insert(actors).values({
    id: actorId,
    kind: 'human',
    role: 'admin',
    displayName: 'Audit export actor',
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
  await db.insert(workspaceMembers).values({
    workspaceId,
    actorId,
    role: 'admin',
  });
  return { actorId, token };
}

describe('audit export (E2-P2)', () => {
  describe('exportAuditEvents', () => {
    beforeEach(async () => {
      await db.insert(workspacePlans).values({
        workspaceId: FIXTURE_WORKSPACE_ID,
        plan: 'free',
        maxProjects: 10,
        maxMembers: 10,
        auditExportEnabled: true,
      });
    });

    it('returns only events for workspace (isolation)', async () => {
      const wsB = await seedWorkspace({ slug: 'audit-ws-b' });
      await db.insert(workspacePlans).values({
        workspaceId: wsB,
        plan: 'free',
        maxProjects: 10,
        maxMembers: 10,
        auditExportEnabled: true,
      });
      const projB = await seedProjectInWorkspace(wsB);
      const { actorId: actorB } = await seedActorInWorkspace(wsB);

      const taskA = await createTask(db, {
        req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'A' },
        actorId: FIXTURE_ACTOR_ID,
        workspaceId: FIXTURE_WORKSPACE_ID,
      });
      const taskB = await createTask(db, {
        req: { operation_id: uuidv7(), project_id: projB, title: 'B' },
        actorId: actorB,
        workspaceId: wsB,
      });

      const { events: evA, total: totA } = await exportAuditEvents(db, {
        workspaceId: FIXTURE_WORKSPACE_ID,
      });
      const { events: evB, total: totB } = await exportAuditEvents(db, { workspaceId: wsB });

      expect(totA).toBeGreaterThanOrEqual(1);
      expect(totB).toBeGreaterThanOrEqual(1);
      expect(evA.map((e) => e.id)).toContain(taskA.event.id);
      expect(evA.map((e) => e.id)).not.toContain(taskB.event.id);
      expect(evB.map((e) => e.id)).toContain(taskB.event.id);
      expect(evB.map((e) => e.id)).not.toContain(taskA.event.id);
      for (const e of evA) {
        expect(e.workspace_id).toBe(FIXTURE_WORKSPACE_ID);
      }
      for (const e of evB) {
        expect(e.workspace_id).toBe(wsB);
      }
    });

    it('filters by kind', async () => {
      const task = await createTask(db, {
        req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'kind filter' },
        actorId: FIXTURE_ACTOR_ID,
        workspaceId: FIXTURE_WORKSPACE_ID,
      });
      await updateTaskStatus(db, {
        req: {
          operation_id: uuidv7(),
          task_id: task.task.id,
          status: 'doing',
          if_match: 1,
        },
        actorId: FIXTURE_ACTOR_ID,
        workspaceId: FIXTURE_WORKSPACE_ID,
      });

      const { events: ev, total } = await exportAuditEvents(db, {
        workspaceId: FIXTURE_WORKSPACE_ID,
        kind: 'status_changed',
      });
      expect(total).toBeGreaterThanOrEqual(1);
      expect(ev.length).toBeGreaterThanOrEqual(1);
      for (const e of ev) {
        expect(e.kind).toBe('status_changed');
      }
    });

    it('filters by since and until', async () => {
      const task = await createTask(db, {
        req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'date filter' },
        actorId: FIXTURE_ACTOR_ID,
        workspaceId: FIXTURE_WORKSPACE_ID,
      });
      const t2018 = uuidv7();
      const t2020 = uuidv7();
      const t2022 = uuidv7();
      await db.insert(events).values([
        {
          id: t2018,
          taskId: task.task.id,
          actorId: FIXTURE_ACTOR_ID,
          kind: 'commented',
          payload: {},
          operationId: uuidv7(),
          createdAt: new Date('2018-06-01T12:00:00.000Z'),
        },
        {
          id: t2020,
          taskId: task.task.id,
          actorId: FIXTURE_ACTOR_ID,
          kind: 'commented',
          payload: {},
          operationId: uuidv7(),
          createdAt: new Date('2020-06-01T12:00:00.000Z'),
        },
        {
          id: t2022,
          taskId: task.task.id,
          actorId: FIXTURE_ACTOR_ID,
          kind: 'commented',
          payload: {},
          operationId: uuidv7(),
          createdAt: new Date('2022-06-01T12:00:00.000Z'),
        },
      ]);

      const onlyInWindow = await exportAuditEvents(db, {
        workspaceId: FIXTURE_WORKSPACE_ID,
        since: '2019-01-01T00:00:00.000Z',
        until: '2021-12-31T23:59:59.999Z',
        kind: 'commented',
      });
      expect(onlyInWindow.total).toBe(1);
      expect(onlyInWindow.events.map((e) => e.id)).toEqual([t2020]);
    });

    it('caps limit at 500', async () => {
      const task = await createTask(db, {
        req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'bulk' },
        actorId: FIXTURE_ACTOR_ID,
        workspaceId: FIXTURE_WORKSPACE_ID,
      });
      const extra = Array.from({ length: 505 }, () => ({
        id: uuidv7(),
        taskId: task.task.id,
        actorId: FIXTURE_ACTOR_ID,
        kind: 'commented' as const,
        payload: {},
        operationId: uuidv7(),
      }));
      await db.insert(events).values(extra);

      const { events: page, total } = await exportAuditEvents(db, {
        workspaceId: FIXTURE_WORKSPACE_ID,
        limit: 9999,
      });
      expect(total).toBeGreaterThanOrEqual(506);
      expect(page.length).toBe(500);
    });
  });

  describe('HTTP GET /audit/export', () => {
    describe('when audit export is enabled (E3)', () => {
      beforeEach(async () => {
        await db.insert(workspacePlans).values({
          workspaceId: FIXTURE_WORKSPACE_ID,
          plan: 'free',
          maxProjects: 10,
          maxMembers: 10,
          auditExportEnabled: true,
        });
      });

      it('returns 200 JSON with events and total', async () => {
        await createTask(db, {
          req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'http json' },
          actorId: FIXTURE_ACTOR_ID,
          workspaceId: FIXTURE_WORKSPACE_ID,
        });
        const app = buildTestApp();
        const r = await app.fetch(
          new Request('http://test/api/audit/export', {
            headers: withWs(FIXTURE_TOKEN, FIXTURE_WORKSPACE_ID),
          }),
        );
        expect(r.status).toBe(200);
        const body = (await r.json()) as { events: unknown[]; total: number };
        expect(Array.isArray(body.events)).toBe(true);
        expect(body.total).toBeGreaterThanOrEqual(1);
      });

      it('GET /audit/export/csv returns text/csv', async () => {
        await createTask(db, {
          req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'http csv' },
          actorId: FIXTURE_ACTOR_ID,
          workspaceId: FIXTURE_WORKSPACE_ID,
        });
        const app = buildTestApp();
        const r = await app.fetch(
          new Request('http://test/api/audit/export/csv', {
            headers: withWs(FIXTURE_TOKEN, FIXTURE_WORKSPACE_ID),
          }),
        );
        expect(r.status).toBe(200);
        expect(r.headers.get('content-type')).toMatch(/text\/csv/);
        const text = await r.text();
        expect(text.split('\n')[0]).toBe(
          'id,task_id,actor_id,kind,created_at,workspace_id',
        );
      });

      it('workspace A token cannot see workspace B events', async () => {
        const wsB = await seedWorkspace({ slug: 'iso-http' });
        const projB = await seedProjectInWorkspace(wsB);
        const { actorId: actorB } = await seedActorInWorkspace(wsB);
        const taskB = await createTask(db, {
          req: { operation_id: uuidv7(), project_id: projB, title: 'secret' },
          actorId: actorB,
          workspaceId: wsB,
        });

        const app = buildTestApp();
        const r = await app.fetch(
          new Request('http://test/api/audit/export', {
            headers: withWs(FIXTURE_TOKEN, FIXTURE_WORKSPACE_ID),
          }),
        );
        expect(r.status).toBe(200);
        const body = (await r.json()) as { events: { id: string }[] };
        expect(body.events.map((e) => e.id)).not.toContain(taskB.event.id);
      });
    });

    describe('when audit export is not enabled', () => {
      it('returns 403 JSON with audit_export_not_enabled', async () => {
        const app = buildTestApp();
        const r = await app.fetch(
          new Request('http://test/api/audit/export', {
            headers: withWs(FIXTURE_TOKEN, FIXTURE_WORKSPACE_ID),
          }),
        );
        expect(r.status).toBe(403);
        const body = (await r.json()) as { error: string; workspace_id: string };
        expect(body.error).toBe('audit_export_not_enabled');
        expect(body.workspace_id).toBe(FIXTURE_WORKSPACE_ID);
      });

      it('returns 403 for CSV export', async () => {
        const app = buildTestApp();
        const r = await app.fetch(
          new Request('http://test/api/audit/export/csv', {
            headers: withWs(FIXTURE_TOKEN, FIXTURE_WORKSPACE_ID),
          }),
        );
        expect(r.status).toBe(403);
        const body = (await r.json()) as { error: string; workspace_id: string };
        expect(body.error).toBe('audit_export_not_enabled');
      });
    });
  });

  describe('MCP audit.export (E3)', () => {
    describe('when audit export is enabled', () => {
      beforeEach(async () => {
        await db.insert(workspacePlans).values({
          workspaceId: FIXTURE_WORKSPACE_ID,
          plan: 'free',
          maxProjects: 10,
          maxMembers: 10,
          auditExportEnabled: true,
        });
      });

      it('returns tool result with events', async () => {
        await createTask(db, {
          req: { operation_id: uuidv7(), project_id: FIXTURE_PROJECT_ID, title: 'mcp audit' },
          actorId: FIXTURE_ACTOR_ID,
          workspaceId: FIXTURE_WORKSPACE_ID,
        });
        const app = buildTestApp();
        const res = await app.fetch(
          new Request('http://test/mcp', {
            method: 'POST',
            headers: {
              authorization: `Bearer ${FIXTURE_TOKEN}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: 'audit.export',
                arguments: { workspaceId: FIXTURE_WORKSPACE_ID },
              },
            }),
          }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          result: {
            structuredContent: { events: unknown[]; total: number };
          };
        };
        expect(body.result.structuredContent.total).toBeGreaterThanOrEqual(1);
        expect(Array.isArray(body.result.structuredContent.events)).toBe(true);
      });
    });

    it('returns JSON-RPC error when export is not enabled', async () => {
      const app = buildTestApp();
      const res = await app.fetch(
        new Request('http://test/mcp', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${FIXTURE_TOKEN}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: 'audit.export',
              arguments: { workspaceId: FIXTURE_WORKSPACE_ID },
            },
          }),
        }),
      );
      expect(res.status).toBe(200);
      const mcpBody = (await res.json()) as {
        error: { code: number; message: string; data: { workspace_id: string } };
      };
      expect(mcpBody.error.code).toBe(-32003);
      expect(mcpBody.error.message).toBe('audit_export_not_enabled');
      expect(mcpBody.error.data.workspace_id).toBe(FIXTURE_WORKSPACE_ID);
    });
  });
});
