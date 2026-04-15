'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { UpdateDiffCard, CreateDiffCard, DeleteDiffCard } from '@/components/DiffCard';
import { useToast } from '@/components/ui/Toast';

type Props = {
  proposal: {
    id: string;
    status: string;
    triggered_by: string;
    rationale: string | null;
    headline: string | null;
    updates: any[];
    creates: any[];
    deletes: any[];
  };
};

export default function ProposalView({ proposal }: Props) {
  const router = useRouter();
  const { push } = useToast();
  const [busy, setBusy] = useState<'apply' | 'reject' | null>(null);

  const total = proposal.updates.length + proposal.creates.length + proposal.deletes.length;
  const isPending = proposal.status === 'pending';

  async function act(action: 'apply' | 'reject') {
    setBusy(action);
    try {
      const res = await fetch(`/api/proposals/${proposal.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error(await res.text());
      push({
        kind: action === 'apply' ? 'success' : 'info',
        title: action === 'apply' ? 'Applied' : 'Dismissed',
        description: action === 'apply' ? 'Your plan has been updated.' : 'Nothing was changed.',
      });
      router.push('/today');
      router.refresh();
    } catch (e: any) {
      push({ kind: 'info', title: 'Failed', description: e.message });
    } finally { setBusy(null); }
  }

  return (
    <section>
      <header className="mt-2 mb-4">
        <div className="text-tiny text-muted uppercase tracking-wider mb-1">AI suggestion</div>
        <h1 className="text-2xl font-bold tracking-tight leading-snug">
          {proposal.headline || 'Proposed changes'}
        </h1>
        {proposal.rationale && (
          <p className="text-small text-muted-2 mt-2 whitespace-pre-line">
            {proposal.rationale.replace(/^Headline:\s*.*\n?/m, '')}
          </p>
        )}
      </header>

      <div className="text-tiny text-muted mb-3">
        {proposal.updates.length} modification{proposal.updates.length === 1 ? '' : 's'} ·
        {' '}{proposal.creates.length} addition{proposal.creates.length === 1 ? '' : 's'} ·
        {' '}{proposal.deletes.length} removal{proposal.deletes.length === 1 ? '' : 's'}
      </div>

      <div className="space-y-3">
        {proposal.updates.map((u, i) => <UpdateDiffCard key={'u' + i} u={u} />)}
        {proposal.creates.map((c, i) => <CreateDiffCard key={'c' + i} c={c} />)}
        {proposal.deletes.map((p, i) => <DeleteDiffCard key={'d' + i} plan={p} />)}
        {total === 0 && (
          <div className="rounded-xl bg-panel border border-border p-5 text-center text-small text-muted">
            Claude didn&apos;t suggest any changes.
          </div>
        )}
      </div>

      {isPending && total > 0 && (
        <div className="mt-5 grid grid-cols-2 gap-2 sticky bottom-20 bg-bg/80 backdrop-blur-md -mx-2 px-2 py-3 rounded-xl">
          <button
            onClick={() => act('reject')}
            disabled={!!busy}
            className="rounded-lg bg-panel-2 border border-border py-3 text-small disabled:opacity-50"
          >
            {busy === 'reject' ? '…' : 'Dismiss'}
          </button>
          <button
            onClick={() => act('apply')}
            disabled={!!busy}
            className="rounded-lg bg-accent text-black font-semibold py-3 disabled:opacity-50"
          >
            {busy === 'apply' ? '…' : `Apply ${total > 1 ? 'all' : ''}`.trim()}
          </button>
        </div>
      )}

      {!isPending && (
        <div className="mt-5 text-center text-tiny text-muted uppercase tracking-wider">
          {proposal.status}
        </div>
      )}
    </section>
  );
}
