import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { exName } from '@/components/PrescriptionView';
import { getAllWeeklyPatternsForUser } from '@/lib/templates/loader';
import { formatInTimeZone } from '@/lib/reconcile/tz';
import YouClient from './YouClient';
import type {
  AvailabilityWindowKind,
  AvailabilityWindowStrategy,
} from '@/lib/reconcile/rollForward.pure';

export const dynamic = 'force-dynamic';

export default async function You() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect('/login');

  const [
    { data: activePhase },
    { data: phases },
    { data: tok },
    { count: eventCount },
    { count: linkCount },
    { data: events },
    { data: prefs },
    patternByPhase,
    { data: profile },
    { data: rawWindows },
  ] = await Promise.all([
    sb.from('phases').select('*').eq('user_id', user.id).eq('status', 'active').maybeSingle(),
    sb.from('phases').select('id,code,name,status,target_ends_on,ordinal').eq('user_id', user.id).order('ordinal'),
    sb.from('google_tokens').select('expires_at,scope').eq('user_id', user.id).maybeSingle(),
    sb.from('calendar_events').select('*', { count: 'exact', head: true }).eq('user_id', user.id),
    sb.from('calendar_links').select('*', { count: 'exact', head: true }).eq('user_id', user.id),
    sb.from('calendar_events').select('prescription,phase_id').eq('user_id', user.id),
    sb.from('exercise_prefs').select('*').eq('user_id', user.id),
    getAllWeeklyPatternsForUser(sb, user.id),
    sb.from('profiles').select('timezone').eq('user_id', user.id).maybeSingle(),
    // Active windows only — the /you card foregrounds what's happening
    // now and what's queued. Past/cancelled live on /you/availability.
    sb.from('availability_windows')
      .select('id, starts_on, ends_on, kind, strategy')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .order('starts_on', { ascending: true }),
  ]);

  const phaseMap = new Map((phases ?? []).map(p => [p.id, p]));

  // Aggregate unique exercises from all calendar events
  const exMap = new Map<string, { id: string; name: string; phases: Set<string> }>();
  (events ?? []).forEach(e => {
    const phaseCode = phaseMap.get(e.phase_id)?.code ?? '';
    for (const b of e.prescription?.blocks ?? []) {
      if (b.kind === 'single') {
        if (!exMap.has(b.exercise_id)) exMap.set(b.exercise_id, { id: b.exercise_id, name: exName(b.exercise_id), phases: new Set() });
        if (phaseCode) exMap.get(b.exercise_id)!.phases.add(phaseCode);
      } else if (b.kind === 'superset') {
        for (const it of b.items) {
          if (!exMap.has(it.exercise_id)) exMap.set(it.exercise_id, { id: it.exercise_id, name: exName(it.exercise_id), phases: new Set() });
          if (phaseCode) exMap.get(it.exercise_id)!.phases.add(phaseCode);
        }
      }
    }
  });
  const prefByEx = new Map((prefs ?? []).map(p => [p.exercise_id ?? p.label, p]));
  const exercises = Array.from(exMap.values())
    .map(e => ({ id: e.id, name: e.name, phases: Array.from(e.phases).sort(), pref: prefByEx.get(e.id) ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Flatten per-phase weekly pattern Map for the client component.
  const weeklyPatterns = Array.from(patternByPhase.entries()).map(([phase_id, pattern]) => ({
    phase_id,
    pattern,
  }));

  // Availability summary for the /you entry card. Active today vs
  // upcoming lets the card render either a live chip or a "queued"
  // label without re-fetching in the client.
  const tz = (profile?.timezone as string | null) || 'UTC';
  const todayIso = formatInTimeZone(new Date(), tz, 'yyyy-MM-dd');
  const windowsAll = (rawWindows ?? []) as Array<{
    id: string;
    starts_on: string;
    ends_on: string;
    kind: AvailabilityWindowKind;
    strategy: AvailabilityWindowStrategy;
  }>;
  const activeNow = windowsAll.find(w => w.starts_on <= todayIso && w.ends_on >= todayIso) ?? null;
  const upcomingCount = windowsAll.filter(w => w.starts_on > todayIso).length;
  const availability = {
    todayIso,
    activeNow,
    upcomingCount,
    totalActive: windowsAll.length,
  };

  return (
    <YouClient
      user={{ email: user.email ?? '', id: user.id }}
      activePhase={activePhase ?? null}
      phases={phases ?? []}
      google={{ connected: !!tok, expiresAt: tok?.expires_at ?? null, eventCount: eventCount ?? 0, linkCount: linkCount ?? 0 }}
      exercises={exercises}
      weeklyPatterns={weeklyPatterns}
      availability={availability}
    />
  );
}
