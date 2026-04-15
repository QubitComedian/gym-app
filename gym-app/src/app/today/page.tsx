import Link from 'next/link';
import { supabaseServer } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { ensureUserSeeded } from '@/lib/seed/user-seed';
import PrescriptionView from '@/components/PrescriptionView';
import SignOutButton from '@/components/SignOutButton';

export const dynamic = 'force-dynamic';

const TYPE_LABEL: Record<string, string> = {
  gym: 'Gym', run: 'Run', bike: 'Bike', swim: 'Swim',
  yoga: 'Yoga', climb: 'Climb', sauna_cold: 'Sauna+Cold',
  mobility: 'Mobility', rest: 'Rest', other: 'Other',
};

export default async function Today() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect('/login');
  try { await ensureUserSeeded(user.id); } catch (e) { console.error('[seed]', e); }

  const today = new Date().toISOString().slice(0, 10);

  const [{ data: todayPlan }, { data: nextPlan }, { data: activePhase }, { data: pendingProposals }] = await Promise.all([
    sb.from('plans').select('*').eq('user_id', user.id).eq('date', today).order('id').limit(1).maybeSingle(),
    sb.from('plans').select('*').eq('user_id', user.id).eq('status', 'planned').gt('date', today).order('date').limit(1).maybeSingle(),
    sb.from('phases').select('*').eq('user_id', user.id).eq('status', 'active').maybeSingle(),
    sb.from('ai_proposals').select('id,triggered_by,rationale,created_at').eq('user_id', user.id).eq('status', 'pending').order('created_at', { ascending: false }),
  ]);

  return (
    <main className="max-w-xl mx-auto px-4 py-6 pb-28">
      <header className="mb-5 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Today</h1>
          <p className="text-muted text-xs mt-0.5">{today}</p>
        </div>
        <SignOutButton />
      </header>

      {activePhase && (
        <section className="mb-4 p-3 rounded-xl bg-panel border border-border flex items-center justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted">Current phase</div>
            <div className="font-semibold leading-tight">{activePhase.code} · {activePhase.name}</div>
            <div className="text-xs text-muted mt-0.5">Through {activePhase.target_ends_on}</div>
          </div>
          <Link href="/settings" className="text-xs text-accent">settings</Link>
        </section>
      )}

      {pendingProposals && pendingProposals.length > 0 && (
        <Link href="/proposals" className="mb-4 block p-3 rounded-xl bg-accent-dim border border-accent/40">
          <div className="text-[10px] uppercase tracking-wider text-accent">AI proposal</div>
          <div className="text-sm font-medium mt-0.5">
            {pendingProposals.length} pending suggestion{pendingProposals.length > 1 ? 's' : ''} — review
          </div>
        </Link>
      )}

      <section className="mb-5">
        <div className="text-[10px] uppercase tracking-wider text-muted mb-2">On deck</div>
        {todayPlan ? (
          <div className="rounded-xl bg-panel border border-border p-4">
            <div className="flex items-baseline justify-between mb-2">
              <div>
                <div className="text-lg font-semibold">
                  {TYPE_LABEL[todayPlan.type]}{todayPlan.day_code ? ` · ${todayPlan.day_code}` : ''}
                </div>
                <div className="text-xs text-muted">{todayPlan.date} · {todayPlan.status}</div>
              </div>
              {todayPlan.status === 'planned' && todayPlan.type !== 'rest' && (
                <Link href={`/log/${todayPlan.id}`} className="bg-accent text-black text-sm font-semibold rounded-lg px-3 py-1.5">
                  Log
                </Link>
              )}
            </div>
            <PrescriptionView prescription={todayPlan.prescription || {}} />
          </div>
        ) : (
          <div className="rounded-xl bg-panel border border-border p-4 text-sm text-muted">
            Nothing planned today.
            <Link href="/log" className="ml-2 text-accent underline">Log unplanned →</Link>
          </div>
        )}
      </section>

      {nextPlan && (
        <section>
          <div className="text-[10px] uppercase tracking-wider text-muted mb-2">Next</div>
          <Link href={`/log/${nextPlan.id}`} className="block rounded-xl bg-panel border border-border p-3">
            <div className="flex items-baseline justify-between">
              <div className="font-medium">{TYPE_LABEL[nextPlan.type]}{nextPlan.day_code ? ` · ${nextPlan.day_code}` : ''}</div>
              <div className="text-xs text-muted">{nextPlan.date}</div>
            </div>
          </Link>
        </section>
      )}

      <div className="mt-6 grid grid-cols-2 gap-2">
        <Link href="/log" className="rounded-lg bg-panel border border-border text-center py-3 text-sm">+ Add session</Link>
        <Link href="/ai/replan" className="rounded-lg bg-panel border border-border text-center py-3 text-sm">Ask AI to replan</Link>
      </div>
    </main>
  );
}
