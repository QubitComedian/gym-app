/**
 * Today tab — weekly strip summarizer.
 * Builds the per-day dot state, the primary-volume metric, and phase
 * context for the week spanning Monday–Sunday around `onDate`.
 * Pure function — all inputs passed in, no DB access.
 */

import { addDays, differenceInCalendarWeeks, format, parseISO, startOfWeek, endOfWeek } from 'date-fns';
import { tonnageOf } from './wins';
import type {
  AvailabilityWindowKind,
  AvailabilityWindowStrategy,
} from './reconcile/rollForward.pure';

export type DayState =
  | 'today_planned' | 'today_done' | 'today_rest' | 'today_empty'
  | 'past_done' | 'past_skipped' | 'past_missed' | 'past_rest' | 'past_empty'
  | 'future_planned' | 'future_rest' | 'future_empty';

export type DayCell = {
  date: string;         // ISO yyyy-mm-dd
  dow: string;          // 'M' | 'T' | …
  state: DayState;
  type?: string;        // modality for glyph
  isToday: boolean;
  href: string;
  /**
   * Availability-window coverage for this day — undefined when no
   * active window covers it. Present for travel / injury / pause days
   * so the strip can overlay a small kind badge. The plan row itself
   * will already be rewritten by roll-forward; this is the visual cue
   * that says "this is a window day, not a normal template day".
   */
  window?: {
    kind: AvailabilityWindowKind;
    strategy: AvailabilityWindowStrategy;
  };
};

export type WeekSummary = {
  weekStartIso: string;
  weekEndIso: string;
  phase: { code: string; name: string; weekIndex: number; weekTotal: number | null } | null;
  days: DayCell[];
  sessionsDone: number;
  sessionsPlanned: number;
  tonnageKg: number;
  distanceKm: number;
  distanceM: number;
  activeMin: number;
  primary: { label: string; value: string } | null;
};

type PlanRow = { id?: string; date: string; type: string; day_code?: string | null; status: string };
type ActRow = { id?: string; date: string; type: string; status: string; data?: any; plan_id?: string | null };
type PhaseRow = { code: string; name: string; starts_on: string | null; target_ends_on: string | null };
type WindowRow = {
  starts_on: string;
  ends_on: string;
  kind: AvailabilityWindowKind;
  strategy: AvailabilityWindowStrategy;
};

const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;

