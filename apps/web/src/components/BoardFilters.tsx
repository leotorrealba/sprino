import type { Actor, TaskStatus } from '@sprino/protocol-types';

export interface BoardFilterState {
  statuses: TaskStatus[];
  assigneeId: string | null;
}

interface Props {
  members: Actor[];
  filters: BoardFilterState;
  onChange: (f: BoardFilterState) => void;
}

const ALL_STATUSES: TaskStatus[] = ['todo', 'doing', 'done', 'blocked'];

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'Todo',
  doing: 'Doing',
  done: 'Done',
  blocked: 'Blocked',
};

const STATUS_ACTIVE_CLASS: Record<TaskStatus, string> = {
  todo: 'bg-slate-700 text-white ring-slate-500',
  doing: 'bg-blue-600 text-white ring-blue-400',
  done: 'bg-emerald-600 text-white ring-emerald-400',
  blocked: 'bg-rose-600 text-white ring-rose-400',
};

const STATUS_INACTIVE_CLASS =
  'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50';

export function BoardFilters({ members, filters, onChange }: Props) {
  function toggleStatus(s: TaskStatus) {
    const next = filters.statuses.includes(s)
      ? filters.statuses.filter((x) => x !== s)
      : [...filters.statuses, s];
    onChange({ ...filters, statuses: next });
  }

  function setAssignee(id: string | null) {
    onChange({ ...filters, assigneeId: id });
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <div className="flex gap-1.5">
        {ALL_STATUSES.map((s) => {
          const active = filters.statuses.includes(s);
          return (
            <button
              key={s}
              onClick={() => toggleStatus(s)}
              className={`rounded-full px-3 py-1 text-xs font-medium ring-1 transition-colors ${
                active ? STATUS_ACTIVE_CLASS[s] : STATUS_INACTIVE_CLASS
              }`}
            >
              {STATUS_LABELS[s]}
            </button>
          );
        })}
      </div>

      <select
        value={filters.assigneeId ?? ''}
        onChange={(e) => setAssignee(e.target.value || null)}
        className="h-7 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 focus:border-slate-400 focus:outline-none"
      >
        <option value="">All assignees</option>
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.display_name}
          </option>
        ))}
      </select>
    </div>
  );
}
