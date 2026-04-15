import Link from 'next/link';
import { differenceInCalendarDays, format, parseISO } from 'date-fns';
import IconGlyph from './ui/IconGlyph';
import { TYPE_LABEL } from '@/lib/session-types';

type Activity = {
  id: string;
  date: string;
  type: string;
  status: string;
  notes?: string | null;
  data?: any;
};

type Plan = {
  id: string;
  date: string;
  type: string;
  day_code?: string | null;
};

type Proposal = {
  id: string;
  status: string;
  rationale?: string | null;
  diff?: any;
};

export default function LastSessionCard({
  today,
  activity,
  plan,
  proposal,
}: {
  today: string;
  activity: Activity | null;
  plan: Plan | null;
  proposal: Proposal | null;
}) {
  // Hide entirely if there's nothing to show: no activity AND no plan-for-yesterday
  if (!activity && !plan) return null;

  const todayDate = parseISO(today + 'T00:00:00');

  // ── Missed-plan case (plan for yesterday, no activity anywhere recent)
  if (!activity && plan) {
    // Only shown when plan.date === yesterday (the fetch pins it). Frame as a retro-log nudge.
    const planDate = parseISO(plan.date + 'T00:00:00');
    const daysAgo = differenceInCalendarDays(todayDate, planDate);
    const dateLabel =
      daysAgo === 1 ? 'Yesterday' :
      daysAgo < 7 ? format(planDate, 'EEEE') :
      format(planDate, 'MMM d');
    return (
      <Link
        href={`/calendar/${plan.date}`}
        className="block rounded-xl bg-panel border border-border px-4 py-3 mb-4 hover:border-accent/40 transition-colors"
      >
        <div className="flex items-center gap-3">
          <IconGlyph type={plan.type} size={20} color="#8a8a8a" />
          <div className="flex-1 min-w-0">
            <div className="text-tiny text-muted uppercase tracking-wider">{dateLabel}</div>
            <div className="text-small truncate">
              Was <span className="font-medium">{TYPE_LABEL[plan.type]}{plan.day_code ? ` · ${plan.day_code}` : ''}</span>
              <span className="text-muted-2"> — nothing logged</span>
            </div>
          </div>
          <span className="text-accent text-tiny shrink-0">Log retroactively ›</span>
        </div>
      </Link>
    );
  }

  if (!activity) return null;

  const actDate = parseISO(activity.date + 'T00:00:00');
  const daysAgo = differenceInCalendarDays(todayDate, actDate);
  const dateLabel =
    daysAgo === 0 ? 'Earlier today' :
    daysAgo === 1 ? 'Yesterday' :
    daysAgo < 7 ? `Last ${format(actDate, 'EEEE')}` :
    format(actDate, 'MMM d');

  const summary = buildSummary(activity);
  const verdict = buildVerdict(proposal);

  return (
    <Link
      href={`/calendar/${activity.date}`}
      className="block rounded-xl bg-panel border border-border px-4 py-3 mb-4 hover:border-accent/40 transition-colors"
    >
      <div className="flex items-center gap-3">
        <IconGlyph type={activity.type} size={20} />
        <div className="flex-1 min-w-0">
          <div className="text-tiny text-muted uppercase tracking-wider">
            {dateLabel}
            {daysAgo >= 3 && <span className="text-muted-2 normal-case tracking-normal"> · {daysAgo} days ago</span>}
          </div>
          <div className="text-small truncate">
            <span className="font-medium">{TYPE_LABEL[activity.type] ?? activity.type}{activity.data?.day_code ? ` · ${activity.data.day_code}` : ''}</span>
            {summary && <span className="text-muted-2"> · {summary}</span>}
          </div>
        </div>
        {verdict ? (
          <span className={`text-tiny shrink-0 ${verdict.tone}`}>{verdict.label}</span>
        ) : (
          <span className="text-muted shrink-0">›</span>
        )}
      </div>
    </Link>
  );
}

function buildSummary(a: Activity): string | null {
  if (a.status === 'skipped') {
    return a.notes ? `skipped — ${a.notes.slice(0, 60)}` : 'skipped';
  }
  if (a.type === 'rest') return 'recovery logged';
  const d = a.data ?? {};
  const dur = d.duration_actual_min ?? d.duration_min;
  const parts: string[] = [];
  if (dur) parts.push(`${dur} min`);
  if (a.type === 'gym') {
    // Try top-set of heaviest exercise
    const top = heaviestTopSet(d.sets);
    if (top) parts.push(`top ${top.w}×${top.r}`);
  } else if (a.type === 'run' || a.type === 'bike') {
    if (typeof d.distance_km === 'number') parts.push(`${d.distance_km}km`);
    if (d.pace) parts.push(d.pace);
  } else if (a.type === 'swim') {
    if (typeof d.distance_m === 'number') parts.push(`${d.distance_m}m`);
    if (d.pace) parts.push(d.pace);
  } else if (a.type === 'climb') {
    if (d.hardest_send) parts.push(`hardest ${d.hardest_send}`);
  }
  return parts.length ? parts.join(' · ') : null;
}

function heaviestTopSet(sets: any): { w: number; r: number } | null {
  if (!sets || typeof sets !== 'object') return null;
  let best: { w: number; r: number } | null = null;
  for (const rows of Object.values(sets) as any[]) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const w = typeof row?.w === 'number' ? row.w : Number(row?.w);
      const r = typeof row?.r === 'number' ? row.r : Number(row?.r);
      if (!Number.isFinite(w) || !Number.isFinite(r) || r < 1) continue;
      if (!best || w > best.w || (w === best.w && r > best.r)) best = { w, r };
    }
  }
  return best;
}

function buildVerdict(p: Proposal | null): { label: string; tone: string } | null {
  if (!p) return null;
  const counts = {
    u: p.diff?.updates?.length ?? 0,
    c: p.diff?.creates?.length ?? 0,
    d: p.diff?.deletes?.length ?? 0,
  };
  const total = counts.u + counts.c + counts.d;
  if (p.status === 'pending' && total > 0) {
    return { label: 'Tweaks →', tone: 'text-accent' };
  }
  if (p.status === 'applied' || total === 0) {
    return { label: 'On track', tone: 'text-muted-2' };
  }
  return null;
}
