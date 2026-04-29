// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
/**
 * Short-lived signed tickets for the SSE stream endpoint.
 *
 * Why tickets exist:
 *   The browser EventSource API cannot send custom headers (no
 *   Authorization: Bearer ...). The web UI gets a Bearer-protected ticket
 *   from POST /api/events/stream-ticket, then opens
 *   GET /api/events/stream?project_id=X&ticket=Y. The ticket authenticates
 *   the signed request payload only — it is NOT a session token. The SSE
 *   handler still re-checks database credential state so token revocation
 *   applies to both stale tickets and already-open streams.
 *
 * Format:
 *   <actor_id>.<project_id>.<exp_ms>.<base64url(HMAC-SHA256(secret, payload))>
 *
 * The ticket is project-bound: a ticket issued for project A cannot stream
 * project B. This is cheap defense-in-depth that prevents an "all projects
 * for 60s" footgun if per-project ACLs ever land.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const STREAM_TICKET_TTL_MS = 60_000;

export class StreamTicketError extends Error {
  constructor(public readonly reason: string) {
    super(`stream_ticket_${reason}`);
  }
}

function getSecret(): Buffer {
  const s = process.env.SPRINO_STREAM_SECRET;
  if (!s) {
    throw new Error(
      'SPRINO_STREAM_SECRET env var is required for SSE ticket auth',
    );
  }
  if (s.length < 32) {
    throw new Error(
      'SPRINO_STREAM_SECRET must be at least 32 characters of entropy',
    );
  }
  return Buffer.from(s, 'utf8');
}

function b64urlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) {
    throw new StreamTicketError('bad_signature');
  }
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, field: string): void {
  if (!UUID_RE.test(value)) {
    throw new StreamTicketError(`bad_${field}`);
  }
}

/**
 * Mints a ticket for `actorId` to stream `projectId`. Caller is expected to
 * already be authenticated via Bearer + to have access to the project — this
 * helper does NOT check authorization, only signing.
 */
export function issueStreamTicket(
  actorId: string,
  projectId: string,
  now: number = Date.now(),
): { ticket: string; expires_in: number } {
  assertUuid(actorId, 'actor_id');
  assertUuid(projectId, 'project_id');
  const exp = now + STREAM_TICKET_TTL_MS;
  const payload = `${actorId}.${projectId}.${exp}`;
  const sig = createHmac('sha256', getSecret()).update(payload).digest();
  return {
    ticket: `${payload}.${b64urlEncode(sig)}`,
    expires_in: Math.floor(STREAM_TICKET_TTL_MS / 1000),
  };
}

/**
 * Strict, timing-safe verification. Throws `StreamTicketError` with a
 * stable `.reason` ('malformed' | 'expired' | 'bad_signature' |
 * 'project_mismatch' | 'bad_actor_id' | 'bad_project_id') so the route can
 * surface a sensible status without leaking which check failed.
 */
export function verifyStreamTicket(
  ticket: string,
  projectId: string,
  now: number = Date.now(),
): { actorId: string } {
  if (typeof ticket !== 'string' || ticket.length === 0) {
    throw new StreamTicketError('malformed');
  }
  const parts = ticket.split('.');
  if (parts.length !== 4) {
    throw new StreamTicketError('malformed');
  }
  const [actorId, ticketProject, expStr, sigB64] = parts as [
    string,
    string,
    string,
    string,
  ];
  assertUuid(actorId, 'actor_id');
  assertUuid(ticketProject, 'project_id');
  if (ticketProject !== projectId) {
    throw new StreamTicketError('project_mismatch');
  }
  if (!/^[1-9][0-9]{0,15}$/.test(expStr)) {
    throw new StreamTicketError('malformed');
  }
  const exp = Number(expStr);
  if (!Number.isSafeInteger(exp)) {
    throw new StreamTicketError('malformed');
  }
  if (exp < now) {
    throw new StreamTicketError('expired');
  }
  const expected = createHmac('sha256', getSecret())
    .update(`${actorId}.${ticketProject}.${expStr}`)
    .digest();
  const provided = b64urlDecode(sigB64);
  if (provided.length !== expected.length) {
    throw new StreamTicketError('bad_signature');
  }
  if (!timingSafeEqual(provided, expected)) {
    throw new StreamTicketError('bad_signature');
  }
  return { actorId };
}
