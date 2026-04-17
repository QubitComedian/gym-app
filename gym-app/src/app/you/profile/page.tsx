/**
 * /you/profile — identity + body metrics.
 *
 * Scope: email, weight tracker. Sign-out lives on the hub so a user can
 * always reach it from any sub-page's "← You" link.
 *
 * We infer the weight tracker's phase intent (cut/bulk/maintain) from the
 * active phase code so the delta chip is coloured correctly — same data
 * the hub reads, fetched once here.
 */

import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import WeightTracker from '@/components/WeightTracker';
import { UserHeader, inferPhaseIntent, type Phase } from '@/components/you/sections';

export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect('/login');

  const { data: activePhase } = await sb
    .from('phases')
    .select('id,code,name,status,target_ends_on,ordinal')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .maybeSingle();

  return (
    <main className="max-w-xl mx-auto px-4 pt-5 pb-28 space-y-5">
      <UserHeader email={user.email ?? ''} backHref="/you" title="Profile" />
      <WeightTracker phaseIntent={inferPhaseIntent((activePhase as Phase) ?? null)} />
    </main>
  );
}
