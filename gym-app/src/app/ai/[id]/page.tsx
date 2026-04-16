import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import ProposalView from './ProposalView';
import TemplateChangeView from './TemplateChangeView';

export const dynamic = 'force-dynamic';

export default async function ProposalPage({ params }: { params: { id: string } }) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect('/login');

  const { data: prop } = await sb.from('ai_proposals').select('*').eq('user_id', user.id).eq('id', params.id).maybeSingle();
  if (!prop) notFound();

  // Template edits have a fundamentally different diff shape (before/after
  // patterns + structured updates[]/creates[]/deletes[] objects, not id
  // lists). Render them through a dedicated view rather than forcing them
  // into the adjust-proposal renderer.
  if (prop.kind === 'template_change') {
    return (
      <main className="max-w-xl mx-auto px-4 pt-5 pb-28">
        <Link href="/today" className="text-tiny text-muted">← Today</Link>
        <TemplateChangeView
          proposal={{
            id: prop.id,
            status: prop.status,
            triggered_by: prop.triggered_by,
            created_at: prop.created_at,
            applied_at: prop.applied_at ?? null,
            rationale: prop.rationale,
            diff: prop.diff ?? {},
          }}
        />
      </main>
    );
  }

  // Hydrate "before" on updates + the target of deletes so DiffCards are useful
  const updateIds = (prop.diff?.updates ?? []).map((u: any) => u.plan_id).filter(Boolean);
  const deleteIdsRaw = prop.diff?.deletes ?? [];
  // Adjust proposals store deletes as string[] (plan ids); newer shapes may
  // stash objects. Normalize to an id list for the hydration query.
  const deleteIds = (Array.isArray(deleteIdsRaw) ? deleteIdsRaw : [])
    .map((d: unknown) => (typeof d === 'string' ? d : (d as { plan_id?: string })?.plan_id))
    .filter((x: unknown): x is string => typeof x === 'string');
  const wantedIds = Array.from(new Set([...updateIds, ...deleteIds]));

  const { data: existingPlans } = wantedIds.length
    ? await sb.from('plans').select('id,date,type,day_code,prescription,status').eq('user_id', user.id).in('id', wantedIds)
    : { data: [] } as any;
  const planById = new Map((existingPlans ?? []).map((p: any) => [p.id, p]));

  const hydratedUpdates = (prop.diff?.updates ?? []).map((u: any) => ({
    ...u,
    before: planById.get(u.plan_id) ?? null,
  }));
  const hydratedDeletes = deleteIds.map((id) => planById.get(id)).filter(Boolean);

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
