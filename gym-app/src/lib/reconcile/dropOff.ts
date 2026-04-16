/**
 * Drop-off detection (P1.0 / PR-C, extended in P1.3 / PR-P).
 *
 * When a user returns after ≥ 3 days without a logged activity, create a
 * single `return_from_gap` proposal offering tiered recovery options.
 * Rules (from docs/p1-0-implementation.md §5, §6):
 *
 *   - No historical done activities → skip (first-ever user, not a return).
 *   - effective_gap_days < 3 → skip.
 *   - effective_gap_days 3..6  → 'soft' banner proposal:
 *                        shift_week (recommended), jump_back_in
 *   - effective_gap_days 7..13 → 'hard' hero proposal:
 *                        reentry_soft (recommended), jump_back_in, reassess
 *   - effective_gap_days ≥ 14  → 'hard_extended' hero proposal:
 *                        reentry_full, jump_back_in, reassess (recommended)
 *
 * Window-adjusted gap (P1.3): days inside an active availability window
 * (travel/injury/pause) are user-declared "not training" days and are
 * excluded from the gap count. If every gap day is window-covered, the
 * effective gap is 0 and we skip the proposal entirely — the user
 * already told us they were off, no need to welcome them back.
 *
 * Idempotency contract: don't create a new proposal if one already exists
 * (in any state) with `created_at > last_done_date`. The previous gap has
 * already been handled, even if the user dismissed or applied it — a
 * fresh proposal would just re-annoy them about the same lull.
 *
 * Pure logic (gap math, option diff construction) lives in
 * dropOff.pure.ts. This file loads inputs, runs early-outs, and writes
 * the proposal row.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DROP_OFF_THRESHOLD_DAYS,
  buildReturnFromGapDiff,
  classifyGap,
  computeEffectiveGapDays,
  computeGapDays,
} from './dropOff.pure';
import {
  addDaysIso,
  indexWindowsByDate,
  type ActiveWindow,
  type CalendarEventRow,
  type PhaseRow,
} from './rollForward.pure';
import { getAllWeeklyPatternsForUser } from '@/lib/templates/loader';

// Re-export for callers that still import the constant from this module.
export { DROP_OFF_THRESHOLD_DAYS } from './dropOff.pure';

// How far forward to load existing plans so the option builders can emit
// `deletes` for rows about to be overwritten. The widest option is the
// 14-day reentry window starting tomorrow, so today + 15 days covers it.
const DROP_OFF_LOOKAHEAD_DAYS = 15;

export async function detectDropOff(opts: {
  sb: SupabaseClient;
  userId: string;
  todayIso: string;
}): Promise<{ drop_off_detected: boolean }> {
  const { sb, userId, todayIso } = opts;

  // 1. Last `done` activity. Ordered by date desc, one row max — this
  //    is a cheap index hit on activities_user_date_idx.
  const { data: lastDone, error: doneErr } = await sb
    .from('activities')
    .select('date')
    .eq('user_id', userId)
    .eq('status', 'done')
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (doneErr) {
    console.error('[reconcile/dropOff] load last done failed', doneErr);
    return { drop_off_detected: false };
  }

  // First-ever user — no prior done activity, nothing to "return from".
  const lastDoneIso: string | null = lastDone?.date ?? null;
  if (!lastDoneIso) return { drop_off_detected: false };

  // 2. Raw gap math. Effective (window-adjusted) gap is computed next,
  //    once we've loaded the user's active availability windows. Early
  //    out only on the trivially-small raw cases where even a
  //    window-less user wouldn't qualify.
  const gapDays = computeGapDays(todayIso, lastDoneIso);
  if (gapDays === null) return { drop_off_detected: false };
  if (gapDays < DROP_OFF_THRESHOLD_DAYS) {
    return { drop_off_detected: false };
  }

  // 3. Load active availability windows that overlap the gap range
  //    (lastDoneIso, todayIso]. The (user_id, status, ends_on, starts_on)
  //    index in migration 0006 makes this a single seek. Windows are
  //    optional — a failure shouldn't prevent a drop-off proposal on a
  //    user with no windows.
  const { data: windowsInGap, error: winErr } = await sb
    .from('availability_windows')
    .select('id, starts_on, ends_on, kind, strategy, note')
    .eq('user_id', userId)
    .eq('status', 'active')
    .gte('ends_on', lastDoneIso)
    .lte('starts_on', todayIso);

  if (winErr) {
    console.error('[reconcile/dropOff] load windows failed (non-fatal)', winErr);
  }

  const activeWindows: ActiveWindow[] = (windowsInGap ?? []).map((w) => ({
    id: w.id as string,
    starts_on: w.starts_on as string,
    ends_on: w.ends_on as string,
    kind: w.kind as ActiveWindow['kind'],
    strategy: w.strategy as ActiveWindow['strategy'],
    note: (w.note ?? null) as string | null,
  }));

  // The gap range we care about for effective math is (lastDone, today].
  // `indexWindowsByDate` handles clipping + precedence; we collapse to a
  // simple Set<string> of covered dates for the pure gap helper.
  const gapCoveredMap = indexWindowsByDate({
    windows: activeWindows,
    rangeStart: addDaysIso(lastDoneIso, 1),
    rangeEnd: todayIso,
  });
  const gapCovered = new Set<string>(gapCoveredMap.keys());

  const effectiveGap = computeEffectiveGapDays(todayIso, lastDoneIso, gapCovered) ?? 0;
  const windowDaysInGap = gapDays - effectiveGap;

  // 4. Classify on the window-adjusted gap. When every day was
  //    window-covered, effective gap is zero → no banner.
  const tier = classifyGap(effectiveGap);
  if (tier === 'none' || effectiveGap < DROP_OFF_THRESHOLD_DAYS) {
    return { drop_off_detected: false };
  }

  // 5. Idempotency gate: any return_from_gap proposal created after the
  //    last done activity means this gap has already been surfaced.
  //    Includes pending (don't stack), applied (user already picked an
  //    option), rejected (user dismissed the banner — don't nag).
  const { data: existingProps, error: propsErr } = await sb
    .from('ai_proposals')
    .select('id, created_at')
    .eq('user_id', userId)
    .eq('kind', 'return_from_gap')
    .gt('created_at', `${lastDoneIso}T00:00:00Z`)
    .limit(1);

  if (propsErr) {
    console.error('[reconcile/dropOff] load existing proposals failed', propsErr);
    return { drop_off_detected: false };
  }
  if (existingProps && existingProps.length > 0) {
    // Gap already surfaced — report as detected so callers know a banner
    // is live, but don't insert anything new.
    return { drop_off_detected: true };
  }

  // 6. Load per-phase patterns + phases + events. Same inputs as
  //    roll-forward. The loader falls back to the legacy program config
  //    for phases without a weekly_templates row.
  const [patternByPhase, { data: phases, error: phaseErr }] = await Promise.all([
    getAllWeeklyPatternsForUser(sb, userId),
    sb
      .from('phases')
      .select('id, code, starts_on, target_ends_on')
      .eq('user_id', userId)
      .order('starts_on', { ascending: true }),
  ]);

  if (phaseErr) {
    console.error('[reconcile/dropOff] load phases failed', phaseErr);
    return { drop_off_detected: false };
  }

  const phaseRows: PhaseRow[] = (phases ?? []) as PhaseRow[];

  if (phaseRows.length === 0) return { drop_off_detected: false };
  if (patternByPhase.size === 0) return { drop_off_detected: false };

  const { data: events, error: evErr } = await sb
    .from('calendar_events')
    .select('id, phase_id, day_code, prescription, summary')
    .eq('user_id', userId);

  if (evErr) {
    console.error('[reconcile/dropOff] load events failed', evErr);
    return { drop_off_detected: false };
  }

  const eventsByPhaseDay = new Map<string, CalendarEventRow>();
  for (const e of (events ?? []) as CalendarEventRow[]) {
    if (!e.phase_id || !e.day_code) continue;
    eventsByPhaseDay.set(`${e.phase_id}:${e.day_code}`, e);
  }

  // 7. Existing plans in the lookahead window, so option diffs can
  //    include `deletes` for rows they're about to replace.
  const lookaheadEnd = addDaysIso(todayIso, DROP_OFF_LOOKAHEAD_DAYS);
  const { data: plansInWindow, error: plansErr } = await sb
    .from('plans')
    .select('id, date, status')
    .eq('user_id', userId)
    .gte('date', todayIso)
    .lte('date', lookaheadEnd);

  if (plansErr) {
    console.error('[reconcile/dropOff] load plans failed', plansErr);
    return { drop_off_detected: false };
  }

  const plansByDate = new Map<string, { id: string; status: string }>();
  for (const p of (plansInWindow ?? []) as Array<{ id: string; date: string; status: string }>) {
    // On rare multi-version collisions, prefer the currently-planned row —
    // that's what the apply path cares about overwriting.
    const prior = plansByDate.get(p.date);
    if (!prior || p.status === 'planned') plansByDate.set(p.date, { id: p.id, status: p.status });
  }

  // 8. Build the diff (pure). `gapDays` stays as the raw calendar count
  //    (UI banner copy), but tier + `effective_gap_days` drive the
  //    decision + nuance line in the rationale.
  const diff = buildReturnFromGapDiff({
    ctx: {
      userId,
      todayIso,
      weeklyPattern: patternByPhase,
      phases: phaseRows,
      eventsByPhaseDay,
      plansByDate,
    },
    gapDays,
    effectiveGapDays: effectiveGap,
    windowDays: windowDaysInGap,
    lastDoneIso,
    tier,
  });
  if (!diff) return { drop_off_detected: false }; // defensive — should only be null when tier='none'.

  // 7. Insert.
  const { error: insErr } = await sb.from('ai_proposals').insert({
    user_id: userId,
    kind: 'return_from_gap',
    triggered_by: 'drop_off_detected',
    diff,
    rationale: diff.rationale,
    status: 'pending',
  });

  if (insErr) {
    console.error('[reconcile/dropOff] insert proposal failed', insErr);
    return { drop_off_detected: false };
  }

  return { drop_off_detected: true };
}
