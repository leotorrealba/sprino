// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * SSE handler for GET /api/events/stream.
 *
 * Auth: short-lived signed ticket, NOT Bearer (EventSource cannot send
 * custom headers). See auth/stream-ticket.ts for the format and the route
 * mounting in main.ts for the order.
 *
 * Stream protocol:
 *   - Heartbeat every 15s as `: ping\n\n` (SSE comment, ignored by clients)
 *   - Events as unnamed messages with `id: <uuid>\ndata: <json>\n\n`
 *     (unnamed so EventSource.onmessage fires without addEventListener)
 *   - Catch-up replay on connect when `last_event_id` query param is set
 *
 * Polling cadence:
 *   2s per-connection. For v0.x single-tenant PoC. v0.2+ should switch to
 *   a shared per-project poller + LISTEN/NOTIFY broadcast.
 *
 * Cleanup: the request abort signal terminates the loop. streamSSE's own
 * cancellation handles browser-initiated disconnects.
 */

import { streamSSE } from 'hono/streaming';
import type { Context } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { actorTokens } from '../../db/schema.ts';
import { listEventsAfter, latestEventId } from '../../service/events.ts';
import {
  StreamTicketError,
  verifyStreamTicket,
} from '../../auth/stream-ticket.ts';
import { lookupActorById } from '../../auth/registry.ts';

const POLL_MS = 2_000;
const HEARTBEAT_MS = 15_000;
const REPLAY_LIMIT = 100;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type StreamEnv = { Variables: { db: Db } };

async function actorHasActiveCredential(
  db: Db,
  actorId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: actorTokens.id })
    .from(actorTokens)
    .where(
      and(eq(actorTokens.actorId, actorId), isNull(actorTokens.revokedAt)),
    )
    .limit(1);
  return rows.length > 0;
}

export async function sseHandler(c: Context<StreamEnv>): Promise<Response> {
  const projectId = c.req.query('project_id') ?? '';
  const ticket = c.req.query('ticket') ?? '';
  const lastEventIdRaw =
    c.req.header('last-event-id') ?? c.req.query('last_event_id') ?? '';

  if (!UUID_RE.test(projectId)) {
    return c.json({ error: 'invalid_project_id' }, 400);
  }
  let actorId: string;
  try {
    ({ actorId } = verifyStreamTicket(ticket, projectId));
  } catch (err) {
    if (err instanceof StreamTicketError) {
      return c.json({ error: err.message }, 401);
    }
    throw err;
  }
  const db = c.get('db');

  // Verify the ticket-bound actor still exists. Hits the DB so actors
  // minted via actor.register at runtime can stream events too — no env
  // reload required.
  if (!(await lookupActorById(db, actorId))) {
    return c.json({ error: 'unknown_actor' }, 403);
  }
  if (!(await actorHasActiveCredential(db, actorId))) {
    return c.json({ error: 'revoked_actor' }, 403);
  }

  const lastEventId =
    lastEventIdRaw && UUID_RE.test(lastEventIdRaw) ? lastEventIdRaw : null;

  // Set proxy-friendly headers BEFORE handing off to streamSSE.
  c.header('Cache-Control', 'no-cache, no-store, no-transform');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');

  return streamSSE(c, async (stream) => {
    let cursor: string | null = lastEventId;
    let aborted = false;
    const abortSignal = c.req.raw.signal;
    const onAbort = (): void => {
      aborted = true;
    };
    abortSignal.addEventListener('abort', onAbort);

    try {
      // Initial replay if the client provided a cursor.
      if (cursor) {
        const replay = await listEventsAfter(db, {
          projectId,
          afterEventId: cursor,
          limit: REPLAY_LIMIT,
        });
        for (const ev of replay) {
          if (aborted || stream.closed) break;
          await stream.writeSSE({ id: ev.id, data: JSON.stringify(ev) });
          cursor = ev.id;
        }
      } else {
        // No cursor (e.g. an empty-feed initial REST load): snapshot the
        // current tail so subsequent events are picked up. Without this,
        // `listEventsAfter` would short-circuit on null forever and the
        // client would never receive a live event.
        cursor = await latestEventId(db, projectId);
      }

      let lastHeartbeat = Date.now();
      // Initial heartbeat so the client knows the connection is live.
      // Use an SSE comment (`:` prefix) — clients ignore comments but they
      // flush proxy buffers and let the browser fire the EventSource `open`
      // event without an empty `data:` message.
      await stream.write(': ping\n\n').catch(() => undefined);

      while (!aborted && !stream.closed) {
        try {
          if (!(await actorHasActiveCredential(db, actorId))) {
            break;
          }
          const fresh = await listEventsAfter(db, {
            projectId,
            afterEventId: cursor,
            limit: REPLAY_LIMIT,
          });
          for (const ev of fresh) {
            if (aborted || stream.closed) break;
            await stream.writeSSE({ id: ev.id, data: JSON.stringify(ev) });
            cursor = ev.id;
          }
          const now = Date.now();
          if (now - lastHeartbeat >= HEARTBEAT_MS) {
            await stream.write(': ping\n\n');
            lastHeartbeat = now;
          }
        } catch {
          // Database hiccup — sleep and retry. The stream stays open so the
          // client doesn't need to reconnect on transient errors.
        }
        await stream.sleep(POLL_MS);
      }
    } finally {
      // Always remove the abort listener — covers early throws from the
      // initial replay / latestEventId / heartbeat write paths.
      abortSignal.removeEventListener('abort', onAbort);
    }
  });
}
