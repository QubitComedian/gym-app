import { redirect } from 'next/navigation';
import Link from 'next/link';
import { supabaseServer } from '@/lib/supabase/server';
import {
  addDays, addMonths, endOfMonth, endOfWeek, format, isSameDay, isSameMonth,
  parseISO, startOfMonth, startOfWeek,
} from 'date-fns';
import IconGlyph from '@/components/ui/IconGlyph';
import StatusDot from '@/components/ui/StatusDot';
import { TYPE_LABEL } from '@/lib/session-types';

export const dynamic = 'force-dynamic';

type View = 'month' | 'week';

type DayEntry = {
  iso: string;
  items: Array<{
    kind: 'plan' | 'activity';
    id: string;
    type: string;
    day_code?: string | null;
    status: string;
    title: string;
  }>;
};

export default async function CalendarPage({ searchParams }: { searchParams: { view?: string; anchor?: string } }) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect('/login');

  const view: View = searchParams.view === 'week' ? 'week' : 'month';
  const anchor = searchParams.anchor ? parseISO(searchParams.anchor) : new Date();
  const today = new Date();

  // Range based on view
  const viewStart = view === 'month'
    ? startOfWeek(startOfMonth(anchor), { weekStartsOn: 1 })
    : startOfWeek(anchor, { weekStartsOn: 1 });
  const viewEnd = view === 'month'
    ? endOfWeek(endOfMonth(anchor), { weekStartsOn: 1 })
    : endOfWeek(anchor, { weekStartsOn: 1 });

  const startStr = format(viewStart, 'yyyy-MM-dd');
  const endStr = format(viewEnd, 'yyyy-MM-dd');

  const [{ data: plans }, { data: acts }] = await Promise.all([
    sb.from('plans')
      .select('id,date,type,day_code,status,prescription')
      .eq('user_id', user.id)
      .gte('date', startStr).lte('date', endStr)
      .order('date'),
    sb.from('activities')
      .select('id,date,type,status,plan_id')
      .eq('user_id', user.id)
      .gte('date', startStr).lte('date', endStr)
      .order('date'),
  ]);

  // Merge plans + unplanned activities into per-day entries.
  const byDay = new Map<string, DayEntry>();
  const getDay = (iso: string) => {
    if (!byDay.has(iso)) byDay.set(iso, { iso, items: [] });
    return byDay.get(iso)!;
  };
  const actByPlan = new Map<string, any>();
  (acts ?? []).forEach(a => { if (a.plan_id) actByPlan.set(a.plan_id, a); });

  (plans ?? []).forEach(p => {
    const act = actByPlan.get(p.id);
    const effStatus = act?.status ?? p.status;
    getDay(p.date).items.push({
      kind: act ? 'activity' : 'plan',
      id: act?.id ?? p.id,
      type: p.type,
      day_code: p.day_code,
      status: effStatus,
      title: TYPE_LABEL[p.type] ?? p.type,
    });
  });
  (acts ?? []).forEach(a => {
    if (a.plan_id) return;
    getDay(a.date).items.push({
      kind: 'activity',
      id: a.id,
      type: a.type,
      status: a.status,
      title: TYPE_LABEL[a.type] ?? a.type,
    });
  });

  const days: Date[] = [];
  for (let d = viewStart; d <= viewEnd; d = addDays(d, 1)) days.push(d);

  const prevAnchor = view === 'month' ? addMonths(anchor, -1) : addDays(anchor, -7);
  const nextAnchor = view === 'month' ? addMonths(anchor,  1) : addDays(anchor,  7);

  const title = view === 'month'
    ? format(anchor, 'MMMM yyyy')
    : `${format(viewStart, 'MMM d')} – ${format(viewEnd, 'MMM d')}`;

  return (
    <main className="max-w-xl mx-auto px-4 pt-5 pb-28">
      <header className="flex items-center justify-between mb-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          <p className="text-tiny text-muted mt-0.5">Tap any day to see detail or plan.</p>
        </div>
      </header>

      <div className="flex items-center justify-between mb-4">
        <div className="inline-flex rounded-lg bg-panel border border-border p-0.5 text-tiny">
          <Link
            href={`/calendar?view=month&anchor=${format(anchor, 'yyyy-MM-dd')}`}
            className={`px-3 py-1.5 rounded-md ${view === 'month' ? 'bg-panel-2 text-white' : 'text-muted'}`}
          >Month</Link>
          <Link
            href={`/calendar?view=week&anchor=${format(anchor, 'yyyy-MM-dd')}`}
            className={`px-3 py-1.5 rounded-md ${view === 'week' ? 'bg-panel-2 text-white' : 'text-muted'}`}
          >Week</Link>
        </div>
        <div className="flex items-center gap-1">
          <Link href={`/calendar?view=${view}&anchor=${format(prevAnchor, 'yyyy-MM-dd')}`} aria-label="previous"
            className="w-9 h-9 inline-flex items-center justify-center rounded-lg bg-panel border border-border text-muted">
            ‹
          </Link>
          <Link href={`/calendar?view=${view}`} className="px-3 h-9 inline-flex items-center rounded-lg bg-panel border border-border text-tiny text-muted">
            Today
          </Link>
          <Link href={`/calendar?view=${view}&anchor=${format(nextAnchor, 'yyyy-MM-dd')}`} aria-label="next"
            className="w-9 h-9 inline-flex items-center justify-center rounded-lg bg-panel border border-border text-muted">
            ›
          </Link>
        </div>
      </div>

      {view === 'month' ? (
        <MonthGrid anchor={anchor} days={days} byDay={byDay} today={today} />
      ) : (
        <WeekList days={days} byDay={byDay} today={today} />
      )}
    </main>
  );
}

