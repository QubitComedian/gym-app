'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { exName } from '@/components/PrescriptionView';
import Link from 'next/link';

type SetRow = { w?: string; r?: string; rir?: string; note?: string };

function flattenExercises(prescription: any): { exercise_id: string; weight_hint?: string; targetSets: number; reps?: string; notes?: string }[] {
  const out: any[] = [];
  for (const b of prescription?.blocks ?? []) {
    if (b.kind === 'single') {
      const sets = b.set_scheme?.sets ?? (b.set_scheme?.type === 'emom' ? 1 : 3);
      out.push({
        exercise_id: b.exercise_id, weight_hint: b.weight_hint,
        targetSets: sets, reps: b.set_scheme?.reps ?? (b.set_scheme?.total_reps ? `${b.set_scheme.total_reps} total` : ''),
        notes: b.notes,
      });
    } else if (b.kind === 'superset') {
      for (const it of b.items) {
        out.push({
          exercise_id: it.exercise_id, weight_hint: it.weight_hint,
          targetSets: b.rounds, reps: it.set_scheme?.reps,
          notes: it.notes,
        });
      }
    }
  }
  return out;
}

export default function LogClient({ plan }: { plan: any }) {
  const router = useRouter();
  const isGym = plan.type === 'gym';
  const exercises = useMemo(() => flattenExercises(plan.prescription), [plan]);

  const [sets, setSets] = useState<Record<string, SetRow[]>>(() => {
    const obj: Record<string, SetRow[]> = {};
    for (const e of exercises) obj[e.exercise_id] = Array.from({ length: e.targetSets }, () => ({}));
    return obj;
  });
  const [notes, setNotes] = useState('');
  const [sentiment, setSentiment] = useState<number | null>(null);
  const [runData, setRunData] = useState({ distance_km: '', duration_min: '', rpe: '', pace: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function setCell(exId: string, idx: number, key: keyof SetRow, val: string) {
    setSets(prev => ({
      ...prev,
      [exId]: prev[exId].map((r, i) => i === idx ? { ...r, [key]: val } : r),
    }));
  }
  function addSet(exId: string) {
    setSets(prev => ({ ...prev, [exId]: [...prev[exId], {}] }));
  }
  function removeSet(exId: string, idx: number) {
    setSets(prev => ({ ...prev, [exId]: prev[exId].filter((_, i) => i !== idx) }));
  }

  async function save(status: 'done' | 'skipped') {
    setBusy(true); setErr(null);
    try {
      let data: any = {};
      if (isGym) {
        const cleanedSets: Record<string, any[]> = {};
        for (const [exId, rows] of Object.entries(sets)) {
          const filtered = rows.filter(r => r.w || r.r);
          if (filtered.length > 0) {
            cleanedSets[exId] = filtered.map(r => ({
              w: r.w ? Number(r.w) || r.w : undefined,
              r: r.r ? Number(r.r) || r.r : undefined,
              rir: r.rir ? Number(r.rir) : undefined,
              note: r.note || undefined,
            }));
          }
        }
        data = { day_code: plan.day_code, sets: cleanedSets };
      } else if (plan.type === 'run' || plan.type === 'bike' || plan.type === 'swim') {
        data = {
          distance_km: runData.distance_km ? Number(runData.distance_km) : undefined,
          duration_min: runData.duration_min ? Number(runData.duration_min) : undefined,
          rpe: runData.rpe ? Number(runData.rpe) : undefined,
          pace: runData.pace || undefined,
        };
      }
      const res = await fetch('/api/activities', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          plan_id: plan.id, date: plan.date, type: plan.type, status,
          sentiment, notes: notes || undefined, data,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { activity_id } = await res.json();
      router.push(`/history/${activity_id}`);
    } catch (e: any) { setErr(e.message); setBusy(false); }
  }

  return (
    <main className="max-w-xl mx-auto px-4 py-6 pb-28">
      <Link href="/today" className="text-xs text-muted">← cancel</Link>
      <h1 className="text-2xl font-bold tracking-tight mt-2">
        Log · {plan.type}{plan.day_code ? ` · ${plan.day_code}` : ''}
      </h1>
      <p className="text-xs text-muted">{plan.date}</p>
      {plan.prescription?.notes_top && (
        <p className="text-xs italic text-muted mt-2">{plan.prescription.notes_top}</p>
      )}

      {isGym && exercises.length > 0 && (
        <section className="mt-4 space-y-3">
          {exercises.map(ex => (
            <div key={ex.exercise_id} className="rounded-xl bg-panel border border-border p-3">
              <div className="flex items-baseline justify-between">
                <div className="font-medium">{exName(ex.exercise_id)}</div>
                <div className="text-[11px] text-muted">{ex.weight_hint ?? ''} {ex.reps ? `· ${ex.reps}` : ''}</div>
              </div>
              {ex.notes && <p className="text-[11px] italic text-muted mt-0.5">{ex.notes}</p>}
              <div className="mt-2 space-y-1.5">
                {sets[ex.exercise_id].map((row, i) => (
                  <div key={i} className="flex items-center gap-1.5 text-sm">
                    <span className="text-xs text-muted w-6">#{i + 1}</span>
                    <input type="number" step="0.5" placeholder="wt" value={row.w ?? ''} onChange={e => setCell(ex.exercise_id, i, 'w', e.target.value)} className="w-16 bg-panel-2 border border-border rounded px-2 py-1.5" />
                    <input type="number" placeholder="reps" value={row.r ?? ''} onChange={e => setCell(ex.exercise_id, i, 'r', e.target.value)} className="w-16 bg-panel-2 border border-border rounded px-2 py-1.5" />
                    <input type="number" placeholder="RIR" value={row.rir ?? ''} onChange={e => setCell(ex.exercise_id, i, 'rir', e.target.value)} className="w-14 bg-panel-2 border border-border rounded px-2 py-1.5" />
                    <input placeholder="note" value={row.note ?? ''} onChange={e => setCell(ex.exercise_id, i, 'note', e.target.value)} className="flex-1 bg-panel-2 border border-border rounded px-2 py-1.5 min-w-0" />
                    <button onClick={() => removeSet(ex.exercise_id, i)} className="text-muted text-xs px-1">×</button>
                  </div>
                ))}
                <button onClick={() => addSet(ex.exercise_id)} className="text-xs text-accent">+ set</button>
              </div>
            </div>
          ))}
        </section>
      )}

      {(plan.type === 'run' || plan.type === 'bike' || plan.type === 'swim') && (
        <section className="mt-4 rounded-xl bg-panel border border-border p-3 space-y-2">
          <div className="flex gap-2">
            <label className="flex-1">
              <span className="text-[11px] text-muted">Distance (km)</span>
              <input type="number" step="0.1" value={runData.distance_km} onChange={e => setRunData(d => ({ ...d, distance_km: e.target.value }))} className="w-full mt-0.5 bg-panel-2 border border-border rounded px-2 py-1.5" />
            </label>
            <label className="flex-1">
              <span className="text-[11px] text-muted">Duration (min)</span>
              <input type="number" value={runData.duration_min} onChange={e => setRunData(d => ({ ...d, duration_min: e.target.value }))} className="w-full mt-0.5 bg-panel-2 border border-border rounded px-2 py-1.5" />
            </label>
          </div>
          <div className="flex gap-2">
            <label className="flex-1">
              <span className="text-[11px] text-muted">Pace (e.g. 5:30/km)</span>
              <input value={runData.pace} onChange={e => setRunData(d => ({ ...d, pace: e.target.value }))} className="w-full mt-0.5 bg-panel-2 border border-border rounded px-2 py-1.5" />
            </label>
            <label className="w-20">
              <span className="text-[11px] text-muted">RPE</span>
              <input type="number" min={1} max={10} value={runData.rpe} onChange={e => setRunData(d => ({ ...d, rpe: e.target.value }))} className="w-full mt-0.5 bg-panel-2 border border-border rounded px-2 py-1.5" />
            </label>
          </div>
        </section>
      )}

      <section className="mt-4 rounded-xl bg-panel border border-border p-3">
        <div className="text-[11px] text-muted mb-1">How did it feel?</div>
        <div className="flex gap-1.5">
          {[1, 2, 3, 4, 5].map(n => (
            <button key={n} onClick={() => setSentiment(s => s === n ? null : n)} className={`flex-1 py-2 rounded text-sm border ${sentiment === n ? 'bg-accent text-black border-accent' : 'bg-panel-2 border-border'}`}>
              {['😵','😕','😐','🙂','💪'][n - 1]}
            </button>
          ))}
        </div>
        <textarea
          placeholder="Notes (energy, soreness, what went well, what to change)"
          value={notes}
          onChange={e => setNotes(e.target.value)}
          className="w-full mt-3 bg-panel-2 border border-border rounded px-2 py-2 text-sm min-h-[60px]"
        />
      </section>

      {err && <p className="text-xs text-danger mt-3">{err}</p>}

      <div className="mt-4 grid grid-cols-2 gap-2">
        <button onClick={() => save('skipped')} disabled={busy} className="bg-panel border border-border rounded-lg py-3 text-sm disabled:opacity-50">Mark skipped</button>
        <button onClick={() => save('done')} disabled={busy} className="bg-accent text-black font-semibold rounded-lg py-3 disabled:opacity-50">{busy ? 'Saving…' : 'Save as done'}</button>
      </div>
    </main>
  );
}
