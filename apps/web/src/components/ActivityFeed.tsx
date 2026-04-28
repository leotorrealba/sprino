/**
 * Activity feed for the currently selected project.
 *
 * Transport: REST initial load → SSE primary → 10s polling fallback.
 *   1. Mount: fetch /api/events for the most recent 50 events.
 *   2. Mint a short-lived ticket via POST /api/events/stream-ticket
 *      (EventSource cannot send Authorization headers, so we use a
 *      project-bound HMAC ticket in the query string).
 *   3. Open EventSource at /api/events/stream — append new events live,
 *      track the cursor in lastEventIdRef so a reconnect can resume.
 *   4. On EventSource error, close it and fall back to polling every 10s.
 *      Try to reopen the stream on each fallback tick — if it succeeds,
 *      we drop the polling interval.
 *
 * Renders human-readable lines:
 *   • Leo created Task "fix the bug"
 *   • Claude marked Task "fix the bug" as doing
 *
 * Why this lives in /components and not inline in App.tsx:
 *   App.tsx is already the project + task + token shell. Keeping the feed
 *   self-contained makes it the obvious thing to evolve when LISTEN/NOTIFY
 *   lands in v0.2.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { EventWithActor, EventKind } from '@sprino/protocol-types';

interface ActivityFeedProps {
  token: string;
  projectId: string;
}

const FALLBACK_POLL_MS = 10_000;
const MAX_EVENTS = 100;
type Transport = 'connecting' | 'sse' | 'polling';

function describe(event: EventWithActor): string {
  const taskLabel = `Task "${event.task.title}"`;
  switch (event.kind as EventKind) {
    case 'created':
      return `created ${taskLabel}`;
    case 'status_changed': {
      const to = (event.payload as { to?: string } | null)?.to;
      return to
        ? `marked ${taskLabel} as ${to}`
        : `changed status on ${taskLabel}`;
    }
    case 'assigned':
      return `assigned ${taskLabel}`;
    case 'context_updated':
      return `updated context on ${taskLabel}`;
    case 'commented':
      return `commented on ${taskLabel}`;
    default:
      return `acted on ${taskLabel}`;
  }
}

function formatRelative(iso: string): string {
  const then = Date.parse(iso);
  const now = Date.now();
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function ActivityFeed({ token, projectId }: ActivityFeedProps) {
  const [events, setEvents] = useState<EventWithActor[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [transport, setTransport] = useState<Transport>('connecting');

  // Refs so async callbacks see the latest cursor / live connection
  // without forcing rerenders on every event.
  const lastEventIdRef = useRef<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);

  const appendEvent = useCallback((evt: EventWithActor) => {
    setEvents((prev) => {
      if (prev.some((e) => e.id === evt.id)) return prev;
      const next = [evt, ...prev];
      return next.length > MAX_EVENTS ? next.slice(0, MAX_EVENTS) : next;
    });
    lastEventIdRef.current = evt.id;
  }, []);

  const initialLoad = useCallback(async () => {
    const r = await fetch(
      `/api/events?project_id=${encodeURIComponent(projectId)}&limit=50`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!r.ok) throw new Error(`events failed: ${r.status}`);
    const j = (await r.json()) as { events: EventWithActor[] };
    setEvents(j.events);
    // events are returned newest-first; the cursor is the newest id.
    lastEventIdRef.current = j.events[0]?.id ?? null;
    setLoaded(true);
    setError(null);
  }, [token, projectId]);

  const fetchTicket = useCallback(async (): Promise<string> => {
    const r = await fetch('/api/events/stream-ticket', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ project_id: projectId }),
    });
    if (!r.ok) throw new Error(`stream-ticket failed: ${r.status}`);
    const j = (await r.json()) as { ticket: string };
    return j.ticket;
  }, [token, projectId]);

  const closeSse = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }, []);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // Defined later (declared as ref to allow mutual reference between
  // openSse and the polling fallback).
  const openSseRef = useRef<() => void>(() => undefined);

  const startPolling = useCallback(() => {
    if (pollTimerRef.current !== null) return; // already polling
    setTransport('polling');
    pollTimerRef.current = window.setInterval(() => {
      void initialLoad().catch((e) =>
        setError(e instanceof Error ? e.message : String(e)),
      );
      // Optimistically try to recover SSE on each tick.
      openSseRef.current();
    }, FALLBACK_POLL_MS);
  }, [initialLoad]);

  const openSse = useCallback(async () => {
    if (cancelledRef.current) return;
    if (esRef.current) return; // already open / connecting
    let ticket: string;
    try {
      ticket = await fetchTicket();
    } catch {
      // Ticket fetch failed — stay in polling mode.
      return;
    }
    if (cancelledRef.current) return;
    const params = new URLSearchParams({
      project_id: projectId,
      ticket,
    });
    if (lastEventIdRef.current) {
      params.set('last_event_id', lastEventIdRef.current);
    }
    const es = new EventSource(`/api/events/stream?${params.toString()}`);
    esRef.current = es;

    es.onopen = () => {
      if (cancelledRef.current) {
        es.close();
        return;
      }
      stopPolling();
      setTransport('sse');
      setError(null);
    };

    es.onmessage = (msg) => {
      if (!msg.data) return;
      try {
        const evt = JSON.parse(msg.data) as EventWithActor;
        appendEvent(evt);
      } catch {
        // ignore malformed payloads
      }
    };

    es.onerror = () => {
      es.close();
      esRef.current = null;
      if (cancelledRef.current) return;
      // Fall back to polling; openSse will be retried by the polling loop.
      startPolling();
    };
  }, [appendEvent, fetchTicket, projectId, startPolling, stopPolling]);

  // Keep ref in sync so startPolling can call the latest openSse.
  openSseRef.current = () => {
    void openSse();
  };

  useEffect(() => {
    if (!token || !projectId) {
      setEvents([]);
      setLoaded(false);
      setTransport('connecting');
      return;
    }
    cancelledRef.current = false;
    setLoaded(false);
    setTransport('connecting');

    void (async () => {
      try {
        await initialLoad();
        await openSse();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        startPolling();
      }
    })();

    return () => {
      cancelledRef.current = true;
      closeSse();
      stopPolling();
    };
  }, [token, projectId, initialLoad, openSse, startPolling, closeSse, stopPolling]);

  if (!projectId) return null;

  const transportLabel =
    transport === 'sse'
      ? 'live'
      : transport === 'polling'
        ? 'polling'
        : 'connecting…';

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Activity
        </h2>
        <span
          className={`text-[10px] font-medium uppercase tracking-wide ${
            transport === 'sse'
              ? 'text-emerald-600'
              : transport === 'polling'
                ? 'text-amber-600'
                : 'text-slate-400'
          }`}
          title={`transport: ${transport}`}
        >
          {transport === 'sse' && '● '}
          {transportLabel}
        </span>
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
          {error}
        </div>
      )}

      {!loaded ? (
        <p className="text-sm text-slate-400">loading activity…</p>
      ) : events.length === 0 ? (
        <p className="text-sm text-slate-400">no activity yet</p>
      ) : (
        <ul className="space-y-1.5">
          {events.map((e) => (
            <li
              key={e.id}
              className="flex items-baseline gap-2 rounded border border-slate-100 bg-white px-3 py-2 text-sm"
            >
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ring-inset ${
                  e.actor.kind === 'agent'
                    ? 'bg-violet-50 text-violet-700 ring-violet-200'
                    : 'bg-slate-50 text-slate-700 ring-slate-200'
                }`}
                title={e.actor.kind}
              >
                {e.actor.kind === 'agent' ? '🤖' : '👤'}
              </span>
              <span className="min-w-0 flex-1 text-slate-700">
                <span className="font-medium text-slate-900">
                  {e.actor.display_name}
                </span>{' '}
                {describe(e)}
              </span>
              <span className="shrink-0 text-[11px] text-slate-400">
                {formatRelative(e.created_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

