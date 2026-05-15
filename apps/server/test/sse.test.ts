// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Phase 6C — SSE realtime stream + signed ticket auth.
 *
 * The SSE endpoint cannot use Bearer auth (EventSource has no header
 * support), so a short-lived HMAC-signed ticket bound to (actor, project)
 * is minted via POST /api/events/stream-ticket and consumed via
 * GET /api/events/stream?project_id=...&ticket=...
 *
 * These tests exercise:
 *   - Pure ticket signing (issue + verify + tampering + expiry + project mismatch)
 *   - Mount order: stream endpoint bypasses Bearer middleware, ticket
 *     endpoint requires Bearer
 *   - Initial replay via last_event_id query param
 *   - Heartbeat byte appears in the stream
 */

import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FIXTURE_ACTOR_ID,
  FIXTURE_PROJECT_ID,
  FIXTURE_TOKEN,
  FIXTURE_WORKSPACE_ID,
  buildTestApp,
} from './setup.ts';
import { createTask } from '../src/service/tasks.ts';
import { db } from '../src/db/client.ts';
import {
  STREAM_TICKET_TTL_MS,
  StreamTicketError,
  issueStreamTicket,
  verifyStreamTicket,
} from '../src/auth/stream-ticket.ts';
import { registerActor, revokeToken } from '../src/service/actors.ts';

const OTHER_PROJECT_ID = '018c3e7a-0002-7000-8000-0000000000ff';

describe('Phase 6C — stream-ticket signing (unit)', () => {
  it('issue → verify roundtrip succeeds for matching project', () => {
    const { ticket, expires_in } = issueStreamTicket(
      FIXTURE_ACTOR_ID,
      FIXTURE_PROJECT_ID,
    );
    expect(expires_in).toBe(60);
    const { actorId } = verifyStreamTicket(ticket, FIXTURE_PROJECT_ID);
    expect(actorId).toBe(FIXTURE_ACTOR_ID);
  });

  it('rejects ticket bound to a different project_id', () => {
    const { ticket } = issueStreamTicket(FIXTURE_ACTOR_ID, FIXTURE_PROJECT_ID);
    expect(() => verifyStreamTicket(ticket, OTHER_PROJECT_ID)).toThrow(
      StreamTicketError,
    );
  });

  it('rejects expired tickets', () => {
    const past = Date.now() - STREAM_TICKET_TTL_MS - 1_000;
    const { ticket } = issueStreamTicket(
      FIXTURE_ACTOR_ID,
      FIXTURE_PROJECT_ID,
      past,
    );
    try {
      verifyStreamTicket(ticket, FIXTURE_PROJECT_ID);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StreamTicketError);
      expect((err as StreamTicketError).message).toContain('expired');
    }
  });

  it('rejects tampered signature', () => {
    const { ticket } = issueStreamTicket(FIXTURE_ACTOR_ID, FIXTURE_PROJECT_ID);
    // Flip the FIRST character of the signature segment (not the last). The
    // base64url encoding of a 32-byte HMAC is 43 chars, and the final char
    // only encodes 4 bits — its low 2 bits are unused padding, so flipping
    // 'A'→'B' there can decode to the same bytes and produce a flaky test.
    // The first signature char uses all 6 bits, guaranteeing a byte change.
    const lastDot = ticket.lastIndexOf('.');
    const sigStart = lastDot + 1;
    const firstSigChar = ticket[sigStart] ?? '';
    const flipped = firstSigChar === 'A' ? 'B' : 'A';
    const tampered = ticket.slice(0, sigStart) + flipped + ticket.slice(sigStart + 1);
    expect(() => verifyStreamTicket(tampered, FIXTURE_PROJECT_ID)).toThrow(
      StreamTicketError,
    );
  });

  it('rejects malformed structure', () => {
    expect(() =>
      verifyStreamTicket('not-a-ticket', FIXTURE_PROJECT_ID),
    ).toThrow(StreamTicketError);
    expect(() => verifyStreamTicket('', FIXTURE_PROJECT_ID)).toThrow(
      StreamTicketError,
    );
    expect(() =>
      verifyStreamTicket(`${FIXTURE_ACTOR_ID}.${FIXTURE_PROJECT_ID}.abc.xyz`, FIXTURE_PROJECT_ID),
    ).toThrow(StreamTicketError);
  });
});

