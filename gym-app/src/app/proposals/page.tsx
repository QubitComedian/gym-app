import Link from 'next/link';
import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import ProposalActions from './ProposalActions';

export const dynamic = 'force-dynamic';

export default async function Proposals() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect('/login');

  const { data: proposals } = await sb
    .from('ai_proposals')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(20);

  return (
    <main className="max-w-xl mx-auto px-4 py-6 pb-28">
      <Link href="/today" className="text-xs text-muted">← back</Link>
      <h1 className="text-2xl font-bold tracking-tight mt-2 mb-4">AI proposals</h1>
      {!proposals?.length && <p className="text-sm text-muted">Nothing yet. Log a session and ask Claude to review it.</p>}
      <ul className="space-y-3">
        {proposals?.map(p => (
          <li key={p.id} className="rounded-xl bg-panel border border-border p-4">
            <div className="flex items-baseline justify-between mb-2">
              <div>
                <div className="text-xs uppercase tracking-wider text-muted">{p.triggered_by}</div>
                <div className="text-[10px] text-muted">{new Date(p.created_at).toLocaleString()}</div>
              </div>
              <div className={`text-[10px] uppercase ${p.status === 'pending' ? 'text-accent' : p.status === 'applied' ? 'text-ok' : 'text-muted'}`}>
                {p.status}
              </div>
            </div>
            {p.rationale && (
              <p className="text-sm whitespace-pre-line mb-3">{p.rationale}</p>
            )}
            {p.diff && (
              <details className="text-xs text-muted mb-3">
                <summary className="cursor-pointer">show diff</summary>
                <pre className="mt-2 bg-panel-2 border border-border rounded p-2 overflow-auto text-[10px]">{JSON.stringify(p.diff, null, 2)}</pre>
              </details>
            )}
            <div className="text-[11px] text-muted mb-3">
              {p.diff?.updates?.length ?? 0} updates · {p.diff?.creates?.length ?? 0} creates · {p.diff?.deletes?.length ?? 0} deletes
            </div>
            {p.status === 'pending' && <ProposalActions id={p.id} />}
          </li>
        ))}
      </ul>
    </main>
  );
}
