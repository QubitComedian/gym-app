'use client';
import { useState, useTransition } from 'react';
import { supabaseBrowser } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';
import { format } from 'date-fns';
import { useToast } from '@/components/ui/Toast';

type Phase = { id: string; code: string; name: string; status: string; target_ends_on: string | null; ordinal: number };
type Exercise = { id: string; name: string; phases: string[]; pref: any | null };

export default function YouClient({
  user, activePhase, phases, google, exercises,
}: {
  user: { email: string; id: string };
  activePhase: Phase | null;
  phases: Phase[];
  google: { connected: boolean; expiresAt: string | null; eventCount: number; linkCount: number };
  exercises: Exercise[];
}) {
  return (
    <main className="max-w-xl mx-auto px-4 pt-5 pb-28 space-y-5">
      <header className="flex items-center justify-between">
        <div>
          <div className="text-tiny text-muted uppercase tracking-wider">You</div>
          <h1 className="text-2xl font-bold tracking-tight">{user.email.split('@')[0]}</h1>
          <div className="text-small text-muted-2 mt-0.5">{user.email}</div>
        </div>
        <Avatar email={user.email} />
      </header>

      <PhaseSection activePhase={activePhase} phases={phases} />
      <ExercisesSection exercises={exercises} />
      <GoogleSection google={google} />
      <AccountSection />
    </main>
  );
}

function Avatar({ email }: { email: string }) {
  const initial = (email[0] ?? '?').toUpperCase();
  return (
    <div className="w-12 h-12 rounded-full bg-panel-2 border border-border flex items-center justify-center text-lg font-semibold text-muted-2">
      {initial}
    </div>
  );
}

/* ───────────────────── Phase ───────────────────── */

