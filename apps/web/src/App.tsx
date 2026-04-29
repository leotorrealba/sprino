import { useCallback, useEffect, useState } from 'react';
import type { Project, Task, TaskStatus } from '@sprino/protocol-types';
import { ActivityFeed } from './components/ActivityFeed';
import { Members } from './components/Members';

type LoadState = 'idle' | 'loading' | 'error';
type View = 'tasks' | 'members';

const STATUSES: TaskStatus[] = ['todo', 'doing', 'done', 'blocked'];

const STATUS_PILL: Record<TaskStatus, string> = {
  todo: 'bg-slate-100 text-slate-700 ring-slate-300',
  doing: 'bg-blue-100 text-blue-800 ring-blue-300',
  done: 'bg-emerald-100 text-emerald-800 ring-emerald-300',
  blocked: 'bg-rose-100 text-rose-800 ring-rose-300',
};

function uuidv7(): string {
  // Minimal UUIDv7 generator — sufficient for browser-side operation_id.
  // Bytes 0..5: 48-bit Unix ms timestamp. Byte 6 high nibble: version=7.
  // Byte 8 high two bits: variant=10. Remaining: random.
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

const TOKEN_STORAGE_KEY = 'sprino_token';
const PROJECT_STORAGE_KEY = 'sprino_project_id';

export function App() {
  const [token, setToken] = useState(
    () => localStorage.getItem(TOKEN_STORAGE_KEY) ?? '',
  );
  const [tokenDraft, setTokenDraft] = useState(token);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState(
    () => localStorage.getItem(PROJECT_STORAGE_KEY) ?? '',
  );
  const [tasks, setTasks] = useState<Task[]>([]);
  const [view, setView] = useState<View>('tasks');
  const [load, setLoad] = useState<LoadState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const activeProject = projects.find((p) => p.id === selectedProjectId);

  const fetchAuth = useCallback(
    (path: string, init: RequestInit = {}): Promise<Response> =>
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

  const refreshProjects = useCallback(async () => {
    if (!token) {
      setProjects([]);
      return;
    }

    setError(null);
    try {
      const r = await fetchAuth('/api/projects');
      if (!r.ok) throw new Error(`projects failed: ${r.status}`);
      const j = (await r.json()) as { projects: Project[] };
      setProjects(j.projects);

      setSelectedProjectId((current) => {
        const saved =
          current || localStorage.getItem(PROJECT_STORAGE_KEY) || '';
        if (saved && j.projects.some((p) => p.id === saved)) return saved;
        const first = j.projects[0]?.id ?? '';
        if (first) localStorage.setItem(PROJECT_STORAGE_KEY, first);
        return first;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [fetchAuth, token]);

  const refresh = useCallback(async () => {
    if (!token || !selectedProjectId) {
      setTasks([]);
      return;
    }

    setLoad('loading');
    setError(null);
    try {
      const r = await fetchAuth(
        `/api/tasks?project_id=${encodeURIComponent(selectedProjectId)}`,
      );
      if (!r.ok) throw new Error(`list failed: ${r.status}`);
      const j = (await r.json()) as { tasks: Task[] };
      setTasks(j.tasks);
      setLoad('idle');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoad('error');
    }
  }, [selectedProjectId, fetchAuth, token]);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    void refresh();
    // Poll every 3s — SSE/LISTEN-NOTIFY is a v0.2 milestone (design §Realtime).
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const createTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !selectedProjectId || busy) return;
    setBusy(true);
    try {
      const r = await fetchAuth('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          operation_id: uuidv7(),
          project_id: selectedProjectId,
          title: newTitle.trim(),
        }),
      });
      if (!r.ok) {
        const body = await r.text();
        throw new Error(`create failed: ${r.status} ${body}`);
      }
      setNewTitle('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const connect = (e: React.FormEvent) => {
    e.preventDefault();
    const nextToken = tokenDraft.trim();
    if (!nextToken) return;
    localStorage.setItem(TOKEN_STORAGE_KEY, nextToken);
    setToken(nextToken);
  };

  const changeStatus = async (task: Task, status: TaskStatus) => {
    if (task.status === status) return;
    try {
      const r = await fetchAuth(`/api/tasks/${task.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({
          operation_id: uuidv7(),
          status,
          if_match: task.version,
        }),
      });
      if (!r.ok) {
        const body = await r.text();
        throw new Error(`status update failed: ${r.status} ${body}`);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!token) {
    return (
      <div className="min-h-screen text-slate-800">
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto max-w-4xl px-6 py-4">
            <h1 className="text-xl font-semibold tracking-tight">Sprino</h1>
            <p className="text-xs text-slate-500">
              Tessera v0.1.2 reference impl
            </p>
          </div>
        </header>
        <main className="mx-auto max-w-4xl px-6 py-8">
          <form
            onSubmit={connect}
            className="flex max-w-md gap-2 rounded-lg border border-slate-200 bg-white p-3 shadow-sm"
          >
            <input
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
              placeholder="Bearer token"
              className="min-w-0 flex-1 rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
            <button
              type="submit"
              disabled={!tokenDraft.trim()}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
            >
              connect
            </button>
          </form>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen text-slate-800">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Sprino</h1>
            <p className="text-xs text-slate-500">
              Tessera v0.1.2 reference impl
            </p>
          </div>
          <div className="flex items-center gap-3">
            <nav className="flex gap-1 rounded-md border border-slate-200 bg-white p-0.5 text-xs">
              <button
                onClick={() => setView('tasks')}
                className={`rounded px-3 py-1.5 font-medium ${
                  view === 'tasks'
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                Tasks
              </button>
              <button
                onClick={() => setView('members')}
                className={`rounded px-3 py-1.5 font-medium ${
                  view === 'members'
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                Members
              </button>
            </nav>
            <select
              value={selectedProjectId}
              onChange={(e) => {
                const id = e.target.value;
                setSelectedProjectId(id);
                localStorage.setItem(PROJECT_STORAGE_KEY, id);
              }}
              className="h-9 min-w-40 rounded-md border border-slate-200 bg-white px-2 text-sm focus:border-slate-400 focus:outline-none"
            >
              {projects.length === 0 ? (
                <option value="">No projects</option>
              ) : (
                projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.display_name}
                  </option>
                ))
              )}
            </select>
            <button
              onClick={() => {
                localStorage.removeItem(TOKEN_STORAGE_KEY);
                localStorage.removeItem(PROJECT_STORAGE_KEY);
                setToken('');
                setTokenDraft('');
                setSelectedProjectId('');
                setProjects([]);
                setTasks([]);
              }}
              className="text-xs text-slate-400 underline-offset-2 hover:text-slate-700 hover:underline"
            >
              reset connection
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-8">
        {view === 'members' ? (
          <Members token={token} />
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-700">
              {activeProject?.display_name ?? 'Project'}
            </h2>
            {activeProject?.repo_path && (
              <p className="mt-1 max-w-full truncate font-mono text-[11px] text-slate-400">
                {activeProject.repo_path}
              </p>
            )}
          </div>
        </div>

        <form
          onSubmit={createTask}
          className="mb-8 flex gap-2 rounded-lg border border-slate-200 bg-white p-3 shadow-sm"
        >
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="What needs doing?"
            className="flex-1 rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || !newTitle.trim() || !selectedProjectId}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
          >
            create
          </button>
        </form>

        {error && (
          <div className="mb-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {error}
          </div>
        )}

        {load === 'loading' && tasks.length === 0 ? (
          <p className="text-sm text-slate-400">loading…</p>
        ) : tasks.length === 0 ? (
          <p className="text-sm text-slate-400">no tasks yet</p>
        ) : (
          <ul className="space-y-2">
            {tasks.map((t) => (
              <li
                key={t.id}
                className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{t.title}</p>
                    {t.description && (
                      <p className="mt-1 line-clamp-2 text-xs text-slate-500">
                        {t.description}
                      </p>
                    )}
                    <p className="mt-1 font-mono text-[10px] text-slate-400">
                      {t.id} · v{t.version}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {STATUSES.map((s) => (
                      <button
                        key={s}
                        onClick={() => void changeStatus(t, s)}
                        className={`rounded px-2 py-1 text-[10px] font-medium uppercase tracking-wide ring-1 ring-inset ${
                          t.status === s
                            ? STATUS_PILL[s]
                            : 'bg-white text-slate-400 ring-slate-200 hover:text-slate-700'
                        }`}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        <ActivityFeed token={token} projectId={selectedProjectId} />
          </>
        )}
      </main>
    </div>
  );
}