export function summarizeWeek(opts: {
  onDate: string;
  plans: PlanRow[];
  activities: ActRow[];
  phase: PhaseRow | null;
  /** Active availability windows that might intersect this week. Optional — callers that don't care about window overlays can omit. */
  windows?: WindowRow[];
}): WeekSummary {
  const today = parseISO(opts.onDate + 'T00:00:00');
  const weekStart = startOfWeek(today, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(today, { weekStartsOn: 1 });
  const weekStartIso = format(weekStart, 'yyyy-MM-dd');
  const weekEndIso = format(weekEnd, 'yyyy-MM-dd');

  // Index plans + activities by date
  const planByDate = new Map<string, PlanRow>();
  for (const p of opts.plans) {
    if (!planByDate.has(p.date)) planByDate.set(p.date, p);
  }
  const actByDate = new Map<string, ActRow>();
  for (const a of opts.activities) {
    // Prefer a done activity that ties to the plan for that day
    const existing = actByDate.get(a.date);
    if (!existing || (a.status === 'done' && existing.status !== 'done')) {
      actByDate.set(a.date, a);
    }
  }

  const windows = opts.windows ?? [];
  const days: DayCell[] = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStart, i);
    const iso = format(d, 'yyyy-MM-dd');
    const isToday = iso === opts.onDate;
    const isPast = d < today && !isToday;
    const plan = planByDate.get(iso) ?? null;
    const act = actByDate.get(iso) ?? null;
    const type = act?.type ?? plan?.type;
    const state = dayState({ isToday, isPast, plan, act });
    // Inclusive coverage test. Overlap-free invariant means at most
    // one window matches; if the invariant ever slipped we surface the
    // first we find (strip is visual-only, so ties are cosmetic).
    const covering = windows.find(w => w.starts_on <= iso && w.ends_on >= iso);
    days.push({
      date: iso,
      dow: DOW[i],
      state,
      type,
      isToday,
      href: isToday ? '/today' : `/calendar/${iso}`,
      window: covering
        ? { kind: covering.kind, strategy: covering.strategy }
        : undefined,
    });
  }

  // Counts: planned = plans in the week that aren't rest; done = activities in the week that are status=done and type != rest
  const weekPlans = opts.plans.filter(p => p.date >= weekStartIso && p.date <= weekEndIso && p.type !== 'rest');
  const weekDone = opts.activities.filter(a => a.date >= weekStartIso && a.date <= weekEndIso && a.status === 'done' && a.type !== 'rest');
  const sessionsPlanned = weekPlans.length;
  const sessionsDone = weekDone.length;

  // Volumes
  const tonnageKg = weekDone.reduce((s, a) => s + tonnageOf(a), 0);
  let distanceKm = 0;
  let distanceM = 0;
  let activeMin = 0;
  for (const a of weekDone) {
    const d = a.data ?? {};
    if (typeof d.distance_km === 'number') distanceKm += d.distance_km;
    if (typeof d.distance_m === 'number') distanceM += d.distance_m;
    const mins = typeof d.duration_actual_min === 'number'
      ? d.duration_actual_min
      : typeof d.duration_min === 'number' ? d.duration_min : 0;
    if (mins) activeMin += mins;
  }

  // Primary volume — tonnage → distance → minutes
  const primary = (() => {
    if (tonnageKg > 0) return { label: 'volume', value: formatKg(tonnageKg) };
    if (distanceKm > 0 || distanceM > 0) {
      const totalKm = distanceKm + distanceM / 1000;
      return { label: 'distance', value: formatKm(totalKm) };
    }
    if (activeMin > 0) return { label: 'active', value: formatMinutes(activeMin) };
    return null;
  })();

  // Phase context
  let phase: WeekSummary['phase'] = null;
  if (opts.phase) {
    let weekIndex = 1;
    let weekTotal: number | null = null;
    if (opts.phase.starts_on) {
      const start = parseISO(opts.phase.starts_on + 'T00:00:00');
      weekIndex = Math.max(1, differenceInCalendarWeeks(today, start, { weekStartsOn: 1 }) + 1);
      if (opts.phase.target_ends_on) {
        const end = parseISO(opts.phase.target_ends_on + 'T00:00:00');
        weekTotal = Math.max(weekIndex, differenceInCalendarWeeks(end, start, { weekStartsOn: 1 }) + 1);
      }
    }
    phase = { code: opts.phase.code, name: opts.phase.name, weekIndex, weekTotal };
  }

  return {
    weekStartIso, weekEndIso,
    phase,
    days,
    sessionsDone,
    sessionsPlanned,
    tonnageKg,
    distanceKm,
    distanceM,
    activeMin,
    primary,
  };
}

function dayState(opts: { isToday: boolean; isPast: boolean; plan: PlanRow | null; act: ActRow | null }): DayState {
  const { isToday, isPast, plan, act } = opts;
  const isRest = (plan?.type === 'rest') || (act?.type === 'rest');
  if (isToday) {
    if (act?.status === 'done') return 'today_done';
    if (isRest) return 'today_rest';
    if (plan) return 'today_planned';
    return 'today_empty';
  }
  if (isPast) {
    if (act?.status === 'done') return isRest ? 'past_rest' : 'past_done';
    if (act?.status === 'skipped') return 'past_skipped';
    if (plan && plan.type !== 'rest') return 'past_missed';
    if (isRest) return 'past_rest';
    return 'past_empty';
  }
  // future
  if (isRest) return 'future_rest';
  if (plan) return 'future_planned';
  return 'future_empty';
}

/* ───── Formatting ───── */

function formatKg(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k kg`;
  return `${Math.round(n)} kg`;
}
function formatKm(km: number): string {
  if (km >= 100) return `${Math.round(km)} km`;
  return `${km.toFixed(1).replace(/\.0$/, '')} km`;
}
function formatMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const r = Math.round(m - h * 60);
  if (h === 0) return `${r}m`;
  if (r === 0) return `${h}h`;
  return `${h}h ${r}m`;
}

export function phaseLabelFor(s: WeekSummary): string {
  if (!s.phase) return 'This week';
  if (s.phase.weekTotal) return `Week ${s.phase.weekIndex} of ${s.phase.code}`;
  return `Week ${s.phase.weekIndex} · ${s.phase.code}`;
}
