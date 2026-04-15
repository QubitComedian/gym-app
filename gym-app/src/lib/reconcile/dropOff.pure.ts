/**
 * Pure helpers for the drop-off pass.
 *
 * Keeps the gap math, classification rules, and option-builder logic
 * free of Supabase I/O so they can be unit-tested exhaustively. The DB
 * wrapper in dropOff.ts loads the inputs, calls these helpers, and
 * writes the resulting `ai_proposals` row.
 *
 * Policy (from docs/p1-0-implementation.md §5–6):
 *   - gap < 3 days                 → no proposal (tier = 'none')
 *   - gap in [3, 6]                → soft banner tier. Options:
 *                                      * shift_week (recommended)
 *                                      * jump_back_in
 *   - gap in [7, 13]               → hard hero tier. Options:
 *                                      * reentry_soft (recommended)
 *                                      * jump_back_in
 *                                      * reassess
 *   - gap ≥ 14                     → hard hero tier, extended deload.
 *                                    Options:
 *                                      * reentry_full
 *                                      * jump_back_in
 *                                      * reassess (recommended)
 *
 * Also enforced by callers (not here):
 *   - Must have at least one historical `done` activity (first-ever
 *     users are not returners).
 *   - No new proposal if one already exists (in any state) with
 *     `created_at > last_done_date` — that gap has already been handled.
 */

import {
  addDaysIso,
  dowCodeOf,
  buildPlanForDate,
  type CalendarEventRow,
  type DowCode,
  type PhaseRow,
  type PlanInsert,
  type WeeklyPattern,
} from './rollForward.pure';

// -------- thresholds --------------------------------------------------

export const DROP_OFF_THRESHOLD_DAYS = 3;   // < 3 → no proposal
export const SOFT_GAP_MAX_DAYS = 6;         // 3..6 → soft banner
export const HARD_GAP_MAX_DAYS = 13;        // 7..13 → hard hero (standard deload)
                                            // ≥ 14  → hard hero (extended deload)

// The shift / deload windows. Kept modest so the cascade is bounded.
export const SHIFT_WEEK_DAYS = 7;
export const REENTRY_SOFT_DAYS = 7;
export const REENTRY_FULL_DAYS = 14;