function MonthGrid({
  anchor, days, byDay, today,
}: { anchor: Date; days: Date[]; byDay: Map<string, DayEntry>; today: Date }) {
  const weekdays = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  return (
    <>
      <div className="grid grid-cols-7 gap-1 px-0.5 mb-1.5">
        {weekdays.map(w => (
          <div key={w} className="text-center text-[10px] text-muted tracking-wider">{w}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1 rounded-xl border border-border bg-panel p-1">
        {days.map(d => {
          const iso = format(d, 'yyyy-MM-dd');
          const outOfMonth = !isSameMonth(d, anchor);
          const isToday = isSameDay(d, today);
          const entry = byDay.get(iso);
          const primary = entry?.items[0];
          return (
            <Link
              key={iso}
              href={`/calendar/${iso}`}
              className={`relative aspect-square rounded-lg flex flex-col items-center justify-start p-1.5 text-center text-[11px]
                ${isToday ? 'bg-accent-dim/40 ring-1 ring-accent/60' : 'bg-panel-2/50'}
                ${outOfMonth ? 'opacity-35' : ''}`}
            >
              <span className={`tabular-nums ${isToday ? 'text-accent font-semibold' : 'text-muted-2'}`}>
                {format(d, 'd')}
              </span>
              {primary && (
                <div className="mt-1 flex flex-col items-center gap-0.5 min-h-0">
                  <IconGlyph type={primary.type} size={18} />
                  {entry && entry.items.length > 1 && (
                    <span className="text-[9px] text-muted">+{entry.items.length - 1}</span>
                  )}
                </div>
              )}
              {primary && (
                <span className="absolute bottom-1 right-1">
                  <StatusDot status={primary.status as any} size={6} />
                </span>
              )}
            </Link>
          );
        })}
      </div>
      <Legend />
    </>
  );
}

function WeekList({ days, byDay, today }: { days: Date[]; byDay: Map<string, DayEntry>; today: Date }) {
  return (
    <ul className="space-y-2">
      {days.map(d => {
        const iso = format(d, 'yyyy-MM-dd');
        const entry = byDay.get(iso);
        const isToday = isSameDay(d, today);
        return (
          <li key={iso}>
            <Link href={`/calendar/${iso}`}
              className={`block rounded-xl px-4 py-3.5 ${isToday ? 'bg-accent-dim/30 border border-accent/40' : 'bg-panel border border-border'}`}
            >
              <div className="flex items-center gap-3">
                <div className="w-12 text-center">
                  <div className="text-[10px] text-muted uppercase tracking-wider">{format(d, 'EEE')}</div>
                  <div className={`tabular-nums text-lg leading-tight ${isToday ? 'text-accent font-semibold' : 'text-white'}`}>
                    {format(d, 'd')}
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  {entry && entry.items.length > 0 ? (
                    <ul className="space-y-1">
                      {entry.items.map(it => (
                        <li key={it.kind + it.id} className="flex items-center gap-2">
                          <IconGlyph type={it.type} size={16} />
                          <span className="text-small truncate">
                            {it.title}{it.day_code ? <span className="text-muted"> · {it.day_code}</span> : null}
                          </span>
                          <span className="ml-auto text-tiny text-muted uppercase tracking-wider">{it.status}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="text-tiny text-muted italic">Rest</div>
                  )}
                </div>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function Legend() {
  const items = [
    { label: 'Planned', cls: 'border border-muted' },
    { label: 'Done',    cls: 'bg-ok' },
    { label: 'Skipped', cls: 'bg-muted/40' },
    { label: 'Moved',   cls: 'bg-warn' },
    { label: 'Ad-hoc',  cls: 'bg-accent' },
  ];
  return (
    <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 text-[10px] text-muted">
      {items.map(i => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${i.cls}`} />{i.label}
        </span>
      ))}
    </div>
  );
}
