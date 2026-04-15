import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { format, parseISO, isBefore, isSameDay, addDays } from 'date-fns';
import PrescriptionView, { exName } from '@/components/PrescriptionView';
import IconGlyph from '@/components/ui/IconGlyph';
import StatusDot from '@/components/ui/StatusDot';
import { TYPE_LABEL } from '@/lib/session-types';
import AdjustSheet from '@/components/AdjustSheet';
import ReviewTrigger from '@/components/ReviewTrigger';

export const dynamic = 'force-dynamic';

function parseDateParam(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  try { return parseISO(s); } catch { return null; }
}

export default async function CalendarDay({ params }: { params: { date: string } }) {
  const d = parseDateParam(params.date);
  if (!d) notFound();

  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect('/login');

  const iso = params.date;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const isPast = isBefore(d, today) && !isSameDay(d, today);
  const isToday = isSameDay(d, today);
  // future = everything after today

  // If it's today, route to Today tab (single source of truth for "do this now")
  if (isToday) redirect('/today');

  const [{ data: plans }, { data: acts }] = await Promise.all([
    sb.from('plans').select('*').eq('user_id', user.id).eq('date', iso).order('id'),
    sb.from('activities').select('*').eq('user_id', user.id).eq('date', iso).order('id'),
  ]);

  const plan = plans?.[0] ?? null;
  const activity = acts?.find(a => a.plan_id === plan?.id) ?? acts?.[0] ?? null;

  const prevIso = format(addDays(d, -1), 'yyyy-MM-dd');
  const nextIso = format(addDays(d, 1), 'yyyy-MM-dd');

  return (
    <main className="max-w-xl mx-auto px-4 pt-4 pb-28">
      <div className="flex items-center justify-between mb-4">
        <Link href="/calendar" className="text-tiny text-muted">← Calendar</Link>
        <div className="flex items-center gap-1 text-tiny">
          <Link href={`/calendar/${prevIso}`} className="px-2 py-1 rounded bg-panel border border-border text-muted">‹</Link>
          <Link href={`/calendar/${nextIso}`} className="px-2 py-1 rounded bg-panel border border-border text-muted">›</Link>
        </div>
      </div>

      <header className="mb-5">
        <div className="text-tiny text-muted uppercase tracking-wider">{format(d, 'EEEE')}</div>
        <h1 className="text-2xl font-bold tracking-tight">{format(d, 'MMMM d, yyyy')}</h1>
      </header>

      {isPast
        ? <PastDay plan={plan} activity={activity} iso={iso} />
        : <FutureDay plan={plan} iso={iso} />
      }
    </main>
  );
}

