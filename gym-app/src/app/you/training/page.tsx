/**
 * /you/training — all training-configuration in one place.
 *
 * Groups:
 *   - Phase         (contextual read-only card; deep-dive via existing admin pages)
 *   - Weekly template (preview + edit link to /you/template)
 *   - Availability   (preview + edit link to /you/availability)
 *   - Exercises      (library with liked/banned prefs — opened on demand)
 *
 * Rationale: the previous flat /you page buried these among body metrics
 * and integrations. A user who wants to tune training should now have
 * everything within one subpage.
 */

import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import {
  UserHeader,
  PhaseSection,
  WeeklyTemplateSection,
  AvailabilitySection,
  ExercisesSection,
} from '@/components/you/sections';
import { loadTrainingData } from '../loader';

export const dynamic = 'force-dynamic';

export default async function TrainingPage() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect('/login');

  const data = await loadTrainingData(user.id);

  return (
    <main className="max-w-xl mx-auto px-4 pt-5 pb-28 space-y-5">
      <UserHeader email={user.email ?? ''} backHref="/you" title="Training" />
      <PhaseSection activePhase={data.activePhase} phases={data.phases} />
      <WeeklyTemplateSection activePhase={data.activePhase} weeklyPatterns={data.weeklyPatterns} />
      <AvailabilitySection availability={data.availability} />
      <ExercisesSection exercises={data.exercises} />
    </main>
  );
}
