import Link from 'next/link';
import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { format, parseISO } from 'date-fns';

export const dynamic = 'force-dynamic';

const TYPE_LABEL: Record<string, string> = {
  gym: 'Gym', run: 'Run', bike: 'Bike', swim: 'Swim',
  yoga: 'Yoga', climb: 'Climb', sauna_cold: 'Sauna+Cold', mobility: 'Mobility', rest: 'Rest', other: 'Other',
};

export default async function History() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect('/login');

  const { data: acts } = await sb
    .from('activities')
    .select('id,date,type,status,sentiment,notes,data,plan_id')
    .eq('user_id', user.id)
    .order('date', { ascending: false })
    .limit(120);

  const grouped = new Map<string, any[]>();
  (acts ?? []).forEach(a => {
    const key = a.date.slice(0, 7); // yyyy-mm
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(a);
  });

  return (
    <main className="max-w-xl mx-auto px-4 py-6 pb-28">
      <h1 className="text-2xl font-bold tracking-tight mb-4">History</h1>
      {!acts?.length && <p className="text-sm text-muted">Nothing logged yet. Go log something.</p>}
      {Array.from(grouped.entries()).map(([month, items]) => (
        <section key={month} className="mb-5">
          <div className="text-[10px] uppercase tracking-wider text-muted mb-2">
            {format(parseISO(month + '-01'), 'MMMM yyyy')}
          </div>
          <ul className="rounded-xl bg-panel border border-border divide-y divide-border overflow-hidden">
            {items.map(a => (
              <li key={a.id}>
                <Link href={`/history/${a.id}`} className="flex items-baseline justify-between px-3 py-2.5">
                  <div>
                    <div className="text-sm font-medium">
                      {TYPE_LABEL[a.type]}
                      {a.data?.day_code && <span className="text-muted"> · {a.data.day_code}</span>}
                      {a.data?.distance_km && <span className="text-muted"> · {a.data.distance_km} km</span>}
                    </div>
                    <div className="text-[11px] text-muted">{a.date}{a.notes ? ` · ${a.notes.slice(0, 40)}` : ''}</div>
                  </div>
                  <div className="text-[10px] uppercase text-muted">{a.status}</div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