/* ---------- past: show activity detail ---------- */
function PastDay({ plan, activity, iso }: { plan: any; activity: any; iso: string }) {
  if (activity) {
    const sets = activity.data?.sets as Record<string, { w?: number | string; r?: number | string; rir?: number; note?: string }[]> | undefined;
    return (
      <>
        <section className="rounded-xl bg-panel border border-border overflow-hidden mb-4">
          <div className="flex items-center gap-3 px-4 py-3.5 border-b border-border">
            <IconGlyph type={activity.type} size={22} />
            <div className="flex-1 min-w-0">
              <div className="text-lg font-semibold">
                {TYPE_LABEL[activity.type] ?? activity.type}{activity.data?.day_code ? ` · ${activity.data.day_code}` : ''}
              </div>
              <div className="text-tiny text-muted flex items-center gap-1.5 mt-0.5">
                <StatusDot status={activity.status} size={7} />
                <span className="uppercase tracking-wider">{activity.status}</span>
                {activity.sentiment != null && (
                  <span className="ml-1">{['😵','😕','😐','🙂','💪'][activity.sentiment - 1]}</span>
                )}
              </div>
            </div>
          </div>
          {activity.notes && (
            <div className="px-4 py-3 text-small italic text-muted-2 border-b border-border">
              {activity.notes}
            </div>
          )}
          {activity.type === 'gym' && sets && (
            <div className="p-4">
              <div className="text-micro uppercase tracking-wider text-muted mb-2">Sets</div>
              <ul className="space-y-2.5">
                {Object.entries(sets).map(([exId, rows]) => (
                  <li key={exId} className="rounded-lg bg-panel-2 border border-border px-3.5 py-3">
                    <div className="text-small font-medium mb-1.5">{exName(exId)}</div>
                    <ul className="space-y-1 text-tiny tabular-nums">
                      {rows.map((r, i) => (
                        <li key={i} className="flex items-center gap-3 text-muted-2">
                          <span className="text-muted w-6">#{i + 1}</span>
                          <span className="text-white tabular-nums">
                            {r.w ?? '—'}<span className="text-muted mx-1">×</span>{r.r ?? '—'}
                          </span>
                          {r.rir != null && <span className="text-muted">· RIR {r.rir}</span>}
                          {r.note && <span className="text-muted italic truncate">· {r.note}</span>}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {activity.type !== 'gym' && activity.data && Object.keys(activity.data).length > 0 && (
            <div className="p-4">
              <div className="text-micro uppercase tracking-wider text-muted mb-2">Details</div>
              <dl className="grid grid-cols-2 gap-y-1 text-small">
                {Object.entries(activity.data).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted capitalize">{k.replace(/_/g, ' ')}</dt>
                    <dd className="tabular-nums">{String(v)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </section>

        {plan && plan.prescription && (
          <section className="rounded-xl bg-panel border border-border p-4 mb-4 opacity-80">
            <div className="text-micro uppercase tracking-wider text-muted mb-2">Was prescribed</div>
            <PrescriptionView prescription={plan.prescription} dense />
          </section>
        )}

        <ReviewTrigger activityId={activity.id} />
      </>
    );
  }

  // Past day with no activity
  return (
    <section className="rounded-xl bg-panel border border-border p-5 text-center">
      <div className="text-small font-medium text-muted-2 mb-1">Nothing logged</div>
      {plan ? (
        <>
          <p className="text-tiny text-muted mb-4">You had <b>{TYPE_LABEL[plan.type]}</b> planned.</p>
          <Link href={`/log/${plan.id}?retro=1`} className="inline-block rounded-lg bg-accent text-black px-4 py-2.5 text-small font-semibold">
            Log retroactively
          </Link>
        </>
      ) : (
        <Link href={`/log?date=${iso}`} className="inline-block rounded-lg bg-panel-2 border border-border px-4 py-2.5 text-small">
          Log something for this day
        </Link>
      )}
    </section>
  );
}

/* ---------- future: show prescription + adjust ---------- */
function FutureDay({ plan, iso }: { plan: any; iso: string }) {
  if (!plan) {
    return (
      <section className="rounded-xl bg-panel border border-border p-5 text-center">
        <div className="text-small font-medium mb-1">Nothing planned</div>
        <p className="text-tiny text-muted mb-4">Ask Claude to propose a session, or add one manually.</p>
        <div className="grid grid-cols-2 gap-2">
          <AdjustSheet date={iso} mode="propose" label="Propose with AI" />
          <Link href={`/log?date=${iso}`} className="rounded-lg bg-panel-2 border border-border px-4 py-2.5 text-small">
            Add manually
          </Link>
        </div>
      </section>
    );
  }

  return (
    <>
      <section className="rounded-xl bg-panel border border-border overflow-hidden mb-4">
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-border">
          <IconGlyph type={plan.type} size={22} />
          <div className="flex-1 min-w-0">
            <div className="text-lg font-semibold">
              {TYPE_LABEL[plan.type] ?? plan.type}{plan.day_code ? ` · ${plan.day_code}` : ''}
            </div>
            <div className="text-tiny text-muted uppercase tracking-wider mt-0.5">Planned</div>
          </div>
        </div>
        <div className="p-4">
          <PrescriptionView prescription={plan.prescription} dense />
        </div>
      </section>

      <div className="grid grid-cols-2 gap-2">
        <AdjustSheet planId={plan.id} date={iso} mode="adjust" label="Ask AI to adjust" />
        <Link href={`/log/${plan.id}`} className="rounded-lg bg-accent text-black font-semibold px-4 py-2.5 text-small text-center">
          Start early
        </Link>
      </div>
    </>
  );
}
