'use client';
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { supabaseBrowser } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';
import { format } from 'date-fns';
import { useToast } from '@/components/ui/Toast';
import WindowGlyph from '@/components/ui/WindowGlyph';
import WeightTracker from '@/components/WeightTracker';
import IntegrationCards from '@/components/IntegrationCards';
import {
  KIND_META,
  formatRange,
  relativeWindowPhrase,
  resolvedStrategyLabel,
} from '@/lib/availability/ui';
import type {
  AvailabilityWindowKind,
  AvailabilityWindowStrategy,
} from '@/lib/reconcile/rollForward.pure';

type Phase = { id: string; code: string; name: string; status: string; target_ends_on: string | null; ordinal: number };
type Exercise = { id: string; name: string; phases: string[]; pref: any | null };

type AvailabilitySummary = {
  todayIso: string;
  activeNow: {
    id: string;
    starts_on: string;
    ends_on: string;
    kind: AvailabilityWindowKind;
    strategy: AvailabilityWindowStrategy;
  } | null;
  upcomingCount: number;
  totalActive: number;
};

type WeeklySlot = { type: string; day_code: string | null };
type WeeklyPattern = Partial<Record<'SU' | 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA', WeeklySlot>>;
type PhasePattern = { phase_id: string; pattern: WeeklyPattern };

// DOW ordering for the tile strip. Monday-first reads more naturally for
// training weeks than Sunday-first.
const DOW_ORDER: Array<'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU'> = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const DOW_LABEL: Record<string, string> = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' };
const DOW_SHORT: Record<string, string> = { MO: 'M', TU: 'T', WE: 'W', TH: 'T', FR: 'F', SA: 'S', SU: 'S' };

// Pairs with Tailwind tokens already in use elsewhere (bg-panel-2, accent-soft…).
const TYPE_STYLE: Record<string, { bg: string; ring: string; text: string; icon: string; label: string }> = {
  gym:  { bg: 'bg-accent-soft',     ring: 'ring-accent/40',  text: 'text-accent',  icon: '🏋️', label: 'Gym' },
  run:  { bg: 'bg-ok/15',           ring: 'ring-ok/40',      text: 'text-ok',      icon: '🏃', label: 'Run' },
  bike: { bg: 'bg-ok/15',           ring: 'ring-ok/40',      text: 'text-ok',      icon: '🚴', label: 'Bike' },
  swim: { bg: 'bg-ok/15',           ring: 'ring-ok/40',      text: 'text-ok',      icon: '🏊', label: 'Swim' },
  yoga: { bg: 'bg-accent-soft',     ring: 'ring-accent/40',  text: 'text-accent',  icon: '🧘', label: 'Yoga' },
  climb:{ bg: 'bg-accent-soft',     ring: 'ring-accent/40',  text: 'text-accent',  icon: '🧗', label: 'Climb' },
  rest: { bg: 'bg-panel-2',         ring: 'ring-border',     text: 'text-muted-2', icon: '·',  label: 'Rest' },
};

function typeStyle(type: string | undefined) {
  if (!type) return TYPE_STYLE.rest;
  return TYPE_STYLE[type] ?? { bg: 'bg-panel-2', ring: 'ring-border', text: 'text-muted', icon: '•', label: type };
}

export default function YouClient({
  user, activePhase, phases, google, exercises, weeklyPatterns, availability,
}: {
  user: { email: string; id: string };
  activePhase: Phase | null;
  phases: Phase[];
  google: { connected: boolean; expiresAt: string | null; eventCount: number; linkCount: number };
  exercises: Exercise[];
  weeklyPatterns: PhasePattern[];
  availability: AvailabilitySummary;
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
      <WeightTracker phaseIntent={inferPhaseIntent(activePhase)} />
      <IntegrationCards />
      <WeeklyTemplateSection activePhase={activePhase} weeklyPatterns={weeklyPatterns} />
      <AvailabilitySection availability={availability} />
      <ExercisesSection exercises={exercises} />
      <GoogleSection google={google} />
      <AccountSection />
    </main>
  );
}

/**
 * Infer whether the active phase is a cut / bulk / maintain, used by
 * WeightTracker to color the weekly delta chip. Phase codes follow the
 * pattern "C1" (cut), "B2" (bulk/build), "M1" (maintain); we fall back
 * to scanning the name for keywords for safety.
 */
