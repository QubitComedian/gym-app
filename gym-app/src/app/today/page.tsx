import Link from 'next/link';
import { supabaseServer } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { ensureUserSeeded } from '@/lib/seed/user-seed';
import TodayHero from '@/components/TodayHero';
import PendingBanner from '@/components/PendingBanner';
import { format } from 'date-fns';

export const dynamic = 'force-dynamic';

export default async function Today() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect('/login');
  try { await ensureUserSeeded(user.id); } catch (e) { console.error('[seed]', e); }

  const today = format(new Date(), 'yyyy-MM-dd');

  const [{ data: todayPlan }, { data: activePhase }, { data: pending }] = await Promise.all([
    sb.from('plans').select('*').eq('user_id', user.id).eq('date', today).order('id').limit(1).maybeSingle(),
    sb.from('phases').select('id,code,name,target_ends_on').eq('user_id', user.id).eq('status', 'active').maybeSingle(),
    sb.from('ai_proposals').select('id,rationale,triggered_by,created_at')
      .eq('user_id', user.id).eq('status', 'pending')
      .order('created_at', { ascending: false }).limit(3),
  ]);

  // Already completed today for this plan?
  let alreadyDone = false;
  if (todayPlan) {
    const { data: actToday } = await sb.from('activities').select('id,status')
      .eq('user_id', user.id).eq('date', today).eq('plan_id', todayPlan.id).maybeSingle();
    alreadyDone = !!actToday && actToday.status === 'done';
  }

  return (
    <main className="max-w-xl mx-auto px-4 pt-5 pb-28">
      <header className="mb-5 flex items-center justify-between">
        <div>
          <div className="text-tiny text-muted uppercase tracking-wider">{format(new Date(), 'EEEE')}</div>
          <h1 className="text-2xl font-bold tracking-tight">Today</h1>
        </div>
        {activePhase && (
          <Link href="/you" className="text-right">
            <div className="text-[10px] text-muted uppercase tracking-wider">Phase</div>
            <div className="text-small font-medium">{activePhase.code}</div>
          </Link>
        )}
      </header>

      <PendingBanner pending={pending ?? []} />

      <TodayHero plan={todayPlan ?? null} alreadyDone={alreadyDone} today={today} />
    </main>
  );
}
