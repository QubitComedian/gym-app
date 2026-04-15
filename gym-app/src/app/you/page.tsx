import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { exName } from '@/components/PrescriptionView';
import YouClient from './YouClient';

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
  ] = await Promise.all([
    sb.from('phases').select('*').eq('user_id', user.id).eq('status', 'active').maybeSingle(),
    sb.from('phases').select('id,code,name,status,target_ends_on,ordinal').eq('user_id', user.id).order('ordinal'),
    sb.from('google_tokens').select('expires_at,scope').eq('user_id', user.id).maybeSingle(),
    sb.from('calendar_events').select('*', { count: 'exact', head: true }).eq('user_id', user.id),
    sb.from('calendar_links').select('*', { count: 'exact', head: true }).eq('user_id', user.id),
    sb.from('calendar_events').select('prescription,phase_id').eq('user_id', user.id),
    sb.from('exercise_prefs').select('*').eq('user_id', user.id),
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

  return (
    <YouClient
      user={{ email: user.email ?? '', id: user.id }}
      activePhase={activePhase ?? null}
      phases={phases ?? []}
      google={{ connected: !!tok, expiresAt: tok?.expires_at ?? null, eventCount: eventCount ?? 0, linkCount: linkCount ?? 0 }}
      exercises={exercises}
    />
  );
}
