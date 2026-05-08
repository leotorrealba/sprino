// apps/web/src/components/TaskHierarchy.tsx
import { useEffect, useState } from 'react';

interface Task {
  id: string;
  title: string;
  status: 'todo' | 'doing' | 'done' | 'blocked';
  parent_task_id: string | null;
}

interface TaskHierarchyProps {
  task: Task;
  projectId: string;
  authHeader: Record<string, string>;
}

export function TaskHierarchy({ task, projectId, authHeader }: TaskHierarchyProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<Task[]>([]);
  const [blockedBy, setBlockedBy] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [childRes, depRes] = await Promise.all([
        fetch(`/api/tasks?project_id=${projectId}&parent_task_id=${task.id}`, {
          headers: authHeader,
        }),
        fetch(`/api/tasks/${task.id}/dependencies`, { headers: authHeader }),
      ]);

      if (cancelled) return;

      if (childRes.ok) {
        const data = (await childRes.json()) as { tasks: Task[] };
        setChildren(data.tasks);
      }
      if (depRes.ok) {
        const data = (await depRes.json()) as { blocked_by: Task[] };
        setBlockedBy(data.blocked_by);
      }
      setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [task.id, projectId, authHeader]);

  if (loading) return null;
  if (children.length === 0 && blockedBy.length === 0) return null;

  const doneCount = children.filter((c) => c.status === 'done').length;
  const pct = children.length > 0 ? Math.round((doneCount / children.length) * 100) : 0;

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {children.length > 0 && (
          <button
            onClick={() => setExpanded((v) => !v)}
            style={{
              background: 'rgba(124,58,237,0.13)',
              color: '#a78bfa',
              border: 'none',
              borderRadius: 12,
              padding: '2px 10px',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            {expanded ? '▾' : '▸'} {children.length} subtask{children.length !== 1 ? 's' : ''} · {doneCount}/{children.length} done
          </button>
        )}
        {blockedBy.length > 0 && (
          <span
            style={{
              background: 'rgba(239,68,68,0.13)',
              color: '#f87171',
              borderRadius: 12,
              padding: '2px 10px',
              fontSize: 11,
            }}
          >
            ⛔ {blockedBy.length} blocker{blockedBy.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {expanded && children.length > 0 && (
        <div style={{ marginTop: 8, borderTop: '1px solid #2a2a2a', paddingTop: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ color: '#9ca3af', fontSize: 11 }}>Progress</span>
            <span style={{ color: '#a78bfa', fontSize: 11 }}>{doneCount} / {children.length}</span>
          </div>
          <div style={{ background: '#111', borderRadius: 4, height: 5, marginBottom: 8 }}>
            <div
              style={{
                background: '#7c3aed',
                height: 5,
                borderRadius: 4,
                width: `${pct}%`,
                transition: 'width 0.2s',
              }}
            />
          </div>
          {children.map((child) => (
            <div
              key={child.id}
              style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, fontSize: 12 }}
            >
              <span style={{ color: child.status === 'done' ? '#22c55e' : '#6b7280' }}>
                {child.status === 'done' ? '✓' : '○'}
              </span>
              <span style={{ color: child.status === 'done' ? '#9ca3af' : '#e0e0e0',
                textDecoration: child.status === 'done' ? 'line-through' : 'none' }}>
                {child.title}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
