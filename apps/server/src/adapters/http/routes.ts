/**
 * HTTP adapter — thin routes calling service/tasks.ts.
 *
 *   POST   /api/tasks              → createTask
 *   GET    /api/tasks/:id          → getTask
 *   PATCH  /api/tasks/:id/status   → updateTaskStatus
 *
 * No business logic in this file. Translation only:
 *   - parse request body via Zod
 *   - call service layer
 *   - map domain errors to HTTP status codes:
 *       TaskNotFoundError       → 404
 *       VersionMismatchError    → 409 with current task body
 *       IdempotencyConflictError → 409 with cached response body
 *       OperationExpiredError   → 410
 *       ZodError                → 400 with validation details
 */

import { Hono } from 'hono';
import type { ActorEntry } from '../../auth/registry.ts';
import type { Db } from '../../db/client.ts';
import {
  EventListReqSchema,
  ProjectGetReqSchema,
  TaskCreateReqSchema,
  TaskGetReqSchema,
  TaskUpdateStatusReqSchema,
} from '../../domain/index.ts';
import {
  ProjectNotFoundError,
  getProject,
  listProjects,
} from '../../service/projects.ts';
import { listEvents } from '../../service/events.ts';
import {
  TaskNotFoundError,
  VersionMismatchError,
  createTask,
  getTask,
  listTasks,
  updateTaskStatus,
} from '../../service/tasks.ts';
import {
  IdempotencyConflictError,
  OperationExpiredError,
} from '../../service/idempotency.ts';
import { ZodError } from 'zod';

type Env = {
  Variables: { actor: ActorEntry; db: Db };
};

export function buildHttpRoutes(): Hono<Env> {
  const api = new Hono<Env>();

  api.get('/projects', async (c) => {
    try {
      const res = await listProjects(c.get('db'));
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  api.get('/projects/resolve', async (c) => {
    try {
      const req = ProjectGetReqSchema.parse({
        slug: c.req.query('slug') || undefined,
        repo_path: c.req.query('repo_path') || undefined,
      });
      const res = await getProject(c.get('db'), { req });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  api.get('/projects/:id', async (c) => {
    try {
      const req = ProjectGetReqSchema.parse({
        project_id: c.req.param('id'),
      });
      const res = await getProject(c.get('db'), { req });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // Sprino-specific list extension — see service/tasks.ts.listTasks.
  // Not exposed via /mcp to keep the canonical protocol minimal.
  api.get('/tasks', async (c) => {
    try {
      const projectId = c.req.query('project_id');
      if (!projectId) {
        return c.json(
          { error: 'missing_project_id', message: 'query param required' },
          400,
        );
      }
      const limitRaw = c.req.query('limit');
      const parsedLimit =
        limitRaw !== undefined && /^-?\d+$/.test(limitRaw)
          ? Number(limitRaw)
          : undefined;
      const limit =
        parsedLimit !== undefined &&
        Number.isFinite(parsedLimit) &&
        Number.isInteger(parsedLimit)
          ? parsedLimit
          : undefined;
      const res = await listTasks(c.get('db'), { projectId, limit });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  api.post('/tasks', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const req = TaskCreateReqSchema.parse(body);
      const actor = c.get('actor');
      const res = await createTask(c.get('db'), { req, actorId: actor.id });
      return c.json(res, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  api.get('/tasks/:id', async (c) => {
    try {
      const req = TaskGetReqSchema.parse({ task_id: c.req.param('id') });
      const res = await getTask(c.get('db'), { req });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  api.patch('/tasks/:id/status', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const req = TaskUpdateStatusReqSchema.parse({
        ...body,
        task_id: c.req.param('id'),
      });
      const actor = c.get('actor');
      const res = await updateTaskStatus(c.get('db'), {
        req,
        actorId: actor.id,
      });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // Sprino-specific activity feed endpoint — see service/events.ts.
  // Project-scoped event log with denormalized actor + task fields. Not
  // exposed via /mcp; agents read events through task.get's recent_events.
  api.get('/events', async (c) => {
    try {
      const limitRaw = c.req.query('limit');
      const offsetRaw = c.req.query('offset');
      const req = EventListReqSchema.parse({
        project_id: c.req.query('project_id'),
        task_id: c.req.query('task_id') || undefined,
        limit:
          limitRaw !== undefined && /^\d+$/.test(limitRaw)
            ? Number(limitRaw)
            : undefined,
        offset:
          offsetRaw !== undefined && /^\d+$/.test(offsetRaw)
            ? Number(offsetRaw)
            : undefined,
      });
      const res = await listEvents(c.get('db'), { req });
      return c.json(res, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  return api;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function errorResponse(c: any, err: unknown): Response {
  if (err instanceof ZodError) {
    return c.json(
      { error: 'validation_error', details: err.issues },
      400,
    );
  }
  if (err instanceof ProjectNotFoundError) {
    return c.json({ error: 'project_not_found', ref: err.ref }, 404);
  }
  if (err instanceof TaskNotFoundError) {
    return c.json({ error: 'task_not_found', task_id: err.taskId }, 404);
  }
  if (err instanceof VersionMismatchError) {
    return c.json(
      {
        error: 'version_mismatch',
        message:
          'if_match does not match server version. See task field for current state.',
        task: err.currentTask,
      },
      409,
    );
  }
  if (err instanceof IdempotencyConflictError) {
    return c.json(
      {
        error: 'operation_id_conflict',
        message:
          'operation_id reused with a different request payload. Cached response in cached_response.',
        cached_response: err.cachedResponse,
      },
      409,
    );
  }
  if (err instanceof OperationExpiredError) {
    return c.json({ error: 'operation_expired' }, 410);
  }
  console.error('Unhandled error:', err);
  return c.json({ error: 'internal_error' }, 500);
}