function inferPhaseIntent(phase: Phase | null): 'cut' | 'bulk' | 'maintain' | null {
  if (!phase) return null;
  const code = (phase.code || '').toUpperCase();
  if (code.startsWith('C')) return 'cut';
  if (code.startsWith('B')) return 'bulk';
  if (code.startsWith('M')) return 'maintain';
  const name = (phase.name || '').toLowerCase();
  if (/cut|lean|deficit/.test(name))     return 'cut';
  if (/bulk|build|surplus|gain/.test(name)) return 'bulk';
  if (/maintain|peak|base/.test(name))   return 'maintain';
  return null;
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

/* ───────────────────── Weekly template (P1.1) ───────────────────── */

/**
 * Read-only snapshot of the active phase's weekly template, with seven
 * tinted day tiles (Mon-first) and a summary line. Tapping Edit deep-links
 * to /you/template for the active phase. If the user hasn't kicked off a
 * phase yet, the section explains why it's empty instead of rendering
 * blank tiles — better than an empty grid that looks broken.
 */
function WeeklyTemplateSection({
  activePhase,
  weeklyPatterns,
}: {
  activePhase: Phase | null;
  weeklyPatterns: PhasePattern[];
}) {
  if (!activePhase) {
    return (
      <section className="rounded-xl bg-panel border border-border p-4">
        <div className="text-tiny text-muted uppercase tracking-wider mb-1">Weekly template</div>
        <div className="text-small text-muted-2">
          Start a training phase to shape your week.
        </div>
      </section>
    );
  }

  const pattern = weeklyPatterns.find((p) => p.phase_id === activePhase.id)?.pattern ?? {};

  // Summary counts by type ("4 gym · 2 run · 1 rest"). Sorted so the most
  // common type leads, with rest always last for consistency.
  const counts = new Map<string, number>();
  for (const dow of DOW_ORDER) {
    const slot = pattern[dow];
    const type = slot?.type ?? 'rest';
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const summaryParts = Array.from(counts.entries())
    .sort((a, b) => {
      if (a[0] === 'rest') return 1;
      if (b[0] === 'rest') return -1;
      return b[1] - a[1];
    })
    .map(([type, n]) => `${n} ${typeStyle(type).label.toLowerCase()}`);

  // Today's DOW so we can ring it. UTC-safe via manual parse.
  const now = new Date();
  const todayDow = DOW_ORDER[(now.getDay() + 6) % 7]; // JS Sun=0 → shift so MO=0

  return (
    <section className="rounded-xl bg-panel border border-border p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="text-tiny text-muted uppercase tracking-wider">Weekly template</div>
          <div className="flex items-baseline gap-2 mt-1 flex-wrap">
            <div className="text-lg font-semibold">Your training week</div>
            <div className="text-tiny text-muted-2 uppercase tracking-wider shrink-0">{activePhase.code}</div>
          </div>
          <div className="text-small text-muted-2 mt-1 truncate">{summaryParts.join(' · ')}</div>
        </div>
        <Link
          href={`/you/template?phase=${activePhase.id}`}
          className="shrink-0 text-tiny font-semibold text-accent hover:underline whitespace-nowrap"
        >
          Edit →
        </Link>
      </div>

      <ul className="grid grid-cols-7 gap-1.5">
        {DOW_ORDER.map((dow) => {
          const slot = pattern[dow];
          const st = typeStyle(slot?.type ?? 'rest');
          const isToday = dow === todayDow;
          return (
            <li
              key={dow}
              className={`rounded-lg ${st.bg} ring-1 ${st.ring} ${isToday ? 'ring-2 ring-accent' : ''} px-1 py-2 text-center min-h-[72px] flex flex-col justify-between`}
            >
              <div className={`text-tiny uppercase tracking-wider ${isToday ? 'text-accent font-semibold' : 'text-muted-2'}`}>
                {DOW_SHORT[dow]}
              </div>
              <div className="text-base leading-none" aria-hidden>{st.icon}</div>
              <div className={`text-tiny ${st.text} font-medium truncate`}>
                {slot?.day_code ?? st.label}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ───────────────────── Availability (P1.3) ───────────────────── */

/**
 * Entry card for /you/availability. Surfaces the most important
 * window state at a glance:
 *
 *   - A window is active right now → show kind glyph + range + what
 *     the resolved strategy is (bodyweight / rest / hidden)
 *   - No active but something is upcoming → show "X queued" line
 *   - Nothing at all → brief explainer + single CTA
 *
 * Tapping the card (or the chevron) takes the user to the full list
 * where they can add / edit / cancel.
 */
function AvailabilitySection({ availability }: { availability: AvailabilitySummary }) {
  const { activeNow, upcomingCount, todayIso } = availability;

  // ---- Empty state ----------------------------------------------------
  if (!activeNow && upcomingCount === 0) {
    return (
      <section className="rounded-xl bg-panel border border-border p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-tiny text-muted uppercase tracking-wider">Availability</div>
            <div className="text-lg font-semibold mt-1">Plan around life</div>
            <p className="text-small text-muted-2 mt-1 leading-relaxed">
              Travelling, injured, or just need a break? Tell Claude when you&apos;re out and
              the week adjusts itself — bodyweight days, rest, or a clean pause.
            </p>
          </div>
        </div>
        <Link
          href="/you/availability"
          className="mt-3 inline-flex items-center gap-1.5 text-tiny font-semibold text-accent hover:underline"
        >
          Add a window
          <span aria-hidden>→</span>
        </Link>
      </section>
    );
  }

  // ---- Active + upcoming summary -------------------------------------
  return (
    <Link
      href="/you/availability"
      className="group block rounded-xl bg-panel border border-border p-4 transition hover:border-muted-2/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-tiny text-muted uppercase tracking-wider">Availability</div>
          {activeNow ? (
            <ActiveWindowRow
              kind={activeNow.kind}
              strategy={activeNow.strategy}
              startsOn={activeNow.starts_on}
              endsOn={activeNow.ends_on}
              todayIso={todayIso}
            />
          ) : (
            <div className="mt-1">
              <div className="text-lg font-semibold">Nothing active</div>
              <div className="text-small text-muted-2 mt-0.5">
                {upcomingCount === 1
                  ? '1 window queued for later'
                  : `${upcomingCount} windows queued for later`}
              </div>
            </div>
          )}
          {activeNow && upcomingCount > 0 && (
            <div className="text-tiny text-muted-2 mt-2">
              {upcomingCount === 1 ? '+1 more queued' : `+${upcomingCount} more queued`}
            </div>
          )}
        </div>
        <span
          className="shrink-0 mt-1 text-muted-2 transition group-hover:text-muted"
          aria-hidden
        >
          ›
        </span>
      </div>
    </Link>
  );
}

function ActiveWindowRow({
  kind,
  strategy,
  startsOn,
  endsOn,
  todayIso,
}: {
  kind: AvailabilityWindowKind;
  strategy: AvailabilityWindowStrategy;
  startsOn: string;
  endsOn: string;
  todayIso: string;
}) {
  const meta = KIND_META[kind];
  const remaining = relativeWindowPhrase(startsOn, endsOn, todayIso);
  const resolved = resolvedStrategyLabel(kind, strategy).toLowerCase();
  return (
    <div className="mt-1 flex items-center gap-2.5">
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${meta.tint.bg}`}
        aria-hidden
      >
        <WindowGlyph kind={kind} size={20} />
      </span>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-lg font-semibold">{meta.longLabel}</span>
          <span className="text-tiny text-muted-2 shrink-0">{formatRange(startsOn, endsOn)}</span>
        </div>
        <div className="text-tiny text-muted-2 mt-0.5">
          {remaining} · <span className="text-muted">{resolved}</span>
        </div>
      </div>
    </div>
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
  const [pushDays, setPushDays] = useState(14);
  const [busy, setBusy] = useState<string | null>(null);
  const { push } = useToast();

  async function pushSessions() {
    setBusy('push');
    try {
      const res = await fetch('/api/calendar/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          calendar_id: 'primary',
          horizon_days: pushDays,
          time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'failed');
      push({ kind: 'success', title: 'Sync complete', description: j.upserted ? `${j.upserted} events pushed` : 'Calendar is up to date' });
    } catch (e: any) {
      push({ kind: 'info', title: 'Sync failed', description: e.message });
    } finally {
      setBusy(null);
    }
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
      {google.connected && (
        <div className="text-tiny text-muted">{google.linkCount} session{google.linkCount === 1 ? '' : 's'} synced to calendar</div>
      )}

      {!google.connected && (
        <p className="text-tiny text-muted-2 mt-3">Sign out and back in to grant calendar access.</p>
      )}

      {google.connected && (
        <div className="mt-4">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-small font-medium flex-1 min-w-0 truncate">Push planned sessions</span>
            <input type="number" min={1} max={60} value={pushDays} onChange={e => setPushDays(Number(e.target.value))} className="w-16 bg-panel-2 border border-border rounded px-2 py-1 text-small shrink-0" />
            <span className="text-tiny text-muted shrink-0">days</span>
          </div>
          <button
            disabled={!!busy}
            onClick={pushSessions}
            className="w-full bg-panel-2 border border-border rounded-lg py-2 text-small disabled:opacity-50"
          >
            {busy === 'push' ? 'Syncing…' : 'Sync to Google Calendar'}
          </button>
          <p className="text-tiny text-muted-2 mt-2">
            Conflicts detected by the nightly scan will appear as proposals on your Today page.
          </p>
        </div>
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
