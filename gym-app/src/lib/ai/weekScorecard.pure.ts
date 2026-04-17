/**
 * weekScorecard — pure helper that turns (plans, activities, today) into a
 * "what did this week look like" snapshot the coach can reason against.
 *
 * Why it exists:
 *   The coach needs to know not just what's *planned* next, but what the
 *   user *committed to this week*, what they *actually did*, and what's
 *   still outstanding. Without that, "can I skip today?" collapses to
 *   "delete today's row" — which was the original bug.
 *
 * Definitions used here:
 *   - "week" = Monday-first ISO week containing `today` (locale-free).
 *   - done_by_type:    activities with status='done'     inside the week.
 *   - skipped_by_type: activities with status='skipped'  inside the week.
 *   - planned_by_type: plans with status='planned' AND date >= today
 *                      inside the week (i.e. remaining commitments).
 *
 * Pure: no DB, no I/O. Accepts plain strings for dates and does all
 *       comparisons lexicographically on 'YYYY-MM-DD' (sortable).
 */

export type ScorecardActivity = {
  date: string;   // 'YYYY-MM-DD'
  type: string;   // 'gym' | 'run' | ...
  status: string; // 'done' | 'skipped' | 'planned' | ...
};

export type ScorecardPlan = {
  date: string;
  type: string;
  status: string;
};

export type WeekScorecard = {
  today: string;
  week_start: string;               // Monday (YYYY-MM-DD)
  week_end: string;                 // Sunday (YYYY-MM-DD)
  planned_by_type: Record<string, number>;
  done_by_type: Record<string, number>;
  skipped_by_type: Record<string, number>;
  total_planned: number;            // remaining commitments from today onward
  total_done: number;
  total_skipped: number;
};

/**
 * Monday-first ISO week bounds for a given 'YYYY-MM-DD'.
 * JS getDay(): Sun=0, Mon=1, ..., Sat=6 — we shift so Monday=0.
 *
 * Exported so tests can verify the shift directly instead of round-tripping
 * through buildWeekScorecard.
 */
export function weekBounds(today: string): { week_start: string; week_end: string } {
  const [y, m, d] = today.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  const dow = base.getUTCDay();                     // 0..6, Sun=0
  const offset = (dow + 6) % 7;                     // Mon=0..Sun=6
  const start = new Date(base);
  start.setUTCDate(base.getUTCDate() - offset);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  const iso = (dt: Date) => dt.toISOString().slice(0, 10);
  return { week_start: iso(start), week_end: iso(end) };
}

function inc(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1;
}

function totalOf(map: Record<string, number>): number {
  let n = 0;
  for (const k in map) n += map[k];
  return n;
}

export function buildWeekScorecard(opts: {
  today: string;
  activities: ScorecardActivity[];
  plans: ScorecardPlan[];
}): WeekScorecard {
  const { today, activities, plans } = opts;
  const { week_start, week_end } = weekBounds(today);

  const planned_by_type: Record<string, number> = {};
  const done_by_type: Record<string, number> = {};
  const skipped_by_type: Record<string, number> = {};

  for (const a of activities) {
    if (a.date < week_start || a.date > week_end) continue;
    if (a.status === 'done') inc(done_by_type, a.type);
    else if (a.status === 'skipped') inc(skipped_by_type, a.type);
  }

  for (const p of plans) {
    if (p.date < today || p.date > week_end) continue;      // only remaining days in this week
    if (p.status === 'planned') inc(planned_by_type, p.type);
    // plans with status='skipped' or 'done' are reflected via activities;
    // avoid double-counting here.
  }

  return {
    today,
    week_start,
    week_end,
    planned_by_type,
    done_by_type,
    skipped_by_type,
    total_planned: totalOf(planned_by_type),
    total_done: totalOf(done_by_type),
    total_skipped: totalOf(skipped_by_type),
  };
}
