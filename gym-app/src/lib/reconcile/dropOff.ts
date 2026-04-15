/**
 * Drop-off detection (P1.0 / PR-C).
 *
 * When a user returns after ≥ 3 days without a logged activity, create a
 * single `return_from_gap` proposal offering tiered recovery options.
 * Rules (from docs/p1-0-implementation.md §5, §6):
 *
 *   - No historical done activities → skip (first-ever user, not a return).
 *   - gap_days < 3 → skip.
 *   - gap_days 3..6  → 'soft' banner proposal:
 *                        shift_week (recommended), jump_back_in
 *   - gap_days 7..13 → 'hard' hero proposal:
 *                        reentry_soft (recommended), jump_back_in, reassess
 *   - gap_days ≥ 14  → 'hard_extended' hero proposal:
 *                        reentry_full, jump_back_in, reassess (recommended)
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
  computeGapDays,
} from './dropOff.pure';
import { addDaysIso, type CalendarEventRow, type PhaseRow, type WeeklyPattern } from './rollForward.pure';

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

  // 2. Gap math + tier.
  const gapDays = computeGapDays(todayIso, lastDoneIso);
  if (gapDays === null) return { drop_off_detected: false };
  const tier = classifyGap(gapDays);
  if (tier === 'none' || gapDays < DROP_OFF_THRESHOLD_DAYS) {
    return { drop_off_detected: false };
  }

  // 3. Idempotency gate: any return_from_gap proposal created after the
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

  // 4. Load program, phases, events — same inputs as roll-forward.
  const [{ data: program, error: progErr }, { data: phases, error: phaseErr }] =
    await Promise.all([
      sb
        .from('programs')
        .select('id, config')
        .eq('user_id', userId)
        .eq('active', true)
        .maybeSingle(),
      sb
        .from('phases')
        .select('id, code, starts_on, target_ends_on')
        .eq('user_id', userId)
        .order('starts_on', { ascending: true }),
    ]);

  if (progErr) {
    console.error('[reconcile/dropOff] load program failed', progErr);
    return { drop_off_detected: false };
  }
  if (phaseErr) {
    console.error('[reconcile/dropOff] load phases failed', phaseErr);
    return { drop_off_detected: false };
  }

  const weeklyPattern: WeeklyPattern =
    (program as { config?: { split?: { weekly_pattern?: WeeklyPattern } } } | null)
      ?.config?.split?.weekly_pattern ?? {};
  const phaseRows: PhaseRow[] = (phases ?? []) as PhaseRow[];

  if (phaseRows.length === 0) return { drop_off_detected: false };
  if (Object.keys(weeklyPattern).length === 0) return { drop_off_detected: false };

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

  // 5. Existing plans in the lookahead window, so option diffs can
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

  // 6. Build the diff (pure).
  const diff = buildReturnFromGapDiff({
    ctx: {
      userId,
      todayIso,
      weeklyPattern,
      phases: phaseRows,
      eventsByPhaseDay,
      plansByDate,
    },
    gapDays,
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
