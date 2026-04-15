'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function ProposalActions({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<'apply' | 'reject' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function call(action: 'apply' | 'reject') {
    setBusy(action); setErr(null);
    try {
      const res = await fetch(`/api/proposals/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error(await res.text());
      router.refresh();
    } catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  }

  return (
    <div>
      <div className="grid grid-cols-2 gap-2">
        <button onClick={() => call('reject')} disabled={!!busy} className="rounded-lg bg-panel-2 border border-border py-2 text-sm disabled:opacity-50">
          {busy === 'reject' ? '…' : 'Reject'}
        </button>
        <button onClick={() => call('apply')} disabled={!!busy} className="rounded-lg bg-accent text-black font-semibold py-2 text-sm disabled:opacity-50">
          {busy === 'apply' ? '…' : 'Apply'}
        </button>
      </div>
      {err && <p className="text-xs text-danger mt-2">{err}</p>}
    </div>
  );
}
