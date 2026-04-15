import { redirect, notFound } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import PrescriptionView, { exName } from '@/components/PrescriptionView';
import Link from 'next/link';
import ReviewButton from './ReviewButton';

export const dynamic = 'force-dynamic';

export default async function ActivityDetail({ params }: { params: { id: string } }) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect('/login');

  const { data: act } = await sb.from('activities').select('*').eq('user_id', user.id).eq('id', params.id).maybeSingle();
  if (!act) notFound();
  const { data: plan } = act.plan_id
    ? await sb.from('plans').select('*').eq('id', act.plan_id).maybeSingle()
    : { data: null } as any;

  const sets = act.data?.sets as Record<string, { w?: number | string; r?: number | string; rir?: number; note?: string; side?: string }[]> | undefined;

  return (
    <main className="max-w-xl mx-auto px-4 py-6 pb-28">
      <Link href="/history" className="text-xs text-muted">← back</Link>
      <h1 className="text-2xl font-bold tracking-tight mt-2">{act.type}{act.data?.day_code ? ` · ${act.data.day_code}` : ''}</h1>
      <p className="text-xs text-muted">{act.date} · {act.status} · {act.source}</p>

      {act.notes && (
        <div className="mt-3 text-sm bg-panel border border-border rounded-lg p-3">
          {act.notes}
        </div>
      )}

      {act.type === 'gym' && sets && (
        <section className="mt-4">
          <div className="text-[10px] uppercase tracking-wider text-muted mb-2">What you did</div>
          <ul className="space-y-2">
            {Object.entries(sets).map(([exId, rows]) => (
              <li key={exId} className="rounded-lg bg-panel-2 border border-border p-3">
                <div className="text-sm font-medium">{exName(exId)}</div>
                <div className="text-xs text-muted mt-1 space-y-0.5">
                  {rows.map((r, i) => (
                    <div key={i}>
                      Set {i + 1}: {r.w ?? '—'} × {r.r ?? '—'}
                      {r.rir != null && ` · RIR ${r.rir}`}
                      {r.note && ` · ${r.note}`}
                    </div>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {act.type !== 'gym' && act.data && Object.keys(act.data).length > 0 && (
        <section className="mt-4">
          <div className="text-[10px] uppercase tracking-wider text-muted mb-2">Details</div>
          <pre className="text-xs bg-panel-2 border border-border rounded-lg p-3 overflow-auto">{JSON.stringify(act.data, null, 2)}</pre>
        </section>
      )}

      {plan && (
        <section className="mt-5">
          <div className="text-[10px] uppercase tracking-wider text-muted mb-2">Was prescribed</div>
          <PrescriptionView prescription={plan.prescription || {}} />
        </section>
      )}

      <div className="mt-6">
        <ReviewButton activityId={act.id} />
      </div>
    </main>
  );
}
