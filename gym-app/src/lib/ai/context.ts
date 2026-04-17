/**
 * Build the JSON context blob we feed to Claude for review/replan calls.
 *
 * The chat endpoint in particular leans on this to do *goal-anchored*
 * reasoning — so we surface goals explicitly (not buried inside `brief`)
 * and precompute a week scorecard so the model doesn't have to re-derive
 * "what did the user commit to vs. what did they do" on every call.
 */
import { supabaseServer } from '@/lib/supabase/server';
import { addDays, format, subDays } from 'date-fns';
import { buildWeekScorecard } from './weekScorecard.pure';

type NorthStar = {
  short_term?: string[];
  mid_term?: string[];
  long_term?: string[];
  end_state?: string;
};

type TrainerBrief = {
  north_star?: NorthStar;
  limitations?: string[];
  style_rules?: string[];
  [k: string]: unknown;
};

type ActivePhaseContext = {
  id: string;
  code: string | null;
  name: string;
  starts_on: string | null;
  target_ends_on: string | null;
  days_elapsed: number | null;
  days_remaining: number | null;
  weekly_targets: unknown;
  nutrition_rules: unknown;
} | null;

function phaseContext(phases: any[] | null, today: string): ActivePhaseContext {
  if (!phases) return null;
  const active = phases.find((p) => p.status === 'active');
  if (!active) return null;
  const daysBetween = (a: string | null, b: string) => {
    if (!a) return null;
    const A = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
    const B = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
    return Math.round((B - A) / 86400000);
  };
  const elapsed = daysBetween(active.starts_on, today);
  const remaining = daysBetween(today, active.target_ends_on);
  return {
    id: active.id,
    code: active.code,
    name: active.name,
    starts_on: active.starts_on,
    target_ends_on: active.target_ends_on,
    days_elapsed: elapsed != null && elapsed >= 0 ? elapsed : null,
    days_remaining: remaining != null && remaining >= 0 ? remaining : null,
    weekly_targets: active.weekly_targets ?? null,
    nutrition_rules: active.nutrition_rules ?? null,
  };
}

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

  const brief = (profile?.brief ?? null) as TrainerBrief | null;
  const scorecard = buildWeekScorecard({
    today,
    activities: (activities ?? []).map((a: any) => ({ date: a.date, type: a.type, status: a.status })),
    plans: (plans ?? []).map((p: any) => ({ date: p.date, type: p.type, status: p.status })),
  });

  return {
    today,
    // Goals are surfaced as first-class fields so the coach can anchor on them
    // without having to parse `brief`.
    goals: brief?.north_star ?? null,
    limitations: brief?.limitations ?? [],
    style_rules: brief?.style_rules ?? [],
    brief,
    program_config: program?.config ?? null,
    phases: phases ?? [],
    active_phase: phaseContext(phases, today),
    exercise_prefs: prefs ?? [],
    recent_activities: activities ?? [],
    upcoming_plans: plans ?? [],
    week_scorecard: scorecard,
    calendar_intent: events ?? [],
    horizon_days: horizonDays,
  };
}
