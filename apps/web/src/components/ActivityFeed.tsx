/**
 * Activity feed for the currently selected project.
 *
 * Polls GET /api/events every 3s (matches the task-list cadence in App.tsx;
 * SSE/LISTEN-NOTIFY is a v0.2 milestone). Renders human-readable lines:
 *
 *   • Leo created Task "fix the bug"
 *   • Claude marked Task "fix the bug" as doing
 *
 * Why this lives in /components and not inline in App.tsx:
 *   App.tsx is already the project + task + token shell. Keeping the feed
 *   self-contained makes it the obvious thing to swap out when SSE lands.
 */

import { useCallback, useEffect, useState } from 'react';
import type { EventWithActor, EventKind } from '@sprino/protocol-types';

interface ActivityFeedProps {
  token: string;
  projectId: string;
}

const POLL_MS = 3000;

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

  const refresh = useCallback(async () => {
    if (!token || !projectId) {
      setEvents([]);
      return;
    }
    try {
      const r = await fetch(
        `/api/events?project_id=${encodeURIComponent(projectId)}&limit=50`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      );
      if (!r.ok) throw new Error(`events failed: ${r.status}`);
      const j = (await r.json()) as { events: EventWithActor[] };
      setEvents(j.events);
      setError(null);
      setLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [token, projectId]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  if (!projectId) return null;

  return (
    <section className="mt-8">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
        Activity
      </h2>

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
