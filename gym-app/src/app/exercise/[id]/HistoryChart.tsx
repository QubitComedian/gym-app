'use client';
import { useState } from 'react';
import { format } from 'date-fns';

type Point = { date: string; bestW: number; topVolume: number };

export default function ExerciseHistoryChart({ data }: { data: Point[] }) {
  const [metric, setMetric] = useState<'bestW' | 'topVolume'>('bestW');
  if (data.length < 2) {
    return <p className="text-tiny text-muted-2">Log at least 2 sessions to see a chart.</p>;
  }

  const values = data.map(d => d[metric]);
  const max = Math.max(...values, 1);
  const min = Math.min(...values);
  const range = Math.max(max - min, 1);

  const W = 320;
  const H = 100;
  const padX = 8;
  const padY = 8;
  const innerW = W - padX * 2;
  const innerH = H - padY * 2;

  const pts = data.map((d, i) => {
    const x = padX + (i / (data.length - 1)) * innerW;
    const y = padY + innerH - ((d[metric] - min) / range) * innerH;
    return { x, y, d };
  });

  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const areaPath = `${path} L ${pts[pts.length - 1].x.toFixed(1)} ${padY + innerH} L ${pts[0].x.toFixed(1)} ${padY + innerH} Z`;

  const first = data[0][metric];
  const last = data[data.length - 1][metric];
  const delta = last - first;
  const pct = first > 0 ? Math.round((delta / first) * 100) : 0;

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-3">
        <button
          onClick={() => setMetric('bestW')}
          className={`text-tiny px-2.5 py-1 rounded-md border ${metric === 'bestW' ? 'bg-accent text-black border-accent font-semibold' : 'bg-panel-2 border-border text-muted-2'}`}
        >
          Top weight
        </button>
        <button
          onClick={() => setMetric('topVolume')}
          className={`text-tiny px-2.5 py-1 rounded-md border ${metric === 'topVolume' ? 'bg-accent text-black border-accent font-semibold' : 'bg-panel-2 border-border text-muted-2'}`}
        >
          Top-set volume
        </button>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[120px]" preserveAspectRatio="none">
        <path d={areaPath} fill="currentColor" className="text-accent/15" />
        <path d={path} fill="none" stroke="currentColor" strokeWidth="2" className="text-accent" />
        {pts.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r="2.5" fill="currentColor" className="text-accent" />
        ))}
      </svg>

      <div className="flex items-baseline justify-between text-tiny text-muted-2 mt-1 tabular-nums">
        <span>{format(new Date(data[0].date + 'T00:00:00'), 'MMM d')}</span>
        <span className={delta > 0 ? 'text-ok font-semibold' : delta < 0 ? 'text-danger' : ''}>
          {delta > 0 ? '+' : ''}{delta}{metric === 'bestW' ? 'kg' : ''} {first > 0 ? `(${pct > 0 ? '+' : ''}${pct}%)` : ''}
        </span>
        <span>{format(new Date(data[data.length - 1].date + 'T00:00:00'), 'MMM d')}</span>
      </div>
    </div>
  );
}
