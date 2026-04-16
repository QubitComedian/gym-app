'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { DictationButton } from '@/components/ui/Dictation';
import { appendTranscript } from '@/components/ui/DictationInput';

const TYPES = ['gym', 'run', 'bike', 'swim', 'yoga', 'climb', 'sauna_cold', 'mobility', 'rest', 'other'] as const;

export default function AddClient({ defaultDate }: { defaultDate: string }) {
  const router = useRouter();
  const [date, setDate] = useState(defaultDate);
  const [type, setType] = useState<(typeof TYPES)[number]>('gym');
  const [notes, setNotes] = useState('');
  const [duration, setDuration] = useState('');
  const [distance, setDistance] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy(true); setErr(null);
    try {
      const data: any = {};
      if (duration) data.duration_min = Number(duration);
      if (distance) data.distance_km = Number(distance);
      const res = await fetch('/api/activities', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ date, type, status: 'unplanned', notes: notes || undefined, data }),
      });
      if (!res.ok) throw new Error(await res.text());
      await res.json();
      router.push(`/calendar/${date}`);
    } catch (e: any) { setErr(e.message); setBusy(false); }
  }

  return (
    <main className="max-w-xl mx-auto px-4 py-6 pb-28">
      <Link href="/today" className="text-xs text-muted">← cancel</Link>
      <h1 className="text-2xl font-bold tracking-tight mt-2">Add session</h1>
      <p className="text-xs text-muted">Quick log — for full gym sets, use a planned session.</p>

      <div className="mt-4 space-y-3">
        <label className="block">
          <span className="text-[11px] text-muted">Date</span>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} className="w-full mt-0.5 bg-panel-2 border border-border rounded px-2 py-2" />
        </label>
        <div>
          <span className="text-[11px] text-muted">Type</span>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {TYPES.map(t => (
              <button key={t} onClick={() => setType(t)} className={`px-3 py-1.5 rounded-full text-xs border ${type === t ? 'bg-accent text-black border-accent' : 'bg-panel border-border text-muted'}`}>
                {t}
              </button>
            ))}
          </div>
        </div>
        {(type === 'run' || type === 'bike' || type === 'swim') && (
          <div className="flex gap-2">
            <label className="flex-1">
              <span className="text-[11px] text-muted">Distance (km)</span>
              <input type="number" step="0.1" value={distance} onChange={e => setDistance(e.target.value)} className="w-full mt-0.5 bg-panel-2 border border-border rounded px-2 py-2" />
            </label>
            <label className="flex-1">
              <span className="text-[11px] text-muted">Duration (min)</span>
              <input type="number" value={duration} onChange={e => setDuration(e.target.value)} className="w-full mt-0.5 bg-panel-2 border border-border rounded px-2 py-2" />
            </label>
          </div>
        )}
        {(type === 'yoga' || type === 'climb' || type === 'mobility' || type === 'sauna_cold') && (
          <label className="block">
            <span className="text-[11px] text-muted">Duration (min)</span>
            <input type="number" value={duration} onChange={e => setDuration(e.target.value)} className="w-full mt-0.5 bg-panel-2 border border-border rounded px-2 py-2" />
          </label>
        )}
        <label className="block">
          <span className="text-[11px] text-muted">Notes</span>
          <div className="relative mt-0.5">
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              className="w-full bg-panel-2 border border-border rounded px-2 py-2 min-h-[80px] pr-10"
            />
            <div className="absolute bottom-2 right-2">
              <DictationButton
                size="sm"
                compact
                onTranscript={(t: string) => setNotes((prev) => appendTranscript(prev, t))}
              />
            </div>
          </div>
        </label>
      </div>

      {err && <p className="text-xs text-danger mt-3">{err}</p>}
      <button onClick={save} disabled={busy} className="mt-4 w-full bg-accent text-black font-semibold rounded-lg py-3 disabled:opacity-50">
        {busy ? 'Saving…' : 'Save'}
      </button>
    </main>
  );
}
