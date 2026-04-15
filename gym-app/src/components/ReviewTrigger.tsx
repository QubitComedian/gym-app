'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from './ui/Toast';

export default function ReviewTrigger({ activityId }: { activityId: string }) {
  const router = useRouter();
  const { push } = useToast();
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    try {
      const res = await fetch('/api/ai/review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ activity_id: activityId }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'failed');
      if (j.no_changes) {
        push({ kind: 'success', title: 'Claude reviewed your session', description: 'No changes suggested. Nice work.' });
      } else {
        push({
          kind: 'suggestion',
          title: 'Claude has a suggestion',
          description: 'Review the proposed changes.',
          actionLabel: 'View →',
          onAction: () => router.push(`/ai/${j.proposal_id}`),
          ttl: 0,
        });
      }
    } catch (e: any) {
      push({ kind: 'info', title: 'Review failed', description: e.message });
    } finally { setBusy(false); }
  }

  return (
    <button
      onClick={go}
      disabled={busy}
      className="w-full rounded-lg bg-panel-2 border border-border px-4 py-3 text-small disabled:opacity-50"
    >
      {busy ? 'Claude is reading…' : 'Ask Claude to review this session'}
    </button>
  );
}
