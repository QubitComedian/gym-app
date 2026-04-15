/**
 * Pure helpers for the roll-forward pass.
 *
 * Kept separate from rollForward.ts so the calendar math and row
 * construction can be unit-tested without a Supabase client. No I/O,
 * no Date.now(), no module-level state.
 *
 * The "user's day of week" is computed entirely from the user-local
 * `yyyy-MM-dd` string we get from tz.ts. That keeps the reconciler
 * deterministic regardless of server timezone.
 */
/** DOW codes used in program config keys, indexed 0..6 = Sun..Sat. */
export const DOW_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
export type DowCode = typeof DOW_CODES[number];

/** Entry in `programs.config.split.weekly_pattern`. */
export type WeeklySlot = {
  type: string;           // 'gym' | 'run' | 'bike' | 'swim' | 'yoga' | 'climb' | 'rest' | ...
  day_code: string | null; // 'push' | 'pull' | 'lower' | 'upper_full' | 'easy_run' | ... | null
};

export type WeeklyPattern = Partial<Record<DowCode, WeeklySlot>>;

/** Minimal phase shape roll-forward needs. */
export type PhaseRow = {
  id: string;
  code: string | null;
  starts_on: string | null;        // ISO date
  target_ends_on: string | null;   // ISO date (nullable for open-ended)
};

/** Minimal calendar_event shape roll-forward needs. */
export type CalendarEventRow = {
  id: string;
  phase_id: string | null;
  day_code: string | null;
  prescription: unknown; // jsonb, kept opaque
  summary: string | null;
};

/** Shape we write to the `plans` table (one row). */
export type PlanInsert = {
  user_id: string;
  date: string;              // yyyy-MM-dd
  type: string;
  day_code: string | null;
  phase_id: string | null;
  calendar_event_id: string | null;
  status: 'planned';
  source: 'template';
  prescription: unknown;
  ai_rationale: string | null;
};

/**
 * Return the day-of-week code ('MO' / 'TU' / …) for an ISO date string,
 * independent of the JS runtime timezone. We parse the components by
 * hand and use UTC arithmetic so the same `yyyy-MM-dd` always maps to
 * the same DOW regardless of where the server is running.
 */
export function dowCodeOf(iso: string): DowCode {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) throw new Error(`dowCodeOf: bad iso ${iso}`);
  const idx = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
  return DOW_CODES[idx];
}

/** Add `n` whole days to `yyyy-MM-dd`, returning `yyyy-MM-dd`. */
export function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) throw new Error(`addDaysIso: bad iso ${iso}`);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + n);
  const yy = t.getUTCFullYear();
  const mm = String(t.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(t.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * Enumerate dates [startIso, startIso + windowDays) inclusive of start
 * and exclusive of end+1. So `datesFrom('2026-04-15', 21)` returns
 * 21 entries: 04-15, 04-16, …, 05-05.
 */
export function datesFrom(startIso: string, windowDays: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < windowDays; i += 1) {
    out.push(addDaysIso(startIso, i));
  }
  return out;
}

/** The phase whose [starts_on, target_ends_on] window contains `iso`. */
export function activePhaseFor(
  iso: string,
  phases: readonly PhaseRow[]
): PhaseRow | null {
  for (const p of phases) {
    if (!p.starts_on) continue;
    if (iso < p.starts_on) continue;
    if (p.target_ends_on && iso > p.target_ends_on) continue;
    return p;
  }
  return null;
}

/**
 * Build the plan row for a single date, or return `null` if we can't —
 * no active phase (reconciler stops at the phase boundary in PR-B;
 * phase-transition proposals come in P1.2), missing weekly-pattern slot,
 * etc.
 *
 * Rest days are still inserted (status='planned', type='rest') because
 * the UI renders rest as a positive plan, not an absence.
 */
export function buildPlanForDate(args: {
  userId: string;
  iso: string;
  weeklyPattern: WeeklyPattern;
  phases: readonly PhaseRow[];
  eventsByPhaseDay: ReadonlyMap<string, CalendarEventRow>;
}): PlanInsert | null {
  const { userId, iso, weeklyPattern, phases, eventsByPhaseDay } = args;

  const phase = activePhaseFor(iso, phases);
  if (!phase) return null; // outside any phase → skip (P1.2 handles this)

  const dow = dowCodeOf(iso);
  const slot = weeklyPattern[dow];
  if (!slot) return null; // program config doesn't cover this DOW

  // Rest days: no calendar event lookup, empty prescription.
  if (slot.type === 'rest') {
    return {
      user_id: userId,
      date: iso,
      type: 'rest',
      day_code: slot.day_code ?? null,
      phase_id: phase.id,
      calendar_event_id: null,
      status: 'planned',
      source: 'template',
      prescription: {},
      ai_rationale: `Rolled forward — rest day per weekly pattern (phase ${phase.code ?? '?'}).`,
    };
  }

  // Training days: look up prescription by (phase_id, day_code).
  const key = `${phase.id}:${slot.day_code ?? ''}`;
  const ev = eventsByPhaseDay.get(key) ?? null;

  return {
    user_id: userId,
    date: iso,
    type: slot.type,
    day_code: slot.day_code ?? null,
    phase_id: phase.id,
    calendar_event_id: ev?.id ?? null,
    status: 'planned',
    source: 'template',
    prescription: ev?.prescription ?? {},
    ai_rationale: ev
      ? `Rolled forward from calendar event "${ev.summary ?? slot.day_code}" (phase ${phase.code ?? '?'}).`
      : `Rolled forward — no calendar template for ${phase.code ?? '?'}/${slot.day_code ?? '?'}; placeholder.`,
  };
}

/**
 * Plan inserts for a window, given already-occupied dates.
 *
 * `occupied` is the set of dates already holding any plan row; we never
 * overwrite. `nullable` returns are filtered out (dates with no active
 * phase / no pattern slot).
 */
export function buildPlansForWindow(args: {
  userId: string;
  startIso: string;
  windowDays: number;
  occupied: ReadonlySet<string>;
  weeklyPattern: WeeklyPattern;
  phases: readonly PhaseRow[];
  eventsByPhaseDay: ReadonlyMap<string, CalendarEventRow>;
}): PlanInsert[] {
  const { userId, startIso, windowDays, occupied, weeklyPattern, phases, eventsByPhaseDay } = args;

  const out: PlanInsert[] = [];
  for (const iso of datesFrom(startIso, windowDays)) {
    if (occupied.has(iso)) continue;
    const row = buildPlanForDate({ userId, iso, weeklyPattern, phases, eventsByPhaseDay });
    if (row) out.push(row);
  }
  return out;
}

