// apps/web/src/components/TaskSearchBar.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Actor, TaskStatus } from '@sprino/protocol-types';
import type { TaskFilters, SavedView } from '@sprino/protocol-types';

const ALL_STATUSES: TaskStatus[] = ['todo', 'doing', 'done', 'blocked'];

const STATUS_PILL: Record<TaskStatus, string> = {
  todo: 'bg-slate-100 text-slate-700 ring-slate-300',
  doing: 'bg-blue-100 text-blue-800 ring-blue-300',
  done: 'bg-emerald-100 text-emerald-800 ring-emerald-300',
  blocked: 'bg-rose-100 text-rose-800 ring-rose-300',
};

interface TaskSearchBarProps {
  filters: TaskFilters;
  onFiltersChange: (f: TaskFilters) => void;
  projectId: string;
  token: string;
  members: Actor[];
}

export function TaskSearchBar({
  filters,
  onFiltersChange,
  projectId,
  token,
  members,
}: TaskSearchBarProps) {
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [showSaveInput, setShowSaveInput] = useState(false);
  const [saveName, setSaveName] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  const fetchAuth = useCallback(
    (path: string, init: RequestInit = {}) =>
      fetch(path, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(init.headers ?? {}),
        },
      }),
    [token],
  );

  useEffect(() => {
    if (!projectId) return;
    fetchAuth(`/api/projects/${projectId}/saved-views`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((j: { saved_views: SavedView[] }) => setSavedViews(j.saved_views))
      .catch(() => {});
  }, [projectId, fetchAuth]);

  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
        setShowSaveInput(false);
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  function toggleStatus(s: TaskStatus) {
    const current = filters.status ?? [];
    const next = current.includes(s)
      ? current.filter((x) => x !== s)
      : [...current, s];
    onFiltersChange({ ...filters, status: next.length > 0 ? next : undefined });
  }

  async function saveCurrentView() {
    if (!saveName.trim()) return;
    const r = await fetchAuth(`/api/projects/${projectId}/saved-views`, {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId, name: saveName.trim(), filters }),
    });
    if (r.ok) {
      const j = (await r.json()) as { saved_view: SavedView };
      setSavedViews((v) => [j.saved_view, ...v]);
      setSaveName('');
      setShowSaveInput(false);
    }
  }

  async function deleteView(viewId: string) {
    const r = await fetchAuth(`/api/projects/${projectId}/saved-views/${viewId}`, {
      method: 'DELETE',
    });
    if (r.ok) setSavedViews((v) => v.filter((x) => x.id !== viewId));
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-gray-50 px-3 py-2">
      <input
        type="text"
        placeholder="Search title…"
        value={filters.title_contains ?? ''}
        onChange={(e) =>
          onFiltersChange({ ...filters, title_contains: e.target.value || undefined })
        }
        className="w-48 rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
      />

      <div className="flex gap-1">
        {ALL_STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => toggleStatus(s)}
            className={`rounded px-2 py-0.5 text-xs ring-1 ${
              (filters.status ?? []).includes(s)
                ? STATUS_PILL[s]
                : 'bg-gray-100 text-gray-500 ring-gray-300'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <select
        value={filters.assignee_id ?? ''}
        onChange={(e) =>
          onFiltersChange({ ...filters, assignee_id: e.target.value || undefined })
        }
        className="rounded border border-gray-300 px-2 py-1 text-sm"
      >
        <option value="">Assignee: any</option>
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.display_name}
          </option>
        ))}
      </select>

      <div className="relative ml-auto" ref={dropdownRef}>
        <button
          onClick={() => setShowDropdown((v) => !v)}
          className="rounded border border-gray-300 bg-white px-2 py-1 text-sm hover:bg-gray-50"
        >
          ⭐ Saved views ▾
        </button>

        {showDropdown && (
          <div className="absolute right-0 top-full z-20 mt-1 w-56 rounded border bg-white shadow-lg">
            {savedViews.length === 0 && (
              <p className="px-3 py-2 text-xs text-gray-400">No saved views yet</p>
            )}
            {savedViews.map((v) => (
              <div
                key={v.id}
                className="flex items-center justify-between px-3 py-2 hover:bg-gray-50"
              >
                <button
                  className="flex-1 text-left text-sm"
                  onClick={() => {
                    onFiltersChange(v.filters);
                    setShowDropdown(false);
                  }}
                >
                  {v.name}
                </button>
                <button
                  onClick={() => deleteView(v.id)}
                  className="ml-2 text-xs text-gray-400 hover:text-red-500"
                >
                  ×
                </button>
              </div>
            ))}
            <div className="border-t px-3 py-2">
              {showSaveInput ? (
                <div className="flex gap-1">
                  <input
                    autoFocus
                    value={saveName}
                    onChange={(e) => setSaveName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && saveCurrentView()}
                    placeholder="View name…"
                    className="flex-1 rounded border border-gray-300 px-1 py-0.5 text-xs"
                  />
                  <button
                    onClick={saveCurrentView}
                    className="rounded bg-blue-500 px-2 py-0.5 text-xs text-white hover:bg-blue-600"
                  >
                    Save
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowSaveInput(true)}
                  className="text-xs text-gray-500 hover:text-gray-800"
                >
                  + Save current filters
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
