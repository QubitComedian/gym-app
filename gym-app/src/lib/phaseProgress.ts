/**
 * Phase progress summarizer for the session recap.
 * Computes week-in-phase, weekly plan completion, and a compact list of
 * phase-specific counters (from phases.weekly_targets).
 */

import { differenceInCalendarWeeks, parseISO, startOfWeek, endOfWeek, format, isWithinInterval } from 'date-fns';

export type PhaseProgressSummary = {
  phase: { id: string; code: string; name: string };
  weekIndex: number; // 1-based
  weekTotal: number | null;
  weekBar: { done: number; planned: number };
  targets: string[]; // human-readable weekly target lines (max 3)
};

type Phase = {
  id: string;
  code: string;
  name: string;
  starts_on: string | null;
  target_ends_on: string | null;
  weekly_targets?: Record<string, any> | null;
};

type PlanRow = { date: string; status: string };
type ActivityRow = { date: string; status: string; type: string };

export function summarizePhaseProgress(opts: {
  phase: Phase | null;
  plans: PlanRow[];
  activities: ActivityRow[];
  onDate: string;
}): PhaseProgressSummary | null {
  const { phase, plans, activities, onDate } = opts;
  if (!phase) return null;

  const today = parseISO(onDate + 'T00:00:00');
  const weekStart = startOfWeek(today, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(today, { weekStartsOn: 1 });

  // Week index in phase
  let weekIndex = 1;
  let weekTotal: number | null = null;
  if (phase.starts_on) {
    const start = parseISO(phase.starts_on + 'T00:00:00');
    weekIndex = Math.max(1, differenceInCalendarWeeks(today, start, { weekStartsOn: 1 }) + 1);
    if (phase.target_ends_on) {
      const end = parseISO(phase.target_ends_on + 'T00:00:00');
      weekTotal = Math.max(weekIndex, differenceInCalendarWeeks(end, start, { weekStartsOn: 1 }) + 1);
    }
  }

  // Weekly plan completion — non-rest planned items in this week, done count
  const weekPlans = plans.filter(p => {
    const d = parseISO(p.date + 'T00:00:00');
    return isWithinInterval(d, { start: weekStart, end: weekEnd });
  });
  const planned = weekPlans.length;
  const weekActDates = new Set(
    activities
      .filter(a => {
        if (a.status !== 'done') return false;
        const d = parseISO(a.date + 'T00:00:00');
        return isWithinInterval(d, { start: weekStart, end: weekEnd });
      })
      .map(a => a.date)
  );
  const done = weekPlans.filter(p => weekActDates.has(p.date)).length;

  // Weekly targets — compact list, cap at 3, strip nulls
  const targets: string[] = [];
  const wt = phase.weekly_targets ?? {};
  for (const [k, v] of Object.entries(wt)) {
    if (!v) continue;
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    const label = k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    targets.push(`${label}: ${v}`);
    if (targets.length >= 3) break;
  }

  return {
    phase: { id: phase.id, code: phase.code, name: phase.name },
    weekIndex,
    weekTotal,
    weekBar: { done, planned },
    targets,
  };
}

export function formatWeekLabel(s: PhaseProgressSummary): string {
  if (s.weekTotal) return `${s.phase.name} · week ${s.weekIndex} of ${s.weekTotal}`;
  return `${s.phase.name} · week ${s.weekIndex}`;
}

export function formatWeekRange(onDate: string): string {
  const d = parseISO(onDate + 'T00:00:00');
  const start = startOfWeek(d, { weekStartsOn: 1 });
  const end = endOfWeek(d, { weekStartsOn: 1 });
  return `${format(start, 'MMM d')} – ${format(end, 'MMM d')}`;
}
