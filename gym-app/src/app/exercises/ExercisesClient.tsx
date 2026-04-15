'use client';
import { useState, useTransition } from 'react';

type Item = { id: string; name: string; phases: string[]; pref: any | null };

const STATUSES = [
  { v: 'liked', label: '❤︎', cls: 'bg-ok/20 text-ok border-ok/40' },
  { v: 'neutral', label: '–', cls: 'bg-panel-2 text-muted border-border' },
  { v: 'banned', label: '⌀', cls: 'bg-danger/20 text-danger border-danger/40' },
];

export default function ExercisesClient({ exercises }: { exercises: Item[] }) {
  const [items, setItems] = useState(exercises);
  const [pending, start] = useTransition();
  const [filter, setFilter] = useState('');

  function setPref(id: string, status: string) {
    setItems(prev => prev.map(e => e.id === id ? { ...e, pref: { ...(e.pref ?? {}), exercise_id: id, status } } : e));
    start(async () => {
      const ex = items.find(e => e.id === id);
      await fetch('/api/prefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ exercise_id: id, label: ex?.name ?? id, status }),
      });
    });
  }

  const visible = items.filter(e => !filter || e.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <main className="max-w-xl mx-auto px-4 py-6 pb-28">
      <h1 className="text-2xl font-bold tracking-tight mb-3">Exercises</h1>
      <p className="text-xs text-muted mb-3">Tag what you love or want to avoid. Claude will use this when proposing changes.</p>
      <input
        placeholder="Filter…"
        value={filter}
        onChange={e => setFilter(e.target.value)}
        className="w-full mb-3 bg-panel-2 border border-border rounded px-3 py-2 text-sm"
      />
      <ul className="rounded-xl bg-panel border border-border divide-y divide-border overflow-hidden">
        {visible.map(e => (
          <li key={e.id} className="px-3 py-2.5 flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{e.name}</div>
              <div className="text-[10px] text-muted">{e.phases.join(' · ')}</div>
            </div>
            <div className="flex gap-1">
              {STATUSES.map(s => {
                const active = (e.pref?.status ?? 'neutral') === s.v;
                return (
                  <button
                    key={s.v}
                    disabled={pending}
                    onClick={() => setPref(e.id, s.v)}
                    className={`w-8 h-8 rounded-md text-sm border ${active ? s.cls : 'bg-panel-2 border-border text-muted opacity-60'}`}
                    title={s.v}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
          </li>
        ))}
        {visible.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">No matches.</li>}
      </ul>
    </main>
  );
}
