// apps/web/src/components/SprintBoard.tsx
import { useCallback, useEffect, useState } from 'react';
import { BurndownChart } from './BurndownChart';

interface Sprint {
  id: string;
  name: string;
  status: string;
  starts_on: string;
  ends_on: string;
  version: number;
}

interface Task {
  id: string;
  title: string;
  status: string;
  assignee_id: string | null;
  points: number | null;
  workflow_column_id: string | null;
}

interface WorkflowColumn {
  id: string;
  name: string;
  position: number;
  is_default: boolean;
}

interface Props {
  projectId: string;
  token: string;
}

export function SprintBoard({ projectId, token }: Props) {
  const [sprint, setSprint] = useState<Sprint | null>(null);
  const [sprintTasks, setSprintTasks] = useState<Task[]>([]);
  const [columns, setColumns] = useState<WorkflowColumn[]>([]);
  const [showBurndown, setShowBurndown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const authHeader = { Authorization: `Bearer ${token}` };

  const load = useCallback(async () => {
    if (!projectId || !token) return;
    setLoading(true);
    setError(null);
    try {
      const [sprintRes, colRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/sprints?status=active`, { headers: authHeader }),
        fetch(`/api/projects/${projectId}/workflow-columns`, { headers: authHeader }),
      ]);
      if (!sprintRes.ok) throw new Error(`sprints failed: ${sprintRes.status}`);
      if (!colRes.ok) throw new Error(`columns failed: ${colRes.status}`);

      const sprintData = (await sprintRes.json()) as { sprints: Sprint[] };
      const colData = (await colRes.json()) as { columns: WorkflowColumn[] };

      const active = sprintData.sprints[0] ?? null;
      setSprint(active);
      setColumns(colData.columns.slice().sort((a, b) => a.position - b.position));

      if (active) {
        const sprintDetailRes = await fetch(`/api/sprints/${active.id}`, { headers: authHeader });
        if (!sprintDetailRes.ok) throw new Error(`sprint detail failed: ${sprintDetailRes.status}`);
        const detail = (await sprintDetailRes.json()) as { tasks: Task[] };
        setSprintTasks(detail.tasks);
      } else {
        setSprintTasks([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId, token]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <p className="text-slate-500 text-sm p-4">Loading sprint…</p>;

  if (!sprint) {
    return (
      <div className="p-4 text-slate-500 text-sm">
        <p>No active sprint. Create and activate a sprint to see it here.</p>
      </div>
    );
  }

  const totalPoints = sprintTasks.every((t) => t.points !== null)
    ? sprintTasks.reduce((s, t) => s + (t.points ?? 0), 0)
    : null;
  const doneCount = sprintTasks.filter((t) => t.status === 'done').length;

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-800">
          {error}
        </div>
      )}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-800">{sprint.name}</h2>
          <p className="text-xs text-slate-500">
            {sprint.starts_on} → {sprint.ends_on} ·{' '}
            {doneCount}/{sprintTasks.length} done
            {totalPoints !== null && ` · ${totalPoints} pts`}
          </p>
        </div>
        <button
          onClick={() => setShowBurndown((v) => !v)}
          className="text-xs text-slate-500 border border-slate-200 rounded px-2 py-1 hover:bg-slate-50"
        >
          {showBurndown ? 'Hide burndown' : 'Show burndown'}
        </button>
      </div>

      {showBurndown && <BurndownChart sprintId={sprint.id} token={token} />}

      <div className="flex gap-4 overflow-x-auto pb-2">
        {columns.map((col) => {
          const colTasks = sprintTasks.filter(
            (t) =>
              t.workflow_column_id === col.id ||
              (t.workflow_column_id === null && col.is_default),
          );
          return (
            <div key={col.id} className="flex-shrink-0 w-56 bg-slate-50 rounded-lg p-3">
              <h3 className="font-medium text-slate-700 text-xs mb-2">
                {col.name}
                <span className="ml-1 text-slate-400">({colTasks.length})</span>
              </h3>
              <div className="flex flex-col gap-2">
                {colTasks.map((task) => (
                  <div
                    key={task.id}
                    className="bg-white rounded border border-slate-200 p-2 shadow-sm"
                  >
                    <p className="text-xs text-slate-800 leading-snug">{task.title}</p>
                    <div className="mt-1 flex items-center gap-1">
                      {task.assignee_id && (
                        <span className="text-[10px] bg-slate-100 text-slate-600 rounded px-1">
                          {task.assignee_id.slice(0, 4)}
                        </span>
                      )}
                      {task.points !== null && (
                        <span className="text-[10px] bg-blue-100 text-blue-700 rounded px-1 ml-auto">
                          {task.points}pts
                        </span>
                      )}
                    </div>
                  </div>
                ))}
                {colTasks.length === 0 && (
                  <p className="text-[10px] text-slate-400 italic text-center py-2">Empty</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
