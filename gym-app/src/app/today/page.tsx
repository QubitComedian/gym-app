import Link from 'next/link';
import { supabaseServer } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { ensureUserSeeded } from '@/lib/seed/user-seed';
import TodayHero from '@/components/TodayHero';
import PendingBanner from '@/components/PendingBanner';
import ReturnFromGapBanner from '@/components/ReturnFromGapBanner';
import ReturnFromGapHero from '@/components/ReturnFromGapHero';
import WeeklyStrip from '@/components/WeeklyStrip';
import LastSessionCard from '@/components/LastSessionCard';
import { summarizeWeek } from '@/lib/weekSummary';
import { buildWhy } from '@/lib/whyThisSession';
import { summarizeReturnFromGapProposal } from '@/lib/returnFromGap';
import { reconcile } from '@/lib/reconcile';
import { format, startOfWeek, endOfWeek, subDays, parseISO } from 'date-fns';

export const dynamic = 'force-dynamic';

export default async function Today() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect('/login');
  try { await ensureUserSeeded(user.id); } catch (e) { console.error('[seed]', e); }

  // Reconcile pass — ageOut, rollForward, dropOff detection. Debounced
  // (30-min freshness gate) inside reconcile() so a chatty tab isn't
  // expensive. We await so any new return_from_gap proposal is visible
  // on this render rather than the next.
  try {
    await reconcile(sb, user.id, new Date(), 'today_page_load');
  } catch (e) {
    console.error('[reconcile:today]', e);
  }

  const now = new Date();
  const today = format(now, 'yyyy-MM-dd');
  const todayDate = parseISO(today + 'T00:00:00');
  const weekStartIso = format(startOfWeek(todayDate, { weekStartsOn: 1 }), 'yyyy-MM-dd');
  const weekEndIso = format(endOfWeek(todayDate, { weekStartsOn: 1 }), 'yyyy-MM-dd');
  const history8wIso = format(subDays(todayDate, 56), 'yyyy-MM-dd');
  const yesterdayIso = format(subDays(todayDate, 1), 'yyyy-MM-dd');

  const [
    { data: todayPlan },
    { data: activePhase },
    { data: pending },
    { data: weekPlans },
    { data: weekActivities },
    { data: yesterdayActivity },
    { data: yesterdayPlan },
    { data: historyActivities },
    { data: recentProposals },
  ] = await Promise.all([
    sb.from('plans').select('id,date,type,day_code,status,prescription,created_at')
      .eq('user_id', user.id).eq('date', today).order('id').limit(1).maybeSingle(),
    sb.from('phases').select('id,code,name,description,starts_on,target_ends_on,target_ends_on')
      .eq('user_id', user.id).eq('status', 'active').maybeSingle(),
    sb.from('ai_proposals').select('id,rationale,triggered_by,created_at,kind,diff')
      .eq('user_id', user.id).eq('status', 'pending')
      .order('created_at', { ascending: false }).limit(5),
    sb.from('plans').select('id,date,type,day_code,status')
      .eq('user_id', user.id).gte('date', weekStartIso).lte('date', weekEndIso),
    sb.from('activities').select('id,date,type,status,data,plan_id')
      .eq('user_id', user.id).gte('date', weekStartIso).lte('date', weekEndIso),
    sb.from('activities').select('id,date,type,status,notes,data')
      .eq('user_id', user.id).eq('date', yesterdayIso).order('id', { ascending: false }).limit(1).maybeSingle(),
    sb.from('plans').select('id,date,type,day_code,status')
      .eq('user_id', user.id).eq('date', yesterdayIso).order('id').limit(1).maybeSingle(),
    sb.from('activities').select('id,date,type,status,data')
      .eq('user_id', user.id).gte('date', history8wIso).lte('date', today)
      .order('date', { ascending: false }).limit(200),
    sb.from('ai_proposals').select('id,status,applied_at,created_at,source_activity_id,rationale,diff')
      .eq('user_id', user.id).order('created_at', { ascending: false }).limit(40),
  ]);

  // Already completed today for this plan?
  let alreadyDone = false;
  if (todayPlan) {
    const { data: actToday } = await sb.from('activities').select('id,status')
      .eq('user_id', user.id).eq('date', today).eq('plan_id', todayPlan.id).maybeSingle();
    alreadyDone = !!actToday && actToday.status === 'done';
  }

  // Weekly strip summary
  const weekSummary = summarizeWeek({
    onDate: today,
    plans: weekPlans ?? [],
    activities: weekActivities ?? [],
    phase: activePhase ?? null,
  });

  // Why this session — deterministic
  const why = todayPlan
    ? buildWhy({
        today,
        plan: todayPlan,
        phase: activePhase ?? null,
        recentActivities: (historyActivities ?? []) as any,
        proposals: (recentProposals ?? []) as any,
      })
    : null;

  // LastSessionCard inputs — prefer yesterday's activity; if none AND no yesterday plan,
  // fall back to most recent done activity within 14 days so returning users see context.
  let lastActivity: any = yesterdayActivity ?? null;
  if (!lastActivity && !yesterdayPlan) {
    const fallbackFromIso = format(subDays(todayDate, 14), 'yyyy-MM-dd');
    const { data: recentDone } = await sb.from('activities')
      .select('id,date,type,status,notes,data')
      .eq('user_id', user.id)
      .in('status', ['done', 'skipped'])
      .gte('date', fallbackFromIso).lt('date', today)
      .order('date', { ascending: false }).limit(1).maybeSingle();
    lastActivity = recentDone ?? null;
  }

  // Split pending proposals: the top return_from_gap (if any) is
  // handled by the dedicated banner/hero; everything else falls through
  // to the regular PendingBanner.
  const pendingList = (pending ?? []) as Array<{
    id: string;
    rationale: string | null;
    triggered_by: string;
    created_at: string;
    kind: string | null;
    diff: unknown;
  }>;
  const topRfgRaw = pendingList.find((p) => p.kind === 'return_from_gap') ?? null;
  const rfgView = topRfgRaw
    ? summarizeReturnFromGapProposal({
        id: topRfgRaw.id,
        rationale: topRfgRaw.rationale,
        diff: topRfgRaw.diff,
      })
    : null;
  const otherPending = pendingList.filter((p) => p.kind !== 'return_from_gap');

  // Proposal tied to the last activity (verdict chip)
  let lastProposal: any = null;
  if (lastActivity?.id) {
    const { data: p } = await sb.from('ai_proposals')
      .select('id,status,rationale,diff')
      .eq('user_id', user.id)
      .eq('source_activity_id', lastActivity.id)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    lastProposal = p ?? null;
  }

  return (
    <main className="max-w-xl mx-auto px-4 pt-5 pb-28">
      <header className="mb-5 flex items-center justify-between">
        <div>
          <div className="text-tiny text-muted uppercase tracking-wider">{format(now, 'EEEE')}</div>
          <h1 className="text-2xl font-bold tracking-tight">Today</h1>
        </div>
        {activePhase && (
          <Link href="/you" className="text-right">
            <div className="text-[10px] text-muted uppercase tracking-wider">Phase</div>
            <div className="text-small font-medium">{activePhase.code}</div>
          </Link>
        )}
      </header>

      <WeeklyStrip summary={weekSummary} />

      {rfgView?.view === 'banner' && (
        <ReturnFromGapBanner proposal={rfgView.props} />
      )}

      <PendingBanner pending={otherPending} />

      {rfgView?.view === 'hero' ? (
        <ReturnFromGapHero proposal={rfgView.props} />
      ) : (
        <>
          <LastSessionCard
            today={today}
            activity={lastActivity}
            plan={yesterdayPlan ?? null}
            proposal={lastProposal}
          />

          <TodayHero
            plan={todayPlan ?? null}
            alreadyDone={alreadyDone}
            today={today}
            why={why}
          />
        </>
      )}
    </main>
  );
}