describe('Phase 6C — POST /api/events/stream-ticket', () => {
  it('mints a signed ticket for the authenticated actor + project', async () => {
    const app = buildTestApp();
    const res = await app.fetch(
      new Request('http://t/api/events/stream-ticket', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${FIXTURE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ project_id: FIXTURE_PROJECT_ID }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticket: string; expires_in: number };
    expect(body.expires_in).toBe(60);
    expect(body.ticket.split('.')).toHaveLength(4);
    expect(res.headers.get('cache-control')).toContain('no-store');
    // Verify the minted ticket actually validates against our project.
    const { actorId } = verifyStreamTicket(body.ticket, FIXTURE_PROJECT_ID);
    expect(actorId).toBe(FIXTURE_ACTOR_ID);
  });

  it('rejects missing Bearer auth (gate: ticket issuance is Bearer-protected)', async () => {
    const app = buildTestApp();
    const res = await app.fetch(
      new Request('http://t/api/events/stream-ticket', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project_id: FIXTURE_PROJECT_ID }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects malformed project_id', async () => {
    const app = buildTestApp();
    const res = await app.fetch(
      new Request('http://t/api/events/stream-ticket', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${FIXTURE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ project_id: 'not-a-uuid' }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('Phase 6C — GET /api/events/stream auth', () => {
  it('returns 401 when ticket query param is missing', async () => {
    const app = buildTestApp();
    const res = await app.fetch(
      new Request(
        `http://t/api/events/stream?project_id=${FIXTURE_PROJECT_ID}`,
      ),
    );
    expect(res.status).toBe(401);
    // Critical: the response body should be JSON, not an HTML 401 page.
    // This proves the SSE handler's ticket-auth path ran (NOT the global
    // Bearer middleware, which would have responded before reaching here).
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/stream_ticket_/);
  });

  it('returns 400 on invalid project_id (handler validates before auth)', async () => {
    const app = buildTestApp();
    const res = await app.fetch(
      new Request('http://t/api/events/stream?project_id=bogus&ticket=x'),
    );
    expect(res.status).toBe(400);
  });

  it('returns 401 on tampered ticket', async () => {
    const app = buildTestApp();
    const { ticket } = issueStreamTicket(
      FIXTURE_ACTOR_ID,
      FIXTURE_PROJECT_ID,
    );
    const tampered = ticket.slice(0, -2) + 'XX';
    const res = await app.fetch(
      new Request(
        `http://t/api/events/stream?project_id=${FIXTURE_PROJECT_ID}&ticket=${encodeURIComponent(
          tampered,
        )}`,
      ),
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when ticket project does NOT match query project_id', async () => {
    const app = buildTestApp();
    const { ticket } = issueStreamTicket(FIXTURE_ACTOR_ID, OTHER_PROJECT_ID);
    const res = await app.fetch(
      new Request(
        `http://t/api/events/stream?project_id=${FIXTURE_PROJECT_ID}&ticket=${encodeURIComponent(
          ticket,
        )}`,
      ),
    );
    expect(res.status).toBe(401);
  });
});

describe('Phase 6C — SSE stream replay + headers', () => {
  let aborters: AbortController[] = [];

  beforeEach(() => {
    aborters = [];
  });

  afterEach(() => {
    for (const ac of aborters) ac.abort();
  });

  /**
   * Open the SSE endpoint, read until at least `untilBytes` bytes have
   * arrived (or the timeout elapses), then abort and return what was seen.
   */
  async function readStream(
    url: string,
    opts: { timeoutMs?: number; untilBytes?: number } = {},
  ): Promise<{ status: number; headers: Headers; body: string }> {
    const ac = new AbortController();
    aborters.push(ac);
    const app = buildTestApp();
    const res = await app.fetch(new Request(url, { signal: ac.signal }));
    if (!res.body || res.status !== 200) {
      return {
        status: res.status,
        headers: res.headers,
        body: res.status === 200 ? '' : await res.text(),
      };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + (opts.timeoutMs ?? 1500);
    const need = opts.untilBytes ?? 1;
    while (Date.now() < deadline && buf.length < need) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const readP = reader.read();
      const timeoutP = new Promise<{ value: undefined; done: true }>((r) =>
        setTimeout(() => r({ value: undefined, done: true }), remaining),
      );
      const { value, done } = await Promise.race([readP, timeoutP]);
      if (done) break;
      buf += dec.decode(value, { stream: true });
    }
    ac.abort();
    return { status: res.status, headers: res.headers, body: buf };
  }

  async function registerDbActor(name: string): Promise<{
    actorId: string;
    token: string;
  }> {
    const opId = uuidv7();
    const res = await registerActor(db, {
      callerId: FIXTURE_ACTOR_ID,
      req: {
        operation_id: opId,
        display_name: name,
        kind: 'human',
      },
    });
    if (!('token' in res)) {
      throw new Error('expected first-time actor.register response');
    }
    return { actorId: res.actor.id, token: res.token };
  }

  it('emits SSE-formatted replay for events newer than last_event_id', async () => {
    // Seed 3 tasks (each generates a "created" event).
    for (let i = 0; i < 3; i += 1) {
      const op = `06b3a000-0000-7000-8000-${String(i).padStart(12, '0')}`;
      await createTask(db, {
        actorId: FIXTURE_ACTOR_ID,
        workspaceId: FIXTURE_WORKSPACE_ID,
        req: {
          project_id: FIXTURE_PROJECT_ID,
          title: `replay-${i}`,
          operation_id: op,
        },
      });
    }

    // Pull the actual event ids in ascending order via a service call.
    const { listEvents } = await import('../src/service/events.ts');
    const allEvents = await listEvents(db, {
      req: { project_id: FIXTURE_PROJECT_ID, limit: 50 },
    });
    expect(allEvents.events.length).toBeGreaterThanOrEqual(3);
    const sortedAsc = [...allEvents.events].sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    );
    const earliestId = sortedAsc[0]!.id;
    const expectedReplayCount = sortedAsc.length - 1;

    const { ticket } = issueStreamTicket(
      FIXTURE_ACTOR_ID,
      FIXTURE_PROJECT_ID,
    );
    const url = `http://t/api/events/stream?project_id=${FIXTURE_PROJECT_ID}&ticket=${encodeURIComponent(
      ticket,
    )}&last_event_id=${earliestId}`;

    const { status, headers, body } = await readStream(url, {
      timeoutMs: 2500,
      untilBytes: 3000,
    });

    expect(status).toBe(200);
    expect(headers.get('content-type')).toContain('text/event-stream');
    // Hono's streamSSE forces Cache-Control: no-cache (which is the
    // SSE-canonical value). We additionally rely on X-Accel-Buffering=no
    // for proxy passthrough.
    expect(headers.get('cache-control')).toContain('no-cache');
    expect(headers.get('x-accel-buffering')).toBe('no');

    // Each replayed event arrives as `id: <uuid>\ndata: {...}\n\n`. We
    // should see at least one "data:" line and at least one "id:" line.
    expect(body).toContain('data:');
    expect(body).toContain('id:');
    // The earliest event itself should NOT be replayed (cursor is exclusive).
    expect(body).not.toContain(earliestId);

    // We should see each later event id at least once.
    const laterIds = sortedAsc.slice(1, expectedReplayCount + 1).map((e) => e.id);
    for (const id of laterIds) {
      expect(body).toContain(id);
    }
  });

  it('emits at least one heartbeat byte even with no events', async () => {
    const { ticket } = issueStreamTicket(
      FIXTURE_ACTOR_ID,
      FIXTURE_PROJECT_ID,
    );
    const url = `http://t/api/events/stream?project_id=${FIXTURE_PROJECT_ID}&ticket=${encodeURIComponent(
      ticket,
    )}`;
    const { status, body } = await readStream(url, {
      timeoutMs: 800,
      untilBytes: 1,
    });
    expect(status).toBe(200);
    // Initial keep-alive is `: ping\n\n` — the colon is the SSE comment marker.
    expect(body).toMatch(/:\s*ping/);
  });

  it('rejects a stale SSE ticket after the actor credential is revoked', async () => {
    const { actorId } = await registerDbActor('Revoked Stream Viewer');
    const { ticket } = issueStreamTicket(actorId, FIXTURE_PROJECT_ID);

    await revokeToken(db, {
      callerId: FIXTURE_ACTOR_ID,
      req: {
        operation_id: uuidv7(),
        actor_id: actorId,
      },
    });

    const { status, body } = await readStream(
      `http://t/api/events/stream?project_id=${FIXTURE_PROJECT_ID}&ticket=${encodeURIComponent(
        ticket,
      )}`,
    );

    expect(status).toBe(403);
    expect(body).toContain('revoked');
  });

  it('stops an already-open SSE stream after credential revocation', async () => {
    const { actorId } = await registerDbActor('Live Revoked Stream Viewer');
    const { ticket } = issueStreamTicket(actorId, FIXTURE_PROJECT_ID);

    const app = buildTestApp();
    const ac = new AbortController();
    aborters.push(ac);
    const res = await app.fetch(
      new Request(
        `http://t/api/events/stream?project_id=${FIXTURE_PROJECT_ID}&ticket=${encodeURIComponent(
          ticket,
        )}`,
        { signal: ac.signal },
      ),
    );

    expect(res.status).toBe(200);
    expect(res.body).toBeTruthy();

    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';

    const first = await reader.read();
    expect(first.done).toBe(false);
    buf += dec.decode(first.value, { stream: true });
    expect(buf).toMatch(/:\s*ping/);

    await revokeToken(db, {
      callerId: FIXTURE_ACTOR_ID,
      req: {
        operation_id: uuidv7(),
        actor_id: actorId,
      },
    });

    const created = await createTask(db, {
      actorId: FIXTURE_ACTOR_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
      req: {
        project_id: FIXTURE_PROJECT_ID,
        title: 'post-revoke-stream-event',
        operation_id: uuidv7(),
      },
    });

    const next = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), 4500),
      ),
    ]);

    if (!next.done && next.value) {
      buf += dec.decode(next.value, { stream: true });
    }
    ac.abort();

    expect(buf).not.toContain(created.event.id);
  });
});
