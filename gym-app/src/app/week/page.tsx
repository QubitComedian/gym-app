import Link from 'next/link';
import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { addDays, format, startOfWeek } from 'date-fns';

export const dynamic = 'force-dynamic';

const TYPE_LABEL: Record<string, string> = {
  gym: 'Gym', run: 'Run', bike: 'Bike', swim: 'Swim',
  yoga: 'Yoga', climb: 'Climb', sauna_cold: 'Sauna', mobility: 'Mobility', rest: 'Rest', other: 'Other',
};

const STATUS_DOT: Record<string, string> = {
  done: 'bg-ok', skipped: 'bg-danger', moved: 'bg-yellow-400', planned: 'bg-muted', unplanned: 'bg-accent',
};

export default async function Week({ searchParams }: { searchParams: { w?: string } }) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect('/login');

  const offsetWeeks = parseInt(searchParams.w || '0', 10);
  const weekStart = addDays(startOfWeek(new Date(), { weekStartsOn: 1 }), offsetWeeks * 7);
  const weekEnd = addDays(weekStart, 6);
  const startStr = format(weekStart, 'yyyy-MM-dd');
  const endStr = format(weekEnd, 'yyyy-MM-dd');

  const [{ data: plans }, { data: acts }] = await Promise.all([
    sb.from('plans').select('id,date,type,day_code,status,prescription').eq('user_id', user.id).gte('date', startStr).lte('date', endStr).order('date'),
    sb.from('activities').select('id,date,type,status,plan_id').eq('user_id', user.id).gte('date', startStr).lte('date', endStr).order('date'),
  ]);

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const plansByDay = new Map<string, any[]>();
  (plans ?? []).forEach(p => {
    const k = p.date;
    if (!plansByDay.has(k)) plansByDay.set(k, []);
    plansByDay.get(k)!.push(p);
  });
  const actsByDay = new Map<string, any[]>();
  (acts ?? []).forEach(a => {
    const k = a.date;
    if (!actsByDay.has(k)) actsByDay.set(k, []);
    actsByDay.get(k)!.push(a);
  });

  return (
    <main className="max-w-xl mx-auto px-4 py-6 pb-28">
      <header className="mb-4 flex items-baseline justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Week</h1>
        <div className="flex gap-1 text-xs">
          <Link href={`/week?w=${offsetWeeks - 1}`} className="px-2 py-1 rounded bg-panel border border-border">←</Link>
          {offsetWeeks !== 0 && (
            <Link href="/week" className="px-2 py-1 rounded bg-panel border border-border">today</Link>
          )}
          <Link href={`/week?w=${offsetWeeks + 1}`} className="px-2 py-1 rounded bg-panel border border-border">→</Link>
        </div>
      </header>
      <p className="text-xs text-muted mb-4">{format(weekStart, 'MMM d')} – {format(weekEnd, 'MMM d, yyyy')}</p>

      <ul className="space-y-2">
        {days.map(d => {
          const iso = format(d, 'yyyy-MM-dd');
          const todayIso = format(new Date(), 'yyyy-MM-dd');
          const dayPlans = plansByDay.get(iso) || [];
          const dayActs = actsByDay.get(iso) || [];
          const isToday = iso === todayIso;
          return (
            <li key={iso} className={`rounded-xl border ${isToday ? 'border-accent/60 bg-accent-dim/30' : 'border-border bg-panel'} p-3`}>
              <div className="flex items-baseline justify-between">
                <div>
                  <div className="text-xs text-muted">{format(d, 'EEE')}</div>
                  <div className="font-semibold">{format(d, 'MMM d')}</div>
                </div>
                <Link href={`/log?date=${iso}`} className="text-xs text-accent">+ add</Link>
              </div>
              <div className="mt-2 space-y-1">
                {dayPlans.map(p => {
                  const matched = dayActs.find(a => a.plan_id === p.id);
                  const eff = matched?.status ?? p.status;
                  return (
                    <Link key={p.id} href={p.status === 'planned' && !matched ? `/log/${p.id}` : matched ? `/history/${matched.id}` : `/log/${p.id}`} className="flex items-center gap-2 text-sm">
                      <span className={`w-2 h-2 rounded-full ${STATUS_DOT[eff] ?? 'bg-muted'}`} />
                      <span className="flex-1">{TYPE_LABEL[p.type]}{p.day_code ? ` · ${p.day_code}` : ''}</span>
                      <span className="text-[11px] text-muted uppercase">{eff}</span>
                    </Link>
                  );
                })}
                {dayActs.filter(a => !a.plan_id).map(a => (
                  <Link key={a.id} href={`/history/${a.id}`} className="flex items-center gap-2 text-sm">
                    <span className={`w-2 h-2 rounded-full ${STATUS_DOT[a.status] ?? 'bg-muted'}`} />
                    <span className="flex-1">{TYPE_LABEL[a.type]} <span className="text-[10px] text-muted">unplanned</span></span>
                    <span className="text-[11px] text-muted uppercase">{a.status}</span>
                  </Link>
                ))}
                {dayPlans.length === 0 && dayActs.length === 0 && (
                  <div className="text-xs text-muted italic">— rest —</div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
