// apps/web/src/components/BurndownChart.tsx
import { useEffect, useState } from 'react';

interface BurndownPoint {
  date: string;
  remaining: number;
}

interface SprintDetail {
  burndown_series: BurndownPoint[];
  burndown_metric: 'tasks' | 'points';
  sprint: { starts_on: string; ends_on: string };
}

interface Props {
  sprintId: string;
  token: string;
}

const WIDTH = 400;
const HEIGHT = 160;
const PAD = { top: 12, right: 12, bottom: 28, left: 36 };

export function BurndownChart({ sprintId, token }: Props) {
  const [data, setData] = useState<SprintDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/sprints/${sprintId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => {
        if (!r.ok) throw new Error(`sprint detail failed: ${r.status}`);
        return r.json() as Promise<SprintDetail>;
      })
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [sprintId, token]);

  if (error) return <p className="text-xs text-rose-600 px-2">{error}</p>;
  if (!data) return <p className="text-xs text-slate-400 px-2">Loading chart…</p>;

  const series = data.burndown_series;
  if (series.length === 0) return <p className="text-xs text-slate-400 px-2">No data yet.</p>;

  const maxY = Math.max(...series.map((p) => p.remaining), 1);
  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;

  const toX = (i: number) => PAD.left + (i / Math.max(series.length - 1, 1)) * innerW;
  const toY = (v: number) => PAD.top + innerH - (v / maxY) * innerH;

  const points = series.map((p, i) => `${toX(i)},${toY(p.remaining)}`).join(' ');

  const idealStart = `${toX(0)},${toY(series[0]!.remaining)}`;
  const idealEnd = `${toX(series.length - 1)},${toY(0)}`;

  const label = data.burndown_metric === 'points' ? 'pts' : 'tasks';

  return (
    <div className="rounded border border-slate-200 bg-white p-2">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" aria-label="Sprint burndown chart">
        {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
          const y = PAD.top + frac * innerH;
          const val = Math.round(maxY * (1 - frac));
          return (
            <g key={frac}>
              <line
                x1={PAD.left}
                y1={y}
                x2={WIDTH - PAD.right}
                y2={y}
                stroke="#e2e8f0"
                strokeWidth="1"
              />
              <text x={PAD.left - 4} y={y + 4} textAnchor="end" fontSize="9" fill="#94a3b8">
                {val}
              </text>
            </g>
          );
        })}

        <line
          x1={idealStart.split(',')[0]}
          y1={idealStart.split(',')[1]}
          x2={idealEnd.split(',')[0]}
          y2={idealEnd.split(',')[1]}
          stroke="#cbd5e1"
          strokeWidth="1"
          strokeDasharray="4 3"
        />

        <polyline
          points={points}
          fill="none"
          stroke="#3b82f6"
          strokeWidth="2"
          strokeLinejoin="round"
        />

        <text
          x={toX(0)}
          y={HEIGHT - 6}
          textAnchor="middle"
          fontSize="9"
          fill="#94a3b8"
        >
          {series[0]!.date.slice(5)}
        </text>
        <text
          x={toX(series.length - 1)}
          y={HEIGHT - 6}
          textAnchor="middle"
          fontSize="9"
          fill="#94a3b8"
        >
          {series[series.length - 1]!.date.slice(5)}
        </text>

        <text
          x={8}
          y={PAD.top + innerH / 2}
          textAnchor="middle"
          fontSize="9"
          fill="#94a3b8"
          transform={`rotate(-90, 8, ${PAD.top + innerH / 2})`}
        >
          {label}
        </text>
      </svg>
    </div>
  );
}
