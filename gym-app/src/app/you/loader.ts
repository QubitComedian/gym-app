/**
 * Shared data loaders for /you and its sub-routes.
 *
 * Every sub-route needs a coherent subset of the same underlying tables
 * (profiles, phases, exercises, calendar_events, availability_windows,
 * google_tokens). Keeping the queries here lets each page fetch only
 * what it needs without copy-pasting Supabase calls.
 *
 * These helpers run on the server (supabaseServer() uses cookies).
 */

import { supabaseServer } from '@/lib/supabase/server';
import { exName } from '@/components/PrescriptionView';
import { getAllWeeklyPatternsForUser } from '@/lib/templates/loader';
import { formatInTimeZone } from '@/lib/reconcile/tz';
import type {
  AvailabilityWindowKind,
  AvailabilityWindowStrategy,
} from '@/lib/reconcile/rollForward.pure';
import type {
  Phase,
  Exercise,
  AvailabilitySummary,
  PhasePattern,
  GoogleStatus,
} from '@/components/you/sections';

export type TrainingData = {
  activePhase: Phase | null;
  phases: Phase[];
  exercises: Exercise[];
  weeklyPatterns: PhasePattern[];
  availability: AvailabilitySummary;
};

export async function loadTrainingData(userId: string): Promise<TrainingData> {
  const sb = supabaseServer();

  const [
    { data: activePhase },
    { data: phases },
    { data: events },
    { data: prefs },
    patternByPhase,
    { data: profile },
    { data: rawWindows },
  ] = await Promise.all([
    sb.from('phases').select('*').eq('user_id', userId).eq('status', 'active').maybeSingle(),
    sb.from('phases').select('id,code,name,status,target_ends_on,ordinal').eq('user_id', userId).order('ordinal'),
    sb.from('calendar_events').select('prescription,phase_id').eq('user_id', userId),
    sb.from('exercise_prefs').select('*').eq('user_id', userId),
    getAllWeeklyPatternsForUser(sb, userId),
    sb.from('profiles').select('timezone').eq('user_id', userId).maybeSingle(),
    sb.from('availability_windows')
      .select('id, starts_on, ends_on, kind, strategy')
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('starts_on', { ascending: true }),
  ]);

  const phasesList = (phases ?? []) as Phase[];
  const phaseMap = new Map(phasesList.map(p => [p.id, p]));

  // Aggregate unique exercises from all calendar events.
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
  const exercises: Exercise[] = Array.from(exMap.values())
    .map(e => ({ id: e.id, name: e.name, phases: Array.from(e.phases).sort(), pref: prefByEx.get(e.id) ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const weeklyPatterns: PhasePattern[] = Array.from(patternByPhase.entries()).map(([phase_id, pattern]) => ({
    phase_id,
    pattern,
  }));

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

  return {
    activePhase: (activePhase as Phase) ?? null,
    phases: phasesList,
    exercises,
    weeklyPatterns,
    availability: {
      todayIso,
      activeNow,
      upcomingCount,
      totalActive: windowsAll.length,
    },
  };
}

export async function loadGoogleStatus(userId: string): Promise<GoogleStatus> {
  const sb = supabaseServer();
  const [{ data: tok }, { count: eventCount }, { count: linkCount }] = await Promise.all([
    sb.from('google_tokens').select('expires_at,scope').eq('user_id', userId).maybeSingle(),
    sb.from('calendar_events').select('*', { count: 'exact', head: true }).eq('user_id', userId),
    sb.from('calendar_links').select('*', { count: 'exact', head: true }).eq('user_id', userId),
  ]);
  return {
    connected: !!tok,
    expiresAt: tok?.expires_at ?? null,
    eventCount: eventCount ?? 0,
    linkCount: linkCount ?? 0,
  };
}

/**
 * Lightweight summary used by the /you hub to preview each category.
 */
export type HubSummary = {
  activePhaseCode: string | null;
  activePhaseName: string | null;
  integrationsConnected: number;    // count of providers connected (Strava, Google)
  availabilityActive: boolean;
  availabilityUpcoming: number;
};

export async function loadHubSummary(userId: string): Promise<HubSummary> {
  const sb = supabaseServer();
  const [
    { data: active },
    { data: tok },
    { data: strava },
    { data: rawWindows },
    { data: profile },
  ] = await Promise.all([
    sb.from('phases').select('code,name').eq('user_id', userId).eq('status', 'active').maybeSingle(),
    sb.from('google_tokens').select('user_id').eq('user_id', userId).maybeSingle(),
    // Strava is stored in integration_accounts (see /components/IntegrationCards).
    // We only need to know whether a row exists in active state.
    sb.from('integration_accounts').select('provider,status').eq('user_id', userId).eq('provider', 'strava').maybeSingle(),
    sb.from('availability_windows')
      .select('starts_on, ends_on, status')
      .eq('user_id', userId)
      .eq('status', 'active'),
    sb.from('profiles').select('timezone').eq('user_id', userId).maybeSingle(),
  ]);

  const tz = (profile?.timezone as string | null) || 'UTC';
  const todayIso = formatInTimeZone(new Date(), tz, 'yyyy-MM-dd');
  const windows = (rawWindows ?? []) as Array<{ starts_on: string; ends_on: string; status: string }>;
  const availabilityActive = windows.some(w => w.starts_on <= todayIso && w.ends_on >= todayIso);
  const availabilityUpcoming = windows.filter(w => w.starts_on > todayIso).length;

  let integrationsConnected = 0;
  if (tok) integrationsConnected++;
  if (strava && strava.status === 'active') integrationsConnected++;

  return {
    activePhaseCode: active?.code ?? null,
    activePhaseName: active?.name ?? null,
    integrationsConnected,
    availabilityActive,
    availabilityUpcoming,
  };
}
