'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function ReplanClient() {
  const router = useRouter();
  const [horizon, setHorizon] = useState(14);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch('/api/ai/replan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ horizon_days: horizon, instruction }),
      });
      if (!res.ok) throw new Error(await res.text());
      router.push('/proposals');
    } catch (e: any) { setErr(e.message); setBusy(false); }
  }

  return (
    <main className="max-w-xl mx-auto px-4 py-6 pb-28">
      <Link href="/today" className="text-xs text-muted">← cancel</Link>
      <h1 className="text-2xl font-bold tracking-tight mt-2">Ask AI to replan</h1>
      <p className="text-xs text-muted">Claude will look at your brief, current phase, recent activity, and your upcoming plans, and propose a diff.</p>

      <div className="mt-4 space-y-3">
        <label className="block">
          <span className="text-[11px] text-muted">Horizon (days)</span>
          <input type="number" min={7} max={60} value={horizon} onChange={e => setHorizon(Number(e.target.value))} className="w-full mt-0.5 bg-panel-2 border border-border rounded px-2 py-2" />
        </label>
        <label className="block">
          <span className="text-[11px] text-muted">Anything specific? (optional)</span>
          <textarea
            placeholder="e.g. shoulder feels off, traveling Wed–Fri, want to push pull-ups"
            value={instruction} onChange={e => setInstruction(e.target.value)}
            className="w-full mt-0.5 bg-panel-2 border border-border rounded px-2 py-2 min-h-[80px]"
          />
        </label>
      </div>
      {err && <p className="text-xs text-danger mt-3">{err}</p>}
      <button onClick={go} disabled={busy} className="mt-4 w-full bg-accent text-black font-semibold rounded-lg py-3 disabled:opacity-50">
        {busy ? 'Asking Claude…' : 'Generate proposal'}
      </button>
    </main>
  );
}
