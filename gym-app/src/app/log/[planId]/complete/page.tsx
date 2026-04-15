import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { format, parseISO, addDays } from 'date-fns';
import { supabaseServer } from '@/lib/supabase/server';
import { detectWins, deltasFor, currentStreak } from '@/lib/wins';
import { summarizePhaseProgress, formatWeekLabel } from '@/lib/phaseProgress';
import RecapClient from './RecapClient';

export const dynamic = 'force-dynamic';

export default async function CompletePage({ params }: { params: { planId: string } }) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect('/login');

  const { data: plan } = await sb.from('plans')
    .select('*').eq('user_id', user.id).eq('id', params.planId).maybeSingle();
  if (!plan) notFound();

  // The activity saved for this plan — most recent done one takes precedence
  const { data: acts } = await sb.from('activities')
    .select('*').eq('user_id', user.id).eq('plan_id', plan.id)
    .order('completed_at', { ascending: false }).limit(1);
  const activity = acts?.[0] ?? null;
  if (!activity) {
    // No activity = user never actually saved. Send them back to the log.
    redirect(`/log/${plan.id}`);
  }

  // Rest-day branch: skip the full recap, redirect to Today with a tip.
  // The Today page doesn't consume the tip yet — harmless; leaving hook for later.
  if (activity.type === 'rest') {
    redirect('/today?rest=1');
  }

  // History for wins/deltas — last 180 days
  const since = format(addDays(new Date(), -180), 'yyyy-MM-dd');
  const { data: historyRows } = await sb.from('activities')
    .select('id,date,type,status,data')
    .eq('user_id', user.id)
    .gte('date', since)
    .lt('date', activity.date)
    .order('date', { ascending: false })
    .limit(120);
  const history = historyRows ?? [];

  // Phase + weekly progress
  const { data: phase } = await sb.from('phases')
    .select('id,code,name,starts_on,target_ends_on,weekly_targets')
    .eq('user_id', user.id).eq('status', 'active').maybeSingle();

  const weekStartIso = format(addDays(new Date(activity.date + 'T00:00:00'), -7), 'yyyy-MM-dd');
  const weekEndIso = format(addDays(new Date(activity.date + 'T00:00:00'), 7), 'yyyy-MM-dd');
  const [{ data: weekPlans }, { data: weekActs }] = await Promise.all([
    sb.from('plans').select('date,status').eq('user_id', user.id).gte('date', weekStartIso).lte('date', weekEndIso),
    sb.from('activities').select('date,status,type').eq('user_id', user.id).gte('date', weekStartIso).lte('date', weekEndIso),
  ]);

  const phaseSummary = summarizePhaseProgress({
    phase: phase ?? null,
    plans: weekPlans ?? [],
    activities: weekActs ?? [],
    onDate: activity.date,
  });

  // Next planned session after today
  const { data: nextPlans } = await sb.from('plans')
    .select('id,date,type,day_code,prescription')
    .eq('user_id', user.id)
    .gt('date', activity.date)
    .neq('type', 'rest')
    .order('date', { ascending: true })
    .limit(1);
  const nextPlan = nextPlans?.[0] ?? null;

  // AI proposal for this activity (may be pending or applied)
  const { data: proposal } = await sb.from('ai_proposals')
    .select('id,status,rationale,diff,created_at')
    .eq('user_id', user.id)
    .eq('source_activity_id', activity.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const wins = detectWins(activity, history);
  const deltas = activity.type === 'gym' ? deltasFor(activity, history) : [];
  const streak = currentStreak(activity, history);

  return (
    <RecapClient
      plan={plan}
      activity={activity}
      wins={wins}
      deltas={deltas}
      streak={streak}
      phaseSummary={phaseSummary}
      phaseLabel={phaseSummary ? formatWeekLabel(phaseSummary) : null}
      nextPlan={nextPlan}
      initialProposal={proposal ?? null}
      priorSessionCount={history.filter(a => a.status === 'done').length}
    />
  );
}
