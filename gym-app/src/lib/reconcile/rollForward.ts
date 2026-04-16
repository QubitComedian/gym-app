/**
 * Rolling-window pass (P1.0 / PR-B, extended in P1.3 / PR-P).
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
 *   - Window-aware (P1.3): if an active availability_window covers a date
 *     in the horizon and that date doesn't yet have a plan row (e.g. the
 *     21-day window extended past what the window-apply already wrote),
 *     we emit a window-shaped row instead of the template row. Windows
 *     outside any phase still emit (a travel/pause/injury is a user-level
 *     declaration, not phase-bound).
 *
 * Pure logic (date math, row construction, window indexing) lives in
 * rollForward.pure.ts. This file is the thin I/O wrapper.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildPlansForWindow,
  datesFrom,
  indexWindowsByDate,
  type ActiveWindow,
  type CalendarEventRow,
  type PhaseRow,
} from './rollForward.pure';
import { getAllWeeklyPatternsForUser } from '@/lib/templates/loader';
import { enqueuePlanSync } from '@/lib/plans/write';

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

  // 2. Load what we need to fill gaps: per-phase weekly patterns,
  //    phases themselves, calendar events, and active availability windows
  //    that overlap the horizon.
  //
  //    The loader reads `weekly_templates` (P1.1) and falls back to the
  //    legacy `programs.config.split.weekly_pattern` for phases that
  //    haven't been templatized yet. Callers never need to know which.
  //
  //    Availability windows (P1.3) are loaded with a range filter — we
  //    only care about rows whose [starts_on, ends_on] intersects the
  //    horizon. The (user_id, status, ends_on, starts_on) index in
  //    migration 0006 makes this a single index seek, not a scan.
  const [
    patternByPhase,
    { data: phases, error: phaseErr },
    { data: events, error: evErr },
    { data: windows, error: winErr },
  ] = await Promise.all([
    getAllWeeklyPatternsForUser(sb, userId),
    sb
      .from('phases')
      .select('id, code, starts_on, target_ends_on')
      .eq('user_id', userId)
      .order('starts_on', { ascending: true }),
    sb
      .from('calendar_events')
      .select('id, phase_id, day_code, prescription, summary')
      .eq('user_id', userId),
    sb
      .from('availability_windows')
      .select('id, starts_on, ends_on, kind, strategy, note')
      .eq('user_id', userId)
      .eq('status', 'active')
      // Active window overlaps [todayIso, lastIso] iff
      //   ends_on >= todayIso AND starts_on <= lastIso.
      .gte('ends_on', todayIso)
      .lte('starts_on', lastIso),
  ]);

  if (phaseErr) {
    console.error('[reconcile/rollForward] load phases failed', phaseErr);
    return { rolled_forward: 0 };
  }
  if (evErr) {
    console.error('[reconcile/rollForward] load events failed', evErr);
    return { rolled_forward: 0 };
  }
  if (winErr) {
    // Windows are optional — a failure here shouldn't break roll-forward.
    // Log and proceed without any window overrides. The window-apply path
    // already wrote its rows at creation time; we'd just miss edge cases
    // where the horizon extends past what that apply covered.
    console.error('[reconcile/rollForward] load windows failed (non-fatal)', winErr);
  }

  const phaseRows: PhaseRow[] = (phases ?? []) as PhaseRow[];

  // No phases or no templates at all → nothing to walk UNLESS a window
  // still covers dates (windows are user-level and emit even outside any
  // phase). Continue with an empty phase/pattern set so the window branch
  // in buildPlanForDate still fires.
  const hasTemplate = phaseRows.length > 0 && patternByPhase.size > 0;
  const hasWindow = Array.isArray(windows) && windows.length > 0;
  if (!hasTemplate && !hasWindow) return { rolled_forward: 0 };

  // 3. Index calendar_events by `phase_id:day_code`.
  //    A user has ~5-8 distinct recurring templates per phase, so the set
  //    is tiny — one query is fine.
  const eventsByPhaseDay = new Map<string, CalendarEventRow>();
  for (const e of (events ?? []) as CalendarEventRow[]) {
    if (!e.phase_id || !e.day_code) continue;
    eventsByPhaseDay.set(`${e.phase_id}:${e.day_code}`, e);
  }

  // 4. Index windows by date (pure). `indexWindowsByDate` clips each
  //    window to [todayIso, lastIso] and applies precedence
  //    (pause > injury > travel; rest > bodyweight > suppress) when
  //    multiple windows overlap the same date.
  const activeWindows: ActiveWindow[] = (windows ?? []).map((w) => ({
    id: w.id as string,
    starts_on: w.starts_on as string,
    ends_on: w.ends_on as string,
    kind: w.kind as ActiveWindow['kind'],
    strategy: w.strategy as ActiveWindow['strategy'],
    note: (w.note ?? null) as string | null,
  }));
  const windowsByDate = indexWindowsByDate({
    windows: activeWindows,
    rangeStart: todayIso,
    rangeEnd: lastIso,
  });

  // 5. Build rows to insert (pure). Windows override the template on
  //    covered dates; uncovered dates fall through to normal template fill.
  const rows = buildPlansForWindow({
    userId,
    startIso: todayIso,
    windowDays,
    occupied,
    weeklyPattern: patternByPhase,
    phases: phaseRows,
    eventsByPhaseDay,
    windowsByDate,
  });

  if (rows.length === 0) return { rolled_forward: 0 };

  // 6. Insert. We don't use ON CONFLICT because `plans` has no
  //    unique(user_id, date) index — and shouldn't gain one: future
  //    scenarios (gym + run on the same day) want multiple rows per date.
  //    The pre-query in step 1 is our duplicate guard.
  //
  //    `.select('id')` captures the inserted row ids so we can enqueue
  //    Google Calendar sync jobs (PR-S / P1.4). The pre-PR-S shape used
  //    `{ count: 'exact' }` which only returned the row count; we
  //    preserve the return-count semantic by using the selected rows'
  //    length.
  const { data: insertedRows, error: insErr } = await sb
    .from('plans')
    .insert(rows)
    .select('id');

  if (insErr) {
    console.error('[reconcile/rollForward] insert failed', insErr);
    return { rolled_forward: 0 };
  }

  const insertedIds = (insertedRows ?? []).map((r: { id: string }) => r.id);
  const rolledForward = insertedIds.length;

  // 7. Enqueue Google Calendar sync jobs for the newly-created plans.
  //    No-op when the user has not connected Google or hasn't picked a
  //    training calendar (enqueuePlanSync gates on google_tokens). Called
  //    AFTER the insert commits so the worker can re-read the plan row
  //    on pickup. Failures here do NOT fail reconcile — plan rows are
  //    the source of truth and a nightly full-scan (PR-W) can rebuild
  //    the queue.
  if (insertedIds.length > 0) {
    await enqueuePlanSync(sb, userId, { upsertIds: insertedIds });
  }

  return { rolled_forward: rolledForward };
}
