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
  /** 'template' for normal forward fill; 'availability_window' when a
   *  user-declared window (travel/injury/pause) rewrites the slot. */
  source: 'template' | 'availability_window';
  prescription: unknown;
  ai_rationale: string | null;
  /** FK to availability_windows.id when source='availability_window'. */
  window_id?: string | null;
};

// -------- availability windows (P1.3) --------------------------------

/**
 * Window kind — what sort of disruption this is. Drives the default
 * strategy when the user picks 'auto'. Must match the DB enum in
 * migration 0006.
 */
export type AvailabilityWindowKind = 'travel' | 'injury' | 'pause';

/**
 * How roll-forward rewrites plan rows that fall inside an active
 * window. `auto` is resolved to the kind default by
 * `resolveWindowStrategy`. `suppress` writes no row at all — the date
 * is simply left empty.
 */
export type AvailabilityWindowStrategy =
  | 'auto'
  | 'bodyweight'
  | 'rest'
  | 'suppress';

/** The resolved (non-'auto') strategy actually used at emit time. */
export type ResolvedWindowStrategy = Exclude<AvailabilityWindowStrategy, 'auto'>;

/** Narrow view of an `availability_windows` row the reconciler needs. */
export type ActiveWindow = {
  id: string;
  starts_on: string;         // ISO (inclusive)
  ends_on: string;           // ISO (inclusive)
  kind: AvailabilityWindowKind;
  strategy: AvailabilityWindowStrategy;
  note: string | null;
};

/**
 * Resolve `auto` → the kind default:
 *   - travel  → 'bodyweight'  (user has limited equipment but wants to move)
 *   - injury  → 'rest'        (protect recovery by default)
 *   - pause   → 'rest'        (explicit off-period)
 *
 * Explicit strategies ('bodyweight', 'rest', 'suppress') pass through.
 */
export function resolveWindowStrategy(
  kind: AvailabilityWindowKind,
  strategy: AvailabilityWindowStrategy
): ResolvedWindowStrategy {
  if (strategy !== 'auto') return strategy;
  switch (kind) {
    case 'travel': return 'bodyweight';
    case 'injury': return 'rest';
    case 'pause':  return 'rest';
  }
}

/**
 * Precedence when multiple active windows overlap the same date.
 *
 * Higher number = wins. The user created both windows deliberately, so
 * we don't want to throw an error — we apply the more restrictive one.
 *   - pause (3) > injury (2) > travel (1)        kind precedence
 *   - rest (3)  > bodyweight (2) > suppress (1)  strategy precedence
 *
 * `suppress` ranks lowest because it's the "do nothing" option — if
 * another active window wants to write a rest or bodyweight row, that's
 * strictly more informative for the UI.
 */
function kindRank(k: AvailabilityWindowKind): number {
  return k === 'pause' ? 3 : k === 'injury' ? 2 : 1;
}
function strategyRank(s: ResolvedWindowStrategy): number {
  return s === 'rest' ? 3 : s === 'bodyweight' ? 2 : 1;
}

/**
 * Index windows by date for O(1) lookup during the roll-forward loop.
 *
 * Only dates in [rangeStart, rangeEnd] inclusive are populated — we
 * don't want to materialize a multi-year window into a giant map just
 * to touch the next 21 days. If two windows cover the same date, the
 * one ranking higher via `kindRank + strategyRank` wins.
 */
export function indexWindowsByDate(args: {
  windows: readonly ActiveWindow[];
  rangeStart: string;
  rangeEnd: string;
}): Map<string, ActiveWindow> {
  const { windows, rangeStart, rangeEnd } = args;
  const map = new Map<string, ActiveWindow>();
  for (const w of windows) {
    const start = w.starts_on > rangeStart ? w.starts_on : rangeStart;
    const end = w.ends_on < rangeEnd ? w.ends_on : rangeEnd;
    if (start > end) continue;
    let cur = start;
    for (let i = 0; i < 400 && cur <= end; i += 1) {
      const prior = map.get(cur);
      if (!prior) {
        map.set(cur, w);
      } else {
        // Tie-break: higher kind rank wins; ties go to higher strategy rank.
        const priorKR = kindRank(prior.kind);
        const nextKR = kindRank(w.kind);
        if (nextKR > priorKR) {
          map.set(cur, w);
        } else if (nextKR === priorKR) {
          const priorSR = strategyRank(resolveWindowStrategy(prior.kind, prior.strategy));
          const nextSR = strategyRank(resolveWindowStrategy(w.kind, w.strategy));
          if (nextSR > priorSR) map.set(cur, w);
        }
      }
      cur = addDaysIso(cur, 1);
    }
  }
  return map;
}

/**
 * Build a window-shaped plan row, or null when the resolved strategy
 * is 'suppress' (we deliberately write nothing).
 *
 * Rows carry `source='availability_window'` and `window_id`. No
 * calendar_event_id — windows are, by definition, a departure from the
 * templated program.
 */
