/**
 * Build the JSON context blob we feed to Claude for review/replan calls.
 */
import { supabaseServer } from '@/lib/supabase/server';
import { addDays, format, subDays } from 'date-fns';

export async function buildAIContext(opts: { userId: string; horizonDays?: number; recentDays?: number }) {
  const sb = supabaseServer();
  const horizonDays = opts.horizonDays ?? 14;
  const recentDays = opts.recentDays ?? 28;

  const today = format(new Date(), 'yyyy-MM-dd');
  const horizonEnd = format(addDays(new Date(), horizonDays), 'yyyy-MM-dd');
  const recentStart = format(subDays(new Date(), recentDays), 'yyyy-MM-dd');

  const [{ data: profile }, { data: phases }, { data: program }, { data: prefs }, { data: activities }, { data: plans }, { data: events }] = await Promise.all([
    sb.from('profiles').select('brief').eq('user_id', opts.userId).maybeSingle(),
    sb.from('phases').select('id,code,name,description,starts_on,target_ends_on,status,nutrition_rules,weekly_targets').eq('user_id', opts.userId).order('ordinal'),
    sb.from('programs').select('config').eq('user_id', opts.userId).eq('active', true).maybeSingle(),
    sb.from('exercise_prefs').select('exercise_id,label,status,reason').eq('user_id', opts.userId),
    sb.from('activities').select('id,date,type,status,sentiment,notes,data,plan_id').eq('user_id', opts.userId).gte('date', recentStart).order('date', { ascending: true }),
    sb.from('plans').select('id,date,type,day_code,status,prescription,phase_id').eq('user_id', opts.userId).gte('date', today).lte('date', horizonEnd).order('date'),
    sb.from('calendar_events').select('phase_id,day_type,day_code,prescription').eq('user_id', opts.userId),
  ]);

  return {
    today,
    brief: profile?.brief ?? null,
    program_config: program?.config ?? null,
    phases: phases ?? [],
    exercise_prefs: prefs ?? [],
    recent_activities: activities ?? [],
    upcoming_plans: plans ?? [],
    calendar_intent: events ?? [],
    horizon_days: horizonDays,
  };
}
