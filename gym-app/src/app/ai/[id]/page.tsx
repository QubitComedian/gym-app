import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import ProposalView from './ProposalView';

export const dynamic = 'force-dynamic';

export default async function ProposalPage({ params }: { params: { id: string } }) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect('/login');

  const { data: prop } = await sb.from('ai_proposals').select('*').eq('user_id', user.id).eq('id', params.id).maybeSingle();
  if (!prop) notFound();

  // Hydrate "before" on updates + the target of deletes so DiffCards are useful
  const updateIds = (prop.diff?.updates ?? []).map((u: any) => u.plan_id).filter(Boolean);
  const deleteIds = prop.diff?.deletes ?? [];
  const wantedIds = Array.from(new Set([...updateIds, ...deleteIds]));

  const { data: existingPlans } = wantedIds.length
    ? await sb.from('plans').select('id,date,type,day_code,prescription,status').eq('user_id', user.id).in('id', wantedIds)
    : { data: [] } as any;
  const planById = new Map((existingPlans ?? []).map((p: any) => [p.id, p]));

  const hydratedUpdates = (prop.diff?.updates ?? []).map((u: any) => ({
    ...u,
    before: planById.get(u.plan_id) ?? null,
  }));
  const hydratedDeletes = (prop.diff?.deletes ?? []).map((id: string) => planById.get(id)).filter(Boolean);

  return (
    <main className="max-w-xl mx-auto px-4 pt-5 pb-28">
      <Link href="/today" className="text-tiny text-muted">← Today</Link>
      <ProposalView
        proposal={{
          id: prop.id,
          status: prop.status,
          triggered_by: prop.triggered_by,
          rationale: prop.rationale,
          headline: prop.rationale?.split('\n').find((l: string) => l.startsWith('Headline:'))?.replace(/^Headline:\s*/, '')
                 ?? (prop.diff?.rationale?.split('.')?.[0] ?? 'Claude has a suggestion'),
          updates: hydratedUpdates,
          creates: prop.diff?.creates ?? [],
          deletes: hydratedDeletes,
        }}
      />
    </main>
  );
}
