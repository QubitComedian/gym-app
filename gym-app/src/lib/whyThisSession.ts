/**
 * Deterministic explainer for "Why this session today?"
 * Builds a structured payload from existing DB rows — no Claude call.
 */

import { format, parseISO, differenceInCalendarDays, getDay } from 'date-fns';

export type WhyExplainer = {
  title: string;                 // "Why push today?" or "Why rest today?"
  phase: { name: string; code: string; weekIndex: number; weekTotal: number | null; focus: string | null } | null;
  pattern: { weekday: string; type: string; hits: number; total: number } | null;
  recent: { lastSameType?: { date: string; daysAgo: number }; lastRest?: { date: string; daysAgo: number }; lastHard?: { date: string; daysAgo: number } };
  origin: { text: string } | null;
  empty: boolean;                // true when we had to fall back to generic copy
};

type Plan = { id: string; date: string; type: string; day_code?: string | null; created_at?: string | null; prescription?: any };
type Phase = { code: string; name: string; description?: string | null; starts_on: string | null; target_ends_on: string | null } | null;
type Activity = { date: string; type: string; status: string; data?: any };
type Proposal = { id: string; status: string; applied_at: string | null; created_at: string; source_activity_id: string | null; rationale: string | null };

const WEEKDAY_LABEL = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

export function buildWhy(opts: {
  today: string;
  plan: Plan | null;
  phase: Phase;
  recentActivities: Activity[];     // last ~8 weeks, any status
  proposals: Proposal[];            // recent, applied proposals
}): WhyExplainer | null {
  const { plan, phase, recentActivities, proposals, today } = opts;
  if (!plan) return null;

  const todayDate = parseISO(today + 'T00:00:00');
  const todayType = plan.type;
  const isRest = todayType === 'rest';
  const modalityLabel = isRest ? 'rest' : (plan.day_code ?? todayType);

  // ── Phase section
  const phaseBlock = phase
    ? {
        name: phase.name,
        code: phase.code,
        weekIndex: (() => {
          if (!phase.starts_on) return 1;
          const start = parseISO(phase.starts_on + 'T00:00:00');
          return Math.max(1, Math.floor(differenceInCalendarDays(todayDate, start) / 7) + 1);
        })(),
        weekTotal: (() => {
          if (!phase.starts_on || !phase.target_ends_on) return null;
          const start = parseISO(phase.starts_on + 'T00:00:00');
          const end = parseISO(phase.target_ends_on + 'T00:00:00');
          return Math.max(1, Math.floor(differenceInCalendarDays(end, start) / 7) + 1);
        })(),
        focus: phase.description ? firstSentence(phase.description) : null,
      }
    : null;

  // ── Pattern — last 8 weeks of same weekday
  const weekday = getDay(todayDate); // 0=Sun
  const sameDayDone = recentActivities.filter(a => {
    if (a.status !== 'done') return false;
    return getDay(parseISO(a.date + 'T00:00:00')) === weekday;
  });
  let patternBlock: WhyExplainer['pattern'] = null;
  if (sameDayDone.length >= 3) {
    // Count matches against today's modality (use type; day_code not reliably on activities)
    const matches = sameDayDone.filter(a => a.type === (isRest ? 'rest' : todayType)).length;
    if (matches / sameDayDone.length >= 0.5) {
      patternBlock = {
        weekday: WEEKDAY_LABEL[weekday],
        type: isRest ? 'rest' : todayType,
        hits: matches,
        total: sameDayDone.length,
      };
    }
  }

  // ── Recent section
  const done = recentActivities
    .filter(a => a.status === 'done')
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first

  const lastSameType = !isRest
    ? done.find(a => a.type === todayType)
    : undefined;
  const lastRest = done.find(a => a.type === 'rest');
  const lastHard = isRest
    ? done.find(a => a.type !== 'rest')
    : undefined;

  const recent: WhyExplainer['recent'] = {};
  if (lastSameType) recent.lastSameType = { date: lastSameType.date, daysAgo: daysAgo(todayDate, lastSameType.date) };
  if (lastRest) recent.lastRest = { date: lastRest.date, daysAgo: daysAgo(todayDate, lastRest.date) };
  if (lastHard) recent.lastHard = { date: lastHard.date, daysAgo: daysAgo(todayDate, lastHard.date) };

  // ── Origin — correlate plan.created_at with applied proposals within ±24h
  let origin: WhyExplainer['origin'] = null;
  const createdAt = plan.created_at ? parseISO(plan.created_at) : null;
  if (createdAt) {
    const nearProp = proposals.find(p => {
      if (p.status !== 'applied' || !p.applied_at) return false;
      const applied = parseISO(p.applied_at);
      const delta = Math.abs(applied.getTime() - createdAt.getTime());
      return delta <= 24 * 60 * 60 * 1000;
    });
    if (nearProp) {
      const sourceActivity = recentActivities.find(a => 'id' in (a as any) && (a as any).id === nearProp.source_activity_id);
      const srcStr = sourceActivity
        ? ` after your ${format(parseISO(sourceActivity.date + 'T00:00:00'), 'EEEE')} ${sourceActivity.type} session`
        : '';
      origin = { text: `Claude adjusted this plan on ${format(createdAt, 'MMM d')}${srcStr}.` };
    } else {
      origin = { text: `Seeded from your calendar pattern on ${format(createdAt, 'MMM d')}.` };
    }
  }

  // ── Title
  const title = isRest
    ? 'Why rest today?'
    : `Why ${modalityLabel} today?`;

  const empty = !phaseBlock && !patternBlock && !recent.lastSameType && !recent.lastRest && !recent.lastHard && !origin;

  return {
    title,
    phase: phaseBlock,
    pattern: patternBlock,
    recent,
    origin,
    empty,
  };
}

function daysAgo(today: Date, iso: string): number {
  const d = parseISO(iso + 'T00:00:00');
  return Math.max(0, differenceInCalendarDays(today, d));
}

function firstSentence(s: string): string {
  const m = s.match(/^([^.!?]{8,160}[.!?])/);
  return m ? m[1].trim() : s.slice(0, 160).trim();
}

export function formatDaysAgo(n: number): string {
  if (n === 0) return 'today';
  if (n === 1) return 'yesterday';
  return `${n} days ago`;
}