export function buildWindowPlanForDate(args: {
  userId: string;
  iso: string;
  window: ActiveWindow;
  /** Phase the date lands in, if any. Preserved for reporting; can be null. */
  phase: PhaseRow | null;
}): PlanInsert | null {
  const { userId, iso, window, phase } = args;
  const strat = resolveWindowStrategy(window.kind, window.strategy);
  if (strat === 'suppress') return null;

  const noteTag = window.note ? ` (${window.note})` : '';
  const kindLabel =
    window.kind === 'travel'
      ? 'travel window'
      : window.kind === 'injury'
      ? 'injury window'
      : 'pause window';

  if (strat === 'rest') {
    return {
      user_id: userId,
      date: iso,
      type: 'rest',
      day_code: null,
      phase_id: phase?.id ?? null,
      calendar_event_id: null,
      status: 'planned',
      source: 'availability_window',
      prescription: {},
      ai_rationale: `Rest day — inside ${kindLabel}${noteTag}.`,
      window_id: window.id,
    };
  }

  // 'bodyweight' — emit a bodyweight-type plan. Prescription is left
  // empty; downstream UI (or a later PR) can populate a default
  // bodyweight routine. Keeping it empty here means the row shows up
  // as a clear placeholder rather than a fake specific prescription.
  return {
    user_id: userId,
    date: iso,
    type: 'bodyweight',
    day_code: null,
    phase_id: phase?.id ?? null,
    calendar_event_id: null,
    status: 'planned',
    source: 'availability_window',
    prescription: {},
    ai_rationale: `Bodyweight session — inside ${kindLabel}${noteTag}.`,
    window_id: window.id,
  };
}

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
 * Resolve the weekly pattern for a given phase.
 *
 * Accepts either a single `WeeklyPattern` (legacy callers) or a
 * `ReadonlyMap<phase_id, WeeklyPattern>` (P1.1 per-phase templates).
 * Returns `null` when the map has no entry for this phase — the caller
 * treats that the same as a missing weekly-pattern slot.
 */
export type PatternResolver =
  | WeeklyPattern
  | ReadonlyMap<string, WeeklyPattern>;

export function resolvePatternForPhase(
  resolver: PatternResolver,
  phaseId: string
): WeeklyPattern | null {
  if (resolver instanceof Map) return resolver.get(phaseId) ?? null;
  // Plain object — treat as a single pattern shared across phases.
  return resolver as WeeklyPattern;
}

/**
 * Build the plan row for a single date, or return `null` if we can't —
 * no active phase (reconciler stops at the phase boundary in PR-B;
 * phase-transition proposals come in P1.2), missing weekly-pattern slot,
 * etc.
 *
 * Rest days are still inserted (status='planned', type='rest') because
 * the UI renders rest as a positive plan, not an absence.
 *
 * `weeklyPattern` accepts either a single WeeklyPattern (legacy) or a
 * Map<phase_id, WeeklyPattern> (P1.1) — see `PatternResolver`.
 */
export function buildPlanForDate(args: {
  userId: string;
  iso: string;
  weeklyPattern: PatternResolver;
  phases: readonly PhaseRow[];
  eventsByPhaseDay: ReadonlyMap<string, CalendarEventRow>;
  /**
   * Optional per-date window index. When set and the date falls in an
   * active window, the window's strategy overrides the weekly template
   * — the function emits a window-shaped row (or null for 'suppress').
   */
  windowsByDate?: ReadonlyMap<string, ActiveWindow>;
}): PlanInsert | null {
  const { userId, iso, weeklyPattern, phases, eventsByPhaseDay, windowsByDate } = args;

  const phase = activePhaseFor(iso, phases);

  // Windows win over the template. If the date is covered, emit the
  // window-shaped row — even outside any phase (windows are a
  // user-level declaration, not phase-bound).
  const window = windowsByDate?.get(iso);
  if (window) {
    return buildWindowPlanForDate({ userId, iso, window, phase });
  }

  if (!phase) return null; // outside any phase → skip (P1.2 handles this)

  const pattern = resolvePatternForPhase(weeklyPattern, phase.id);
  if (!pattern) return null; // no template for this phase

  const dow = dowCodeOf(iso);
  const slot = pattern[dow];
  if (!slot) return null; // template doesn't cover this DOW

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
  weeklyPattern: PatternResolver;
  phases: readonly PhaseRow[];
  eventsByPhaseDay: ReadonlyMap<string, CalendarEventRow>;
  /**
   * Optional: active availability windows overlapping [startIso,
   * startIso+windowDays). If any cover a date, the window's strategy
   * overrides the weekly template on that date.
   */
  windowsByDate?: ReadonlyMap<string, ActiveWindow>;
}): PlanInsert[] {
  const {
    userId, startIso, windowDays, occupied,
    weeklyPattern, phases, eventsByPhaseDay, windowsByDate,
  } = args;

  const out: PlanInsert[] = [];
  for (const iso of datesFrom(startIso, windowDays)) {
    if (occupied.has(iso)) continue;
    const row = buildPlanForDate({
      userId, iso, weeklyPattern, phases, eventsByPhaseDay, windowsByDate,
    });
    if (row) out.push(row);
  }
  return out;
}

