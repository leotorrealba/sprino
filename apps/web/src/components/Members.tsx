// SPDX-License-Identifier: AGPL-3.0-or-later
// Sprino — reference implementation of Tessera
import { useCallback, useEffect, useState } from 'react';

interface Actor {
  id: string;
  kind: 'human' | 'agent';
  display_name: string;
  source: 'env' | 'db';
  agent_runtime: string | null;
  parent_actor_id: string | null;
  created_at: string;
  revoked_at: string | null;
}

function uuidv7(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const ms = BigInt(Date.now());
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface Props {
  token: string;
  workspaceId: string;
}

export function Members({ token, workspaceId }: Props) {
  const [actors, setActors] = useState<Actor[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [inviteName, setInviteName] = useState('');
  // One-time-reveal of plaintext credentials. Cleared as soon as the
  // dialog is dismissed — we never persist the plaintext anywhere.
  const [reveal, setReveal] = useState<{
    actor: Actor;
    token: string;
    label: string;
  } | null>(null);

  const fetchAuth = useCallback(
    (path: string, init: RequestInit = {}): Promise<Response> =>
      fetch(path, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}),
          ...(init.headers ?? {}),
        },
      }),
    [token, workspaceId],
  );

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const r = await fetchAuth('/api/actors');
      if (!r.ok) throw new Error(`list failed: ${r.status}`);
      const j = (await r.json()) as { actors: Actor[] };
      setActors(j.actors);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [fetchAuth]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteName.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetchAuth('/api/actors', {
        method: 'POST',
        body: JSON.stringify({
          operation_id: uuidv7(),
          display_name: inviteName.trim(),
          kind: 'human',
        }),
      });
      const body = (await r.json()) as
        | { actor: Actor; token: string }
        | { _error?: { details?: { reason?: string } } };
      if (!r.ok || !('actor' in body)) {
        const reason =
          (body as { _error?: { details?: { reason?: string } } })._error
            ?.details?.reason ?? `register failed: ${r.status}`;
        throw new Error(reason);
      }
      setReveal({
        actor: body.actor,
        token: body.token,
        label: 'New member credentials',
      });
      setInviteName('');
      setInviting(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (actor: Actor) => {
    if (
      !window.confirm(
        `Revoke ${actor.display_name}'s active token? They will lose access immediately.`,
      )
    ) {
      return;
    }
    setError(null);
    try {
      const r = await fetchAuth(`/api/actors/${actor.id}/revoke_token`, {
        method: 'POST',
        body: JSON.stringify({
          operation_id: uuidv7(),
          actor_id: actor.id,
        }),
      });
      if (!r.ok) {
        const body = (await r.json()) as {
          _error?: { details?: { reason?: string } };
        };
        throw new Error(
          body._error?.details?.reason ?? `revoke failed: ${r.status}`,
        );
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const rotate = async (actor: Actor) => {
    if (
      !window.confirm(
        `Rotate ${actor.display_name}'s token? Their current credential will stop working — they'll need the new one.`,
      )
    ) {
      return;
    }
    setError(null);
    try {
      const r = await fetchAuth(`/api/actors/${actor.id}/rotate_token`, {
        method: 'POST',
      });
      const body = (await r.json()) as
        | { actor: Actor; token: string }
        | { _error?: { details?: { reason?: string } } };
      if (!r.ok || !('actor' in body)) {
        const reason =
          (body as { _error?: { details?: { reason?: string } } })._error
            ?.details?.reason ?? `rotate failed: ${r.status}`;
        throw new Error(reason);
      }
      setReveal({
        actor: body.actor,
        token: body.token,
        label: 'Rotated credential',
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-700">Members</h2>
          <p className="mt-1 text-xs text-slate-400">
            Humans + agents who hold credentials for this Sprino instance.
            Env-source actors come from <code>SPRINO_ACTORS_JSON</code> and
            can only be rotated by editing <code>.env</code> + restarting.
          </p>
        </div>
        <button
          onClick={() => setInviting((v) => !v)}
          className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          {inviting ? 'cancel' : 'invite human'}
        </button>
      </div>

      {inviting && (
        <form
          onSubmit={invite}
          className="mb-6 flex gap-2 rounded-lg border border-slate-200 bg-white p-3 shadow-sm"
        >
          <input
            value={inviteName}
            onChange={(e) => setInviteName(e.target.value)}
            placeholder="Display name"
            autoFocus
            className="flex-1 rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || !inviteName.trim()}
            className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-40"
          >
            register
          </button>
        </form>
      )}

      {error && (
        <div className="mb-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Kind</th>
              <th className="px-4 py-2">Source</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {actors.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                  no members
                </td>
              </tr>
            ) : (
              actors.map((a) => (
                <tr key={a.id} className="border-t border-slate-100">
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-800">
                      {a.display_name}
                    </div>
                    <div className="font-mono text-[10px] text-slate-400">
                      {a.id}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] uppercase tracking-wide text-slate-600">
                      {a.kind}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {a.source === 'env' ? '.env file' : 'database'}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {a.revoked_at ? (
                      <span className="text-rose-700">revoked</span>
                    ) : (
                      <span className="text-emerald-700">active</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {a.source === 'env' ? (
                      <span className="text-[11px] text-slate-400">
                        edit .env to rotate
                      </span>
                    ) : a.revoked_at ? (
                      <span className="text-[11px] text-slate-400">—</span>
                    ) : (
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => void rotate(a)}
                          className="rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-100"
                        >
                          rotate
                        </button>
                        <button
                          onClick={() => void revoke(a)}
                          className="rounded border border-rose-300 px-2 py-1 text-[11px] text-rose-700 hover:bg-rose-50"
                        >
                          revoke
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {reveal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-6"
          onClick={() => setReveal(null)}
        >
          <div
            className="max-w-lg rounded-lg border border-slate-200 bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-slate-800">
              {reveal.label}
            </h3>
            <p className="mt-2 text-sm text-slate-600">
              Copy this token now — Sprino does not store the plaintext and
              will not show it again. Hand it to{' '}
              <strong>{reveal.actor.display_name}</strong> over a secure
              channel.
            </p>
            <pre className="mt-4 overflow-x-auto rounded-md bg-slate-900 px-3 py-2 font-mono text-xs text-emerald-200">
              {reveal.token}
            </pre>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(reveal.token);
                }}
                className="rounded border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100"
              >
                copy
              </button>
              <button
                onClick={() => setReveal(null)}
                className="rounded bg-slate-900 px-3 py-1.5 text-xs text-white hover:bg-slate-700"
              >
                I've saved it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
