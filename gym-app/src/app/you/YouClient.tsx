'use client';
import { useState, useTransition } from 'react';
import Link from 'next/link';
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
      <header className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-tiny text-muted uppercase tracking-wider">You</div>
          <h1 className="text-2xl font-bold tracking-tight truncate">{user.email.split('@')[0]}</h1>
          <div className="text-small text-muted-2 mt-0.5 truncate">{user.email}</div>
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
    <div className="shrink-0 w-12 h-12 rounded-full bg-panel-2 border border-border flex items-center justify-center text-lg font-semibold text-muted-2">
      {initial}
    </div>
  );
}

/* ───────────────────── Phase (demoted — contextual only) ───────────────────── */

function PhaseSection({ activePhase, phases }: { activePhase: Phase | null; phases: Phase[] }) {
  if (!activePhase) {
    return (
      <section className="rounded-xl bg-panel border border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="text-small text-muted-2">No active training phase.</div>
        </div>
      </section>
    );
  }

  const endsOn = activePhase.target_ends_on;
  return (
    <section className="rounded-xl bg-panel border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-tiny text-muted uppercase tracking-wider">Training phase</div>
          <div className="flex items-baseline gap-2 mt-1">
            <div className="text-lg font-semibold">{activePhase.name}</div>
            <div className="text-tiny text-muted-2 uppercase tracking-wider">{activePhase.code}</div>
          </div>
          {endsOn && (
            <div className="text-small text-muted-2 mt-1">
              Aims to end {format(new Date(endsOn + 'T00:00:00'), 'MMM d, yyyy')}
            </div>
          )}
        </div>
      </div>

      <details className="mt-3">
        <summary className="text-tiny text-muted cursor-pointer">What does phase mean?</summary>
        <p className="text-tiny text-muted-2 mt-2 leading-relaxed">
          A phase is a multi-week block with a specific training focus (e.g. a cut, a base-build, a peak).
          Claude uses the current phase to bias weekly targets, exercise selection, and load. You don&apos;t need to manage this
          — new phases are created as your training evolves.
        </p>
        {phases.length > 1 && (
          <ul className="mt-3 space-y-1">
            {phases.map(p => (
              <li key={p.id} className="flex items-center justify-between text-tiny py-0.5">
                <span className={p.status === 'active' ? '' : 'text-muted-2'}>
                  <span className="font-medium">{p.name}</span>
                  <span className="text-muted-2"> · {p.code}</span>
                </span>
                <span className="text-muted">{p.status}</span>
              </li>
            ))}
          </ul>
        )}
      </details>
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
        className="w-full flex items-center justify-between gap-2 px-4 py-3 text-left"
      >
        <div className="min-w-0">
          <div className="text-tiny text-muted uppercase tracking-wider">Exercise library</div>
          <div className="text-small mt-0.5 truncate">
            {items.length} exercises
            <span className="text-muted-2"> · {likedCount} liked · {bannedCount} avoided</span>
          </div>
        </div>
        <span className={`text-muted transition-transform shrink-0 ${expanded ? 'rotate-90' : ''}`}>›</span>
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
              <li key={e.id} className="flex items-center gap-2">
                <Link
                  href={`/exercise/${encodeURIComponent(e.id)}`}
                  className="flex-1 min-w-0 px-3 py-2.5 hover:bg-panel-2/60"
                >
                  <div className="text-small font-medium truncate">{e.name}</div>
                  <div className="text-tiny text-muted">{e.phases.join(' · ') || 'never prescribed'}</div>
                </Link>
                <div className="flex gap-1 pr-2">
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
          <p className="text-tiny text-muted mt-2">Tap a name to see cues, history, and progression.</p>
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
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${google.connected ? 'bg-ok' : 'bg-muted'}`} />
        <div className="text-small min-w-0">
          {google.connected
            ? <>Connected{google.expiresAt ? <span className="text-muted-2"> · expires {format(new Date(google.expiresAt), 'MMM d, p')}</span> : null}</>
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
                <span className="text-small font-medium flex-1 min-w-0 truncate">Pull events</span>
                <input type="number" min={7} max={365} value={pullDays} onChange={e => setPullDays(Number(e.target.value))} className="w-16 bg-panel-2 border border-border rounded px-2 py-1 text-small shrink-0" />
                <span className="text-tiny text-muted shrink-0">days</span>
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
                <span className="text-small font-medium flex-1 min-w-0 truncate">Push planned sessions</span>
                <input type="number" min={1} max={60} value={pushDays} onChange={e => setPushDays(Number(e.target.value))} className="w-16 bg-panel-2 border border-border rounded px-2 py-1 text-small shrink-0" />
                <span className="text-tiny text-muted shrink-0">days</span>
              </div>
              <button
                disabled={!!busy}
                onClick={() => call('/api/calendar/push', { calendar_id: calendarId, horizon_days: pushDays, time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone }, 'Push')}
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