// Training-week order. weekly_pattern keys use this order; the reconciler
// interprets "shift this week so it starts today" as "today plays the
// role of Monday." We rotate from this order, not the Sunday-first JS
// `DOW_CODES` order from rollForward.pure.
export const TRAINING_WEEK_ORDER: readonly DowCode[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;

// -------- gap math ----------------------------------------------------

/**
 * Days between two ISO dates (`bIso - aIso`), rounded to whole days.
 * Uses UTC arithmetic so DST / timezone quirks can't shift the count.
 * Returns 0 for same-day, positive if b is later than a.
 */
export function daysBetweenIso(aIso: string, bIso: string): number {
  const [ay, am, ad] = aIso.split('-').map(Number);
  const [by, bm, bd] = bIso.split('-').map(Number);
  if (!ay || !am || !ad || !by || !bm || !bd) {
    throw new Error(`daysBetweenIso: bad iso ${aIso} / ${bIso}`);
  }
  const a = Date.UTC(ay, am - 1, ad);
  const b = Date.UTC(by, bm - 1, bd);
  return Math.round((b - a) / 86_400_000);
}

/**
 * gap = today − last_done_date, or null if the user has no prior done
 * activity (first-ever user — not a returner).
 */
export function computeGapDays(
  todayIso: string,
  lastDoneIso: string | null
): number | null {
  if (!lastDoneIso) return null;
  const n = daysBetweenIso(lastDoneIso, todayIso);
  // If the user logged something today or in the future (clock skew),
  // there's no gap. Return 0.
  return n < 0 ? 0 : n;
}

export type GapTier = 'none' | 'soft' | 'hard' | 'hard_extended';

export function classifyGap(gapDays: number | null): GapTier {
  if (gapDays === null) return 'none';
  if (gapDays < DROP_OFF_THRESHOLD_DAYS) return 'none';
  if (gapDays <= SOFT_GAP_MAX_DAYS) return 'soft';
  if (gapDays <= HARD_GAP_MAX_DAYS) return 'hard';
  return 'hard_extended';
}

// -------- option shapes ----------------------------------------------

/**
 * A single option within a return_from_gap proposal. Each option carries
 * a fully-computed diff — the apply path just has to pick one by id and
 * replay the diff.
 */
export type ReturnOption = {
  id: 'shift_week' | 'jump_back_in' | 'reentry_soft' | 'reentry_full' | 'reassess';
  label: string;
  description: string;
  recommended: boolean;
  /** Empty diff when the option is a no-op or a UI-only redirect. */
  diff: {
    updates: Array<{
      plan_id: string;
      patch: {
        date?: string;
        prescription?: unknown;
        day_code?: string | null;
        type?: string;
      };
    }>;
    creates: Array<{
      date: string;
      type: string;
      day_code: string | null;
      prescription: unknown;
    }>;
    deletes: string[];
    rationale: string;
  };
  /** For 'reassess': tells the apply path to redirect to /check-in. */
  action?: 'reassess';
};

/**
 * The full shape stored in `ai_proposals.diff` for a return_from_gap
 * proposal. The apply path reads `options[].diff` when the user picks
 * one, or recognizes `action === 'reassess'` and routes to check-in.
 */
export type ReturnFromGapDiff = {
  kind: 'return_from_gap';
  gap_days: number;
  last_done_date: string;
  today: string;
  tier: GapTier;
  default_option_id: ReturnOption['id'];
  options: ReturnOption[];
  /** Top-line reason for the banner / hero header. */
  rationale: string;
};

// -------- helpers to generate plan diffs ------------------------------

/**
 * Rotate a weekly pattern so that `startDow`'s slot becomes the pattern's
 * Monday slot. I.e. the day the user "restarts" plays the role of the
 * first training day.
 *
 *   rotateWeeklyPattern('FR', p) where p.MO = push, p.TU = pull, ...
 *   // => { FR: p.MO, SA: p.TU, SU: p.WE, MO: p.TH, TU: p.FR, WE: p.SA, TH: p.SU }
 */
export function rotateWeeklyPattern(
  startDow: DowCode,
  pattern: WeeklyPattern
): WeeklyPattern {
  const n = TRAINING_WEEK_ORDER.length;
  const i0 = TRAINING_WEEK_ORDER.indexOf(startDow);
  if (i0 < 0) return { ...pattern };
  const out: WeeklyPattern = {};
  for (let i = 0; i < n; i += 1) {
    const dow = TRAINING_WEEK_ORDER[i];
    // Day `dow` plays the role of training-week position (i − i0). That is,
    // startDow (i === i0) gets the MO slot; the next day gets TU; etc.
    const source = TRAINING_WEEK_ORDER[(i - i0 + n) % n];
    const slot = pattern[source];
    if (slot) out[dow] = slot;
  }
  return out;
}

/**
 * Apply a per-plan prescription decorator — used for deload adjustments
 * on reentry options. Wraps (without mutating) the original prescription
 * so the UI can display the original alongside the deload note.
 */
export function decorateWithDeload(
  original: unknown,
  deloadKind: 'soft' | 'full'
): unknown {
  const base: Record<string, unknown> =
    original && typeof original === 'object' ? { ...(original as Record<string, unknown>) } : {};

  base.deload = deloadKind === 'soft'
    ? {
        kind: 'soft',
        rule: 'Reduce working weights 10–15%. Add 1 to RIR targets. Skip the last set if RIR hits 0 early.',
      }
    : {
        kind: 'full',
        rule: 'Reduce working weights 20–25%. Cap RIR at 3. Skip drop-sets. Cut volume by one set on main movements.',
      };
  return base;
}

// -------- option builders --------------------------------------------

type BuildContext = {
  userId: string;
  todayIso: string;
  weeklyPattern: WeeklyPattern;
  phases: readonly PhaseRow[];
  eventsByPhaseDay: ReadonlyMap<string, CalendarEventRow>;
  /**
   * Map of existing plans in the relevant window, keyed by ISO date.
   * If multiple plans share a date (rare — versioning), caller picks the
   * non-superseded one.
   */
  plansByDate: ReadonlyMap<string, { id: string; status: string }>;
};

/**
 * Build the `shift_week` diff: take the next 7 days (today..today+6),
 * lay down a fresh rotated-pattern set of plans starting at today, and
 * soft-delete any planned rows already sitting on those dates.
 *
 * Missed rows (already aged-out) are left alone — they're history.
 */
export function buildShiftWeekDiff(ctx: BuildContext): ReturnOption['diff'] {
  const { userId, todayIso, weeklyPattern, phases, eventsByPhaseDay, plansByDate } = ctx;
  const startDow = dowCodeOf(todayIso);
  const rotated = rotateWeeklyPattern(startDow, weeklyPattern);

  const deletes: string[] = [];
  const creates: ReturnOption['diff']['creates'] = [];

  for (let i = 0; i < SHIFT_WEEK_DAYS; i += 1) {
    const iso = addDaysIso(todayIso, i);
    const existing = plansByDate.get(iso);
    if (existing && existing.status === 'planned') {
      deletes.push(existing.id);
    }
    const row = buildPlanForDate({
      userId,
      iso,
      weeklyPattern: rotated,
      phases,
      eventsByPhaseDay,
    });
    if (!row) continue;
    creates.push(planInsertToCreate(row));
  }

  return {
    updates: [],
    creates,
    deletes,
    rationale: `Shift this week so it starts today — your missed days are done, the upcoming week is rebuilt starting now.`,
  };
}

/**
 * Build the `reentry_soft` / `reentry_full` diff: starting TOMORROW, lay
 * down N days (7 or 14) of deload-flagged plans using the rotated
 * pattern. Next week beyond the deload window resumes the normal pattern
 * (untouched).
 */
export function buildReentryDiff(
  ctx: BuildContext,
  kind: 'soft' | 'full'
): ReturnOption['diff'] {
  const { userId, todayIso, weeklyPattern, phases, eventsByPhaseDay, plansByDate } = ctx;
  const startIso = addDaysIso(todayIso, 1);
  const startDow = dowCodeOf(startIso);
  const rotated = rotateWeeklyPattern(startDow, weeklyPattern);
  const days = kind === 'soft' ? REENTRY_SOFT_DAYS : REENTRY_FULL_DAYS;

  const deletes: string[] = [];
  const creates: ReturnOption['diff']['creates'] = [];

  for (let i = 0; i < days; i += 1) {
    const iso = addDaysIso(startIso, i);
    const existing = plansByDate.get(iso);
    if (existing && existing.status === 'planned') {
      deletes.push(existing.id);
    }
    const row = buildPlanForDate({
      userId,
      iso,
      weeklyPattern: rotated,
      phases,
      eventsByPhaseDay,
    });
    if (!row) continue;
    const decorated: PlanInsert = {
      ...row,
      prescription: decorateWithDeload(row.prescription, kind),
    };
    creates.push(planInsertToCreate(decorated));
  }

  const label = kind === 'soft'
    ? 'Re-entry week — lower load this week, full load resumes next week.'
    : 'Re-entry fortnight — 2 weeks of reduced load to rebuild safely.';

  return {
    updates: [],
    creates,
    deletes,
    rationale: label,
  };
}

/** `jump_back_in` — literally no change. Marked applied, banner dismissed. */
export function buildJumpBackInDiff(): ReturnOption['diff'] {
  return {
    updates: [],
    creates: [],
    deletes: [],
    rationale: 'Jump back in — resume the plan exactly where it was.',
  };
}

/** `reassess` — UI-only redirect to /check-in. No plan diff. */
export function buildReassessDiff(): ReturnOption['diff'] {
  return {
    updates: [],
    creates: [],
    deletes: [],
    rationale: 'Reassess with Claude — open a check-in to rethink the plan.',
  };
}

// -------- the main composer ------------------------------------------

/**
 * Build the full ReturnFromGapDiff for a given tier. Returns null when
 * tier === 'none' (caller decides not to create a proposal).
 */
export function buildReturnFromGapDiff(args: {
  ctx: BuildContext;
  gapDays: number;
  lastDoneIso: string;
  tier: GapTier;
}): ReturnFromGapDiff | null {
  const { ctx, gapDays, lastDoneIso, tier } = args;
  if (tier === 'none') return null;

  const options: ReturnOption[] = [];
  let defaultId: ReturnOption['id'];

  if (tier === 'soft') {
    defaultId = 'shift_week';
    options.push({
      id: 'shift_week',
      label: 'Shift this week',
      description: 'Restart this week starting today. The missed days are behind you.',
      recommended: true,
      diff: buildShiftWeekDiff(ctx),
    });
    options.push({
      id: 'jump_back_in',
      label: 'Jump back in',
      description: 'Resume the plan exactly where it was — today is today.',
      recommended: false,
      diff: buildJumpBackInDiff(),
    });
  } else if (tier === 'hard') {
    defaultId = 'reentry_soft';
    options.push({
      id: 'reentry_soft',
      label: 'Re-entry week',
      description: 'Lower load this week, full load next week. Starts tomorrow.',
      recommended: true,
      diff: buildReentryDiff(ctx, 'soft'),
    });
    options.push({
      id: 'jump_back_in',
      label: 'Jump back in',
      description: 'Resume the plan exactly where it was. Today: today.',
      recommended: false,
      diff: buildJumpBackInDiff(),
    });
    options.push({
      id: 'reassess',
      label: 'Reassess with Claude',
      description: 'Rethink the plan in a short check-in. ~2 minutes.',
      recommended: false,
      diff: buildReassessDiff(),
      action: 'reassess',
    });
  } else {
    // hard_extended
    defaultId = 'reassess';
    options.push({
      id: 'reentry_full',
      label: 'Re-entry fortnight',
      description: 'Two weeks of reduced load to rebuild safely. Starts tomorrow.',
      recommended: false,
      diff: buildReentryDiff(ctx, 'full'),
    });
    options.push({
      id: 'jump_back_in',
      label: 'Jump back in',
      description: 'Resume the plan exactly where it was. No guardrails.',
      recommended: false,
      diff: buildJumpBackInDiff(),
    });
    options.push({
      id: 'reassess',
      label: 'Reassess with Claude',
      description: 'Long gap — worth a fresh look at goals and structure.',
      recommended: true,
      diff: buildReassessDiff(),
      action: 'reassess',
    });
  }

  const rationale =
    tier === 'soft'
      ? `Headline: Welcome back — ${gapDays} days since your last session.\nWant me to shift this week so it starts today?`
      : tier === 'hard'
      ? `Headline: Welcome back — ${gapDays} days since your last session.\nHere's how I'd pick things up:`
      : `Headline: Welcome back — it's been ${gapDays} days.\nThat's a meaningful gap — let's rebuild carefully.`;

  return {
    kind: 'return_from_gap',
    gap_days: gapDays,
    last_done_date: lastDoneIso,
    today: ctx.todayIso,
    tier,
    default_option_id: defaultId,
    options,
    rationale,
  };
}

// -------- internals ---------------------------------------------------

function planInsertToCreate(row: PlanInsert): ReturnOption['diff']['creates'][number] {
  // The apply path in /api/proposals/[id]/route.ts pulls only these four
  // fields from each `creates` entry. Keep the shape tight — extra keys
  // would be silently dropped.
  return {
    date: row.date,
    type: row.type,
    day_code: row.day_code,
    prescription: row.prescription,
  };
}
