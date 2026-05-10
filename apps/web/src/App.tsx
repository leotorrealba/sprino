import { useCallback, useEffect, useState } from 'react';
import type { Actor, Project, Task, TaskStatus, Workspace } from '@sprino/protocol-types';
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher';
import { ActivityFeed } from './components/ActivityFeed';
import { Attachments } from './components/Attachments';
import { BoardFilters, type BoardFilterState } from './components/BoardFilters';
import { Members } from './components/Members';
import { SprintBoard } from './components/SprintBoard';
import { TaskWorkflowBoard } from './components/TaskWorkflowBoard';
import { TaskSearchBar } from './components/TaskSearchBar';
import type { TaskFilters } from '@sprino/protocol-types';
import { uuidv7 } from './lib/uuid';

type LoadState = 'idle' | 'loading' | 'error';
type View = 'tasks' | 'members' | 'board' | 'sprint';

const STATUSES: TaskStatus[] = ['todo', 'doing', 'done', 'blocked'];

const STATUS_PILL: Record<TaskStatus, string> = {
  todo: 'bg-slate-100 text-slate-700 ring-slate-300',
  doing: 'bg-blue-100 text-blue-800 ring-blue-300',
  done: 'bg-emerald-100 text-emerald-800 ring-emerald-300',
  blocked: 'bg-rose-100 text-rose-800 ring-rose-300',
};


const TOKEN_STORAGE_KEY = 'sprino_token';
const PROJECT_STORAGE_KEY = 'sprino_project_id';
const WORKSPACE_STORAGE_KEY = 'sprino_workspace_id';

