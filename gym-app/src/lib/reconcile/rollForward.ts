/**
 * Rolling-window pass (P1.0 / PR-B).
 *
 * Ensures plan rows exist for every day in [today, today + 21] in the
 * user's timezone. Walks the user's active weekly pattern (read from
 * `programs.config.split.weekly_pattern`) and binds each slot's
 * prescription from the matching `calendar_events` row (keyed by
 * `phase_id:day_code`).
 *
 * Design contract:
 *   - Idempotent: we pre-query dates already holding plan rows and skip
 *     them. We don't touch existing rows — the reconciler never rewrites
 *     prescriptions. That's the proposal path's job.
 *   - Phase-bounded: days outside any active phase are skipped. When the
 *     user approaches a phase boundary with no successor phase,
 *     roll-forward stops at the current phase's end date. P1.2 will add
 *     a phase_transition proposal for that case.
 *   - Best-effort on prescriptions: if a calendar_event isn't found for
 *     (phase, day_code), we still insert a placeholder plan so the UI
 *     has a row to hang off. `ai_rationale` explains why the prescription
 *     is empty.
 *
 * Pure logic (date math, row construction) lives in rollForward.pure.ts.
 * This file is the thin I/O wrapper.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildPlansForWindow,
  datesFrom,
  type CalendarEventRow,
  type PhaseRow,
  type WeeklyPattern,
} from './rollForward.pure';

export const ROLLING_WINDOW_DAYS = 21;

export async function rollForward(opts: {
  sb: SupabaseClient;
  userId: string;
  todayIso: string;
  windowDays?: number;
}): Promise<{ rolled_forward: number }> {
  const { sb, userId, todayIso } = opts;
  const windowDays = opts.windowDays ?? ROLLING_WINDOW_DAYS;

  // 1. Pre-query: which dates in the window already have a plan?
  //    We scope by date range rather than per-date to keep this a single
  //    round-trip. The range is `[todayIso, todayIso + windowDays - 1]`.
  const lastIso = datesFrom(todayIso, windowDays).at(-1)!;
  const { data: existingPlans, error: plansErr } = await sb
    .from('plans')
    .select('date')
    .eq('user_id', userId)
    .gte('date', todayIso)
    .lte('date', lastIso);

  if (plansErr) {
    console.error('[reconcile/rollForward] load plans failed', plansErr);
    return { rolled_forward: 0 };
  }

  const occupied = new Set<string>(
    (existingPlans ?? []).map((p: { date: string }) => p.date)
  );

  // Hot path: every day in the window already has a plan. This is the
  // common case after the seed has filled out the forward horizon through
  // the end of P3.
  if (occupied.size >= windowDays) {
    return { rolled_forward: 0 };
  }

  // 2. Load what we need to fill gaps: active program, phases, events.
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
    console.error('[reconcile/rollForward] load program failed', progErr);
    return { rolled_forward: 0 };
  }
  if (phaseErr) {
    console.error('[reconcile/rollForward] load phases failed', phaseErr);
    return { rolled_forward: 0 };
  }

  const weeklyPattern: WeeklyPattern =
    (program as { config?: { split?: { weekly_pattern?: WeeklyPattern } } } | null)
      ?.config?.split?.weekly_pattern ?? {};

  const phaseRows: PhaseRow[] = (phases ?? []) as PhaseRow[];

  // No phases or no weekly pattern → nothing to walk. Seed path is the
  // recovery mechanism; reconciler no-ops silently.
  if (phaseRows.length === 0) return { rolled_forward: 0 };
  if (Object.keys(weeklyPattern).length === 0) return { rolled_forward: 0 };

  // 3. Load calendar_events for this user, indexed by `phase_id:day_code`.
  //    A user has ~5-8 distinct recurring templates per phase, so the set
  //    is tiny — one query is fine.
  const { data: events, error: evErr } = await sb
    .from('calendar_events')
    .select('id, phase_id, day_code, prescription, summary')
    .eq('user_id', userId);

  if (evErr) {
    console.error('[reconcile/rollForward] load events failed', evErr);
    return { rolled_forward: 0 };
  }

  const eventsByPhaseDay = new Map<string, CalendarEventRow>();
  for (const e of (events ?? []) as CalendarEventRow[]) {
    if (!e.phase_id || !e.day_code) continue;
    eventsByPhaseDay.set(`${e.phase_id}:${e.day_code}`, e);
  }

  // 4. Build rows to insert (pure).
  const rows = buildPlansForWindow({
    userId,
    startIso: todayIso,
    windowDays,
    occupied,
    weeklyPattern,
    phases: phaseRows,
    eventsByPhaseDay,
  });

  if (rows.length === 0) return { rolled_forward: 0 };

  // 5. Insert. We don't use ON CONFLICT because `plans` has no
  //    unique(user_id, date) index — and shouldn't gain one: future
  //    scenarios (gym + run on the same day) want multiple rows per date.
  //    The pre-query in step 1 is our duplicate guard.
  const { error: insErr, count } = await sb
    .from('plans')
    .insert(rows, { count: 'exact' });

  if (insErr) {
    console.error('[reconcile/rollForward] insert failed', insErr);
    return { rolled_forward: 0 };
  }

  return { rolled_forward: count ?? rows.length };
}
