// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from 'react';
import type { Workspace } from '@sprino/protocol-types';

interface Props {
  workspaceId: string;
  onWorkspaceChange: (id: string) => void;
  token: string;
}

export function WorkspaceSwitcher({ workspaceId, onWorkspaceChange, token }: Props) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    fetch('/api/workspaces', {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j?.workspaces) setWorkspaces(j.workspaces);
      })
      .catch((e) => {
        if ((e as Error)?.name !== 'AbortError') {}
      });
    return () => controller.abort();
  }, [token]);

  if (workspaces.length <= 1) return null;

  const current = workspaces.find((w) => w.id === workspaceId);

  return (
    <select
      className="text-sm border rounded px-2 py-1"
      value={workspaceId}
      onChange={(e) => onWorkspaceChange(e.target.value)}
    >
      {!current && <option value="">— select workspace —</option>}
      {workspaces.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name}
        </option>
      ))}
    </select>
  );
}