function PhaseSection({ activePhase, phases }: { activePhase: Phase | null; phases: Phase[] }) {
  const [target, setTarget] = useState(activePhase?.target_ends_on ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const { push } = useToast();

  async function save() {
    if (!activePhase) return;
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/phases', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: activePhase.id, target_ends_on: target || null }),
      });
      if (!res.ok) throw new Error(await res.text());
      push({ kind: 'success', title: 'Phase updated' });
    } catch (e: any) { setMsg(e.message); }
    finally { setBusy(false); }
  }

  return (
    <section className="rounded-xl bg-panel border border-border p-4">
      <div className="text-tiny text-muted uppercase tracking-wider mb-2">Current phase</div>
      {activePhase ? (
        <>
          <div className="flex items-baseline gap-2">
            <div className="text-lg font-semibold">{activePhase.code}</div>
            <div className="text-small text-muted-2">· {activePhase.name}</div>
          </div>
          <label className="block mt-3">
            <span className="text-tiny text-muted">Target end date</span>
            <input
              type="date"
              value={target}
              onChange={e => setTarget(e.target.value)}
              className="w-full mt-1 bg-panel-2 border border-border rounded-lg px-3 py-2 text-small"
            />
          </label>
          <button
            onClick={save}
            disabled={busy}
            className="mt-3 px-4 py-2 rounded-lg bg-accent text-black font-semibold text-small disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          {msg && <div className="text-tiny text-danger mt-2">{msg}</div>}
        </>
      ) : (
        <div className="text-small text-muted-2">No active phase.</div>
      )}

      {phases.length > 1 && (
        <details className="mt-4">
          <summary className="text-tiny text-muted cursor-pointer">All phases</summary>
          <ul className="mt-2 space-y-1">
            {phases.map(p => (
              <li key={p.id} className="flex items-center justify-between text-small py-1">
                <span>
                  <span className="font-medium">{p.code}</span>
                  <span className="text-muted-2"> · {p.name}</span>
                </span>
                <span className="text-tiny text-muted">{p.status}{p.target_ends_on ? ` · ends ${p.target_ends_on}` : ''}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/* ───────────────────── Exercises ───────────────────── */

const STATUS_BTN = [
  { v: 'liked', label: '❤︎', cls: 'bg-ok/20 text-ok border-ok/40' },
  { v: 'neutral', label: '–', cls: 'bg-panel-2 text-muted border-border' },
  { v: 'banned', label: '⌀', cls: 'bg-danger/20 text-danger border-danger/40' },
];

function ExercisesSection({ exercises }: { exercises: Exercise[] }) {
  const [items, setItems] = useState(exercises);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [pending, start] = useTransition();

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
  const likedCount = items.filter(e => e.pref?.status === 'liked').length;
  const bannedCount = items.filter(e => e.pref?.status === 'banned').length;

  return (
    <section className="rounded-xl bg-panel border border-border">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
      >
        <div>
          <div className="text-tiny text-muted uppercase tracking-wider">Exercise library</div>
          <div className="text-small mt-0.5">
            {items.length} exercises
            <span className="text-muted-2"> · {likedCount} liked · {bannedCount} avoided</span>
          </div>
        </div>
        <span className={`text-muted transition-transform ${expanded ? 'rotate-90' : ''}`}>›</span>
      </button>
      {expanded && (
        <div className="px-4 pb-4 border-t border-border pt-3 animate-fade-in">
          <input
            placeholder="Filter…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="w-full mb-3 bg-panel-2 border border-border rounded-lg px-3 py-2 text-small"
          />
          <ul className="rounded-lg bg-panel-2/40 border border-border divide-y divide-border overflow-hidden">
            {visible.map(e => (
              <li key={e.id} className="px-3 py-2.5 flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-small font-medium truncate">{e.name}</div>
                  <div className="text-tiny text-muted">{e.phases.join(' · ')}</div>
                </div>
                <div className="flex gap-1">
                  {STATUS_BTN.map(s => {
                    const active = (e.pref?.status ?? 'neutral') === s.v;
                    return (
                      <button
                        key={s.v}
                        disabled={pending}
                        onClick={() => setPref(e.id, s.v)}
                        className={`w-8 h-8 rounded-md text-small border ${active ? s.cls : 'bg-panel border-border text-muted opacity-60'}`}
                        title={s.v}
                      >
                        {s.label}
                      </button>
                    );
                  })}
                </div>
              </li>
            ))}
            {visible.length === 0 && <li className="px-3 py-6 text-center text-small text-muted">No matches.</li>}
          </ul>
          <p className="text-tiny text-muted mt-2">Claude uses this when proposing changes.</p>
        </div>
      )}
    </section>
  );
}

/* ───────────────────── Google Calendar ───────────────────── */

function GoogleSection({ google }: { google: { connected: boolean; expiresAt: string | null; eventCount: number; linkCount: number } }) {
  const [pullDays, setPullDays] = useState(90);
  const [pushDays, setPushDays] = useState(14);
  const [calendarId, setCalendarId] = useState('primary');
  const [busy, setBusy] = useState<string | null>(null);
  const { push } = useToast();

  async function call(path: string, body: any, label: string) {
    setBusy(label);
    try {
      const res = await fetch(path, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'failed');
      push({ kind: 'success', title: `${label} complete`, description: j.upserted ? `${j.upserted} events` : undefined });
    } catch (e: any) { push({ kind: 'info', title: `${label} failed`, description: e.message }); }
    finally { setBusy(null); }
  }

  return (
    <section className="rounded-xl bg-panel border border-border p-4">
      <div className="text-tiny text-muted uppercase tracking-wider mb-2">Google Calendar</div>
      <div className="flex items-center gap-2 mb-1">
        <span className={`inline-block w-2 h-2 rounded-full ${google.connected ? 'bg-ok' : 'bg-muted'}`} />
        <div className="text-small">
          {google.connected
            ? <>Connected{google.expiresAt ? <span className="text-muted-2"> · token expires {format(new Date(google.expiresAt), 'MMM d, p')}</span> : null}</>
            : 'Not connected'}
        </div>
      </div>
      <div className="text-tiny text-muted">{google.eventCount} events imported · {google.linkCount} plans pushed</div>

      {!google.connected && (
        <p className="text-tiny text-muted-2 mt-3">Sign out and back in to grant calendar access.</p>
      )}

      {google.connected && (
        <>
          <div className="mt-4 space-y-3">
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-small font-medium flex-1">Pull events</span>
                <input type="number" min={7} max={365} value={pullDays} onChange={e => setPullDays(Number(e.target.value))} className="w-16 bg-panel-2 border border-border rounded px-2 py-1 text-small" />
                <span className="text-tiny text-muted">days</span>
              </div>
              <button
                disabled={!!busy}
                onClick={() => call('/api/calendar/sync', { calendar_id: calendarId, days: pullDays }, 'Pull')}
                className="w-full bg-panel-2 border border-border rounded-lg py-2 text-small disabled:opacity-50"
              >
                {busy === 'Pull' ? 'Pulling…' : 'Pull from Google Calendar'}
              </button>
            </div>

            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-small font-medium flex-1">Push planned sessions</span>
                <input type="number" min={1} max={60} value={pushDays} onChange={e => setPushDays(Number(e.target.value))} className="w-16 bg-panel-2 border border-border rounded px-2 py-1 text-small" />
                <span className="text-tiny text-muted">days</span>
              </div>
              <button
                disabled={!!busy}
                onClick={() => call('/api/calendar/push', { calendar_id: calendarId, horizon_days: pushDays }, 'Push')}
                className="w-full bg-panel-2 border border-border rounded-lg py-2 text-small disabled:opacity-50"
              >
                {busy === 'Push' ? 'Pushing…' : 'Push planned sessions'}
              </button>
            </div>
          </div>

          <details className="mt-4">
            <summary className="text-tiny text-muted cursor-pointer">Advanced</summary>
            <label className="block mt-2">
              <span className="text-tiny text-muted">Calendar ID (leave as primary unless gym events are in a different calendar)</span>
              <input value={calendarId} onChange={e => setCalendarId(e.target.value)} className="w-full mt-1 bg-panel-2 border border-border rounded px-2 py-1.5 text-small" />
            </label>
          </details>
        </>
      )}
    </section>
  );
}

/* ───────────────────── Account ───────────────────── */

function AccountSection() {
  const router = useRouter();
  async function signOut() {
    await supabaseBrowser().auth.signOut();
    router.push('/login');
  }
  return (
    <section className="rounded-xl bg-panel border border-border p-4">
      <div className="text-tiny text-muted uppercase tracking-wider mb-2">Account</div>
      <button onClick={signOut} className="text-small text-danger">Sign out</button>
    </section>
  );
}
