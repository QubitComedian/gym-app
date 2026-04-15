import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import ExercisesClient from './ExercisesClient';
import { exName } from '@/components/PrescriptionView';

export const dynamic = 'force-dynamic';

export default async function Exercises() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect('/login');

  const { data: events } = await sb.from('calendar_events').select('prescription,phase_id').eq('user_id', user.id);
  const { data: prefs } = await sb.from('exercise_prefs').select('*').eq('user_id', user.id);
  const { data: phases } = await sb.from('phases').select('id,code,name').eq('user_id', user.id).order('ordinal');

  const phaseMap = new Map((phases ?? []).map(p => [p.id, p]));

  // Aggregate unique exercises across all calendar events.
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

  const exercises = Array.from(exMap.values())
    .map(e => ({ ...e, phases: Array.from(e.phases).sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const prefByEx = new Map((prefs ?? []).map(p => [p.exercise_id ?? p.label, p]));

  return (
    <ExercisesClient
      exercises={exercises.map(e => ({ ...e, pref: prefByEx.get(e.id) ?? null }))}
    />
  );
}