export function App() {
  const [token, setToken] = useState(
    () => localStorage.getItem(TOKEN_STORAGE_KEY) ?? '',
  );
  const [tokenDraft, setTokenDraft] = useState(token);
  const [workspaceId, setWorkspaceId] = useState(
    () => localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? '',
  );
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState(
    () => localStorage.getItem(PROJECT_STORAGE_KEY) ?? '',
  );
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [view, setView] = useState<View>('tasks');
  const [filters, setFilters] = useState<TaskFilters>({});
  const [members, setMembers] = useState<Actor[]>([]);
  const [load, setLoad] = useState<LoadState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectSlug, setNewProjectSlug] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [projectBusy, setProjectBusy] = useState(false);
  const activeProject = projects.find((p) => p.id === selectedProjectId);

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

  const handleWorkspaceChange = useCallback(
    (id: string) => {
      localStorage.setItem(WORKSPACE_STORAGE_KEY, id);
      setWorkspaceId(id);
      setProjects([]);
      setTasks([]);
      setMembers([]);
      setSelectedProjectId('');
      setSelectedTaskId(null);
    },
    // all deps are stable React state-setter refs
    [],
  );

  const refresh = useCallback(async () => {
    if (!token || !selectedProjectId) {
      setTasks([]);
      return;
    }

    setLoad('loading');
    setError(null);
    try {
      const params = new URLSearchParams({ project_id: selectedProjectId });
      if (filters.status && filters.status.length > 0) {
        for (const s of filters.status) params.append('status', s);
      }
      if (filters.assignee_id) params.set('assignee_id', filters.assignee_id);
      if (filters.title_contains) params.set('title_contains', filters.title_contains);
      if (filters.sprint_id) params.set('sprint_id', filters.sprint_id);

      const r = await fetchAuth(`/api/tasks?${params.toString()}`);
      if (!r.ok) throw new Error(`tasks failed: ${r.status}`);
      const j = (await r.json()) as { tasks: Task[] };
      setTasks(j.tasks);
      setLoad('idle');
    } catch (e) {
      setLoad('error');
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [fetchAuth, token, selectedProjectId, filters]);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    if (!token) return;
    fetch('/api/workspaces', {
      headers: { authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { workspaces?: Workspace[] } | null) => {
        const list = j?.workspaces ?? [];
        if (list.length === 0) return;
        const saved = list.find((w) => w.id === workspaceId);
        if (!saved) {
          const first = list[0]!;
          localStorage.setItem(WORKSPACE_STORAGE_KEY, first.id);
          setWorkspaceId(first.id);
        }
      })
      .catch(() => {});
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void refresh();
    // Poll every 3s — SSE/LISTEN-NOTIFY is a v0.2 milestone (design §Realtime).
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!token) { setMembers([]); return; }
    fetchAuth('/api/actors')
      .then((r) => r.ok ? r.json() : Promise.resolve({ actors: [] }))
      .then((j: { actors: Actor[] }) => setMembers(j.actors))
      .catch(() => setMembers([]));
  }, [fetchAuth, token]);

  // Restore filter state from URL params on mount (shareable links).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const statusValues = params.getAll('status') as TaskFilters['status'];
    const restored: TaskFilters = {};
    if (statusValues && statusValues.length > 0) restored.status = statusValues;
    const assignee_id = params.get('assignee_id');
    if (assignee_id) restored.assignee_id = assignee_id;
    const title_contains = params.get('title_contains');
    if (title_contains) restored.title_contains = title_contains;
    const sprint_id = params.get('sprint_id');
    if (sprint_id) restored.sprint_id = sprint_id;
    if (Object.keys(restored).length > 0) setFilters(restored);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push filter state to URL params (shareable links).
  useEffect(() => {
    const params = new URLSearchParams();
    if (filters.status?.length) for (const s of filters.status) params.append('status', s);
    if (filters.assignee_id) params.set('assignee_id', filters.assignee_id);
    if (filters.title_contains) params.set('title_contains', filters.title_contains);
    if (filters.sprint_id) params.set('sprint_id', filters.sprint_id);
    const qs = params.toString();
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }, [filters]);

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

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    const slug = newProjectSlug.trim();
    const display_name = newProjectName.trim();
    if (!slug || !display_name || projectBusy) return;
    setProjectBusy(true);
    try {
      const r = await fetchAuth('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ operation_id: uuidv7(), slug, display_name }),
      });
      if (!r.ok) {
        const body = (await r.json()) as { error?: string; slug?: string };
        if (body.error === 'slug_conflict') {
          throw new Error(`slug '${body.slug}' is already taken`);
        }
        throw new Error(`create project failed: ${r.status}`);
      }
      const j = (await r.json()) as { project: Project };
      setNewProjectSlug('');
      setNewProjectName('');
      setShowNewProject(false);
      await refreshProjects();
      setSelectedProjectId(j.project.id);
      localStorage.setItem(PROJECT_STORAGE_KEY, j.project.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProjectBusy(false);
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
              Tessera v0.1.4 reference impl
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
              Tessera v0.1.4 reference impl
            </p>
          </div>
          <div className="flex items-center gap-3">
            <WorkspaceSwitcher
              workspaceId={workspaceId}
              onWorkspaceChange={handleWorkspaceChange}
              token={token}
            />
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
              <button
                onClick={() => setView('board')}
                className={`rounded px-3 py-1.5 font-medium ${
                  view === 'board'
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                Board
              </button>
              <button
                onClick={() => setView('sprint')}
                className={`rounded px-3 py-1.5 font-medium ${
                  view === 'sprint'
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                Sprint
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
              onClick={() => setShowNewProject((v) => !v)}
              className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              + project
            </button>
            <button
              onClick={() => {
                localStorage.removeItem(TOKEN_STORAGE_KEY);
                localStorage.removeItem(PROJECT_STORAGE_KEY);
                localStorage.removeItem(WORKSPACE_STORAGE_KEY);
                setToken('');
                setTokenDraft('');
                setSelectedProjectId('');
                setProjects([]);
                setTasks([]);
                setWorkspaceId('');
              }}
              className="text-xs text-slate-400 underline-offset-2 hover:text-slate-700 hover:underline"
            >
              reset connection
            </button>
          </div>
        </div>
        {showNewProject && (
          <div className="border-t border-slate-100 bg-slate-50 px-6 py-3">
            <form
              onSubmit={(e) => void handleCreateProject(e)}
              className="flex flex-wrap items-center gap-2"
            >
              <input
                value={newProjectSlug}
                onChange={(e) => setNewProjectSlug(e.target.value)}
                placeholder="slug (e.g. my-project)"
                pattern="^[a-z0-9]([a-z0-9-]*[a-z0-9])?$"
                required
                className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm focus:border-slate-400 focus:outline-none"
              />
              <input
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder="display name"
                required
                className="h-8 min-w-40 rounded-md border border-slate-200 bg-white px-2 text-sm focus:border-slate-400 focus:outline-none"
              />
              <button
                type="submit"
                disabled={projectBusy || !newProjectSlug.trim() || !newProjectName.trim()}
                className="h-8 rounded-md bg-slate-900 px-3 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-40"
              >
                {projectBusy ? 'creating…' : 'create'}
              </button>
              <button
                type="button"
                onClick={() => { setShowNewProject(false); setNewProjectSlug(''); setNewProjectName(''); }}
                className="text-xs text-slate-400 hover:text-slate-700"
              >
                cancel
              </button>
            </form>
          </div>
        )}
      </header>

      <main className="mx-auto max-w-4xl px-6 py-8">
        {view === 'members' ? (
          <Members token={token} workspaceId={workspaceId} />
        ) : view === 'sprint' ? (
          selectedProjectId ? (
            <SprintBoard projectId={selectedProjectId} token={token} />
          ) : (
            <p className="text-sm text-slate-400">Select a project to view its sprint.</p>
          )
        ) : view === 'board' ? (
          selectedProjectId && (
            <>
              <BoardFilters
                members={members}
                filters={{
                  statuses: filters.status ?? [],
                  assigneeId: filters.assignee_id ?? null,
                }}
                onChange={(f) => {
                  setFilters({
                    status: f.statuses.length > 0 ? f.statuses : undefined,
                    assignee_id: f.assigneeId ?? undefined,
                  });
                }}
              />
              <TaskWorkflowBoard
                projectId={selectedProjectId}
                token={token}
                tasks={tasks}
                filters={{
                  statuses: filters.status ?? [],
                  assigneeId: filters.assignee_id ?? null,
                }}
                onTaskUpdated={refresh}
              />
            </>
          )
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

        {selectedProjectId && (
          <TaskSearchBar
            filters={filters}
            onFiltersChange={setFilters}
            projectId={selectedProjectId}
            token={token}
            members={members}
          />
        )}

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
            {tasks.map((t) => {
              const expanded = selectedTaskId === t.id;
              return (
                <li
                  key={t.id}
                  className={`rounded-lg border bg-white p-4 shadow-sm transition-colors ${
                    expanded ? 'border-slate-400' : 'border-slate-200'
                  }`}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    className="flex cursor-pointer items-start justify-between gap-4"
                    onClick={() =>
                      setSelectedTaskId((prev) => (prev === t.id ? null : t.id))
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedTaskId((prev) => (prev === t.id ? null : t.id));
                      }
                    }}
                  >
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
                    <div
                      className="flex shrink-0 gap-1"
                      onClick={(e) => e.stopPropagation()}
                    >
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
                  {expanded && (
                    <Attachments token={token} taskId={t.id} />
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <ActivityFeed token={token} projectId={selectedProjectId} />
          </>
        )}
      </main>
    </div>
  );
}
