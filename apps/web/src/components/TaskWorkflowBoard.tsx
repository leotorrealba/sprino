import { useCallback, useEffect, useState } from 'react';
import type { Task } from '@sprino/protocol-types';
import type { BoardFilterState } from './BoardFilters';
import { uuidv7 } from '../lib/uuid';

interface WorkflowColumn {
  id: string;
  name: string;
  position: number;
  maps_to_status: string;
  is_default: boolean;
}

interface WorkflowTransition {
  from_column_id: string;
  to_column_id: string;
}

interface Props {
  projectId: string;
  token: string;
  tasks: Task[];
  filters: BoardFilterState;
  onTaskUpdated: () => void;
}

export function TaskWorkflowBoard({ projectId, token, tasks, filters: _filters, onTaskUpdated }: Props) {
  const [columns, setColumns] = useState<WorkflowColumn[]>([]);
  const [transitions, setTransitions] = useState<WorkflowTransition[]>([]);
  const [movingTaskId, setMovingTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const authHeader = { Authorization: `Bearer ${token}` };

  useEffect(() => {
    if (!projectId || !token) return;
    fetch(`/api/projects/${projectId}/workflow-columns`, { headers: authHeader })
      .then((r) => {
        if (!r.ok) throw new Error(`workflow-columns failed: ${r.status}`);
        return r.json();
      })
      .then((data: { columns: WorkflowColumn[]; transitions: WorkflowTransition[] }) => {
        setColumns(data.columns.slice().sort((a, b) => a.position - b.position));
        setTransitions(data.transitions);
      })
      .catch(() => setError('Failed to load workflow columns'));
  }, [projectId, token]);

  const allowedTargets = useCallback(
    (task: Task): WorkflowColumn[] => {
      if (!task.workflow_column_id) return columns;
      return columns.filter((col) =>
        transitions.some(
          (t) => t.from_column_id === task.workflow_column_id && t.to_column_id === col.id,
        ),
      );
    },
    [columns, transitions],
  );

  const handleMove = useCallback(
    async (task: Task, toColumnId: string) => {
      setMovingTaskId(task.id);
      setError(null);
      try {
        const res = await fetch(`/api/tasks/${task.id}/transition`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            operation_id: uuidv7(),
            to_column_id: toColumnId,
            if_match: task.version,
          }),
        });
        if (res.status === 409) {
          onTaskUpdated();
          setError('Task was updated by someone else. Refreshed.');
        } else if (!res.ok) {
          const body = await res.json() as { error?: string };
          setError(body.error ?? 'Move failed');
        } else {
          onTaskUpdated();
        }
      } catch {
        setError('Network error during move');
      } finally {
        setMovingTaskId(null);
      }
    },
    [token, onTaskUpdated],
  );

  if (columns.length === 0) {
    return <p className="text-slate-500 text-sm p-4">Loading board…</p>;
  }

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {error && (
        <div className="fixed top-4 right-4 bg-rose-100 text-rose-800 px-4 py-2 rounded shadow text-sm z-50">
          {error}
        </div>
      )}
      {columns.map((col) => {
        const colTasks = tasks.filter(
          (t) => t.workflow_column_id === col.id || (t.workflow_column_id === null && col.is_default),
        );
        return (
          <div key={col.id} className="flex-shrink-0 w-64 bg-slate-50 rounded-lg p-3">
            <h3 className="font-semibold text-slate-700 text-sm mb-3">
              {col.name}
              <span className="ml-2 text-slate-400 font-normal">({colTasks.length})</span>
            </h3>
            <div className="flex flex-col gap-2">
              {colTasks.map((task) => {
                const targets = allowedTargets(task).filter((c) => c.id !== col.id);
                return (
                  <div key={task.id} className="bg-white rounded border border-slate-200 p-2 shadow-sm">
                    <p className="text-sm text-slate-800 mb-1">{task.title}</p>
                    {targets.length > 0 && (
                      <select
                        className="text-xs border border-slate-200 rounded px-1 py-0.5 w-full text-slate-600 disabled:opacity-50"
                        disabled={movingTaskId === task.id}
                        value=""
                        onChange={(e) => {
                          if (e.target.value) void handleMove(task, e.target.value);
                        }}
                      >
                        <option value="">Move to →</option>
                        {targets.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                );
              })}
              {colTasks.length === 0 && (
                <p className="text-xs text-slate-400 italic py-2 text-center">Empty</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
