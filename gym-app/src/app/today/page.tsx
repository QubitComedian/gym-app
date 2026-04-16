import Link from 'next/link';
import { supabaseServer } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { ensureUserSeeded } from '@/lib/seed/user-seed';
import TodayHero from '@/components/TodayHero';
import PendingBanner from '@/components/PendingBanner';
import ReturnFromGapBanner from '@/components/ReturnFromGapBanner';
import ReturnFromGapHero from '@/components/ReturnFromGapHero';
import PhaseTransitionBanner from '@/components/PhaseTransitionBanner';
import PhaseTransitionHero from '@/components/PhaseTransitionHero';
import ConflictBanner from '@/components/ConflictBanner';
import WeeklyStrip from '@/components/WeeklyStrip';
import LastSessionCard from '@/components/LastSessionCard';
import ActiveWindowChip from '@/components/ActiveWindowChip';
import CoachChat from '@/components/CoachChat';
import { summarizeWeek } from '@/lib/weekSummary';
import { buildWhy } from '@/lib/whyThisSession';
import { summarizeReturnFromGapProposal } from '@/lib/returnFromGap';
import { summarizePhaseTransitionProposal } from '@/lib/phaseTransition';
import { summarizeConflictProposal } from '@/lib/conflictProposal';
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
    { data: activeWindows },
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
    // Active availability windows intersecting the visible week. We
    // fetch the whole week (not just today) so the strip can overlay
    // kind badges on upcoming covered days too. The today-chip filters
    // down to the one covering today.
    sb.from('availability_windows')
      .select('id, starts_on, ends_on, kind, strategy')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .lte('starts_on', weekEndIso)
      .gte('ends_on', weekStartIso)
      .order('ends_on', { ascending: true }),
  ]);

  const weekWindows = (activeWindows ?? []) as Array<{
    starts_on: string;
    ends_on: string;
    kind: 'travel' | 'injury' | 'pause';
    strategy: 'auto' | 'bodyweight' | 'rest' | 'suppress';
  }>;
  // Window covering "today" (soonest-to-end first so we pick the most
  // imminently-ending one if the overlap invariant ever slipped).
  const activeWindow = weekWindows.find(
    (w) => w.starts_on <= today && w.ends_on >= today
  ) ?? null;

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
    windows: weekWindows,
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

  // Split pending proposals by kind. Dedicated UI for:
  //   - return_from_gap (banner or hero — welcome-back flow)
  //   - phase_transition (banner or hero — phase handoff flow)
  // Everything else falls through to the generic PendingBanner.
  //
  // Priority rule when both rfg AND pt are pending:
  //   - rfg ALWAYS wins the hero slot. The user is re-landing; the
  //     phase handoff is the next conversation, not this one.
  //   - If rfg takes hero, we still render pt as a banner above when pt
  //     is soft-tier (it's a gentle nudge, stacks cleanly).
  //   - If rfg takes hero AND pt is hard-tier, we suppress pt for this
  //     render. Accepting rfg fires reconcile → the next page load gets
  //     a fresh pt eval against the post-rfg plan state.
  //   - If rfg takes banner, pt can use hero if it's hard-tier.
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
  const topPtRaw = pendingList.find((p) => p.kind === 'phase_transition') ?? null;
  const ptViewRaw = topPtRaw
    ? summarizePhaseTransitionProposal({
        id: topPtRaw.id,
        rationale: topPtRaw.rationale,
        diff: topPtRaw.diff,
      })
    : null;
  // Apply hero-conflict suppression: rfg hero outranks a pt hero.
  const ptView =
    ptViewRaw && ptViewRaw.view === 'hero' && rfgView?.view === 'hero'
      ? null
      : ptViewRaw;
  // Conflict proposals — dedicated banner with option-based resolution.
  const conflictPending = pendingList
    .filter((p) => p.kind === 'conflict' || p.kind === 'meeting_conflict')
    .map((p) => summarizeConflictProposal({ id: p.id, kind: p.kind, rationale: p.rationale, diff: p.diff }))
    .filter((v): v is NonNullable<typeof v> => v !== null)
    .map((v) => v.props);

  const otherPending = pendingList.filter(
    (p) => p.kind !== 'return_from_gap' && p.kind !== 'phase_transition'
      && p.kind !== 'conflict' && p.kind !== 'meeting_conflict'
  );

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

      {/* Free-form chat with the AI coach — adapt plan for travel, sickness, time crunch, etc. */}
      <CoachChat />

      {activeWindow && (
        <ActiveWindowChip
          kind={activeWindow.kind as any}
          strategy={activeWindow.strategy as any}
          startsOn={activeWindow.starts_on}
          endsOn={activeWindow.ends_on}
          todayIso={today}
        />
      )}

      {rfgView?.view === 'banner' && (
        <ReturnFromGapBanner proposal={rfgView.props} />
      )}
      {ptView?.view === 'banner' && (
        <PhaseTransitionBanner proposal={ptView.props} />
      )}

      <ConflictBanner proposals={conflictPending} />

      <PendingBanner pending={otherPending} />

      {rfgView?.view === 'hero' ? (
        <ReturnFromGapHero proposal={rfgView.props} />
      ) : ptView?.view === 'hero' ? (
        <PhaseTransitionHero proposal={ptView.props} />
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
