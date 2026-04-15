'use client';
import { useState } from 'react';

export default function SettingsClient({ hasToken }: { hasToken: boolean }) {
  const [calendarId, setCalendarId] = useState('primary');
  const [pullDays, setPullDays] = useState(90);
  const [pushDays, setPushDays] = useState(14);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function call(path: string, body: any, label: string) {
    setBusy(label); setMsg(null);
    try {
      const res = await fetch(path, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'failed');
      setMsg(`${label}: ` + JSON.stringify(j));
    } catch (e: any) { setMsg(`${label} error: ${e.message}`); }
    finally { setBusy(null); }
  }

  return (
    <section className="rounded-xl bg-panel border border-border p-4 space-y-4">
      <label className="block">
        <span className="text-[11px] text-muted">Calendar ID</span>
        <input value={calendarId} onChange={e => setCalendarId(e.target.value)} className="w-full mt-0.5 bg-panel-2 border border-border rounded px-2 py-1.5 text-sm" />
      </label>

      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-medium flex-1">Pull events from calendar</span>
          <input type="number" min={7} max={365} value={pullDays} onChange={e => setPullDays(Number(e.target.value))} className="w-20 bg-panel-2 border border-border rounded px-2 py-1 text-sm" />
          <span className="text-[11px] text-muted">days</span>
        </div>
        <button disabled={!hasToken || !!busy} onClick={() => call('/api/calendar/sync', { calendar_id: calendarId, days: pullDays }, 'Pull')} className="w-full bg-panel-2 border border-border rounded py-2 text-sm disabled:opacity-50">
          {busy === 'Pull' ? '…' : 'Pull from Google Calendar'}
        </button>
      </div>

      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-medium flex-1">Push planned sessions to calendar</span>
          <input type="number" min={1} max={60} value={pushDays} onChange={e => setPushDays(Number(e.target.value))} className="w-20 bg-panel-2 border border-border rounded px-2 py-1 text-sm" />
          <span className="text-[11px] text-muted">days</span>
        </div>
        <button disabled={!hasToken || !!busy} onClick={() => call('/api/calendar/push', { calendar_id: calendarId, horizon_days: pushDays }, 'Push')} className="w-full bg-accent text-black font-semibold rounded py-2 text-sm disabled:opacity-50">
          {busy === 'Push' ? '…' : 'Push planned sessions'}
        </button>
      </div>

      {msg && <div className="text-[11px] text-muted whitespace-pre-wrap break-all">{msg}</div>}
    </section>
  );
}
