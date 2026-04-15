import { redirect, notFound } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import LogClient from './LogClient';

export const dynamic = 'force-dynamic';

function collectExerciseIds(prescription: any): string[] {
  const ids: string[] = [];
  for (const b of prescription?.blocks ?? []) {
    if (b.kind === 'single' && b.exercise_id) ids.push(b.exercise_id);
    else if (b.kind === 'superset') {
      for (const it of b.items ?? []) if (it.exercise_id) ids.push(it.exercise_id);
    }
  }
  return ids;
}

type LastEntry = { date: string; sets: Array<{ w?: any; r?: any; rir?: any; note?: string }> };

export default async function LogPlan({ params }: { params: { planId: string } }) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect('/login');

  const { data: plan } = await sb.from('plans').select('*').eq('user_id', user.id).eq('id', params.planId).maybeSingle();
  if (!plan) notFound();

  const exIds = collectExerciseIds(plan.prescription);

  // Fetch recent gym activities to build "last time" map — last 120 days, up to 60 rows.
  const { data: recentActs } = await sb
    .from('activities')
    .select('date,data')
    .eq('user_id', user.id)
    .eq('type', 'gym')
    .eq('status', 'done')
    .lt('date', plan.date)
    .order('date', { ascending: false })
    .limit(60);

  const lastByEx: Record<string, LastEntry> = {};
  for (const ex of exIds) {
    for (const a of recentActs ?? []) {
      const setsMap = a?.data?.sets;
      if (setsMap && setsMap[ex] && Array.isArray(setsMap[ex]) && setsMap[ex].length > 0) {
        lastByEx[ex] = { date: a.date, sets: setsMap[ex] };
        break;
      }
    }
  }

  // Fetch exercise_prefs for swap filtering (banned exercises).
  const { data: prefs } = await sb
    .from('exercise_prefs')
    .select('exercise_id,status,reason')
    .eq('user_id', user.id);

  return <LogClient plan={plan} lastByEx={lastByEx} prefs={prefs ?? []} />;
}
