'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function ReviewButton({ activityId }: { activityId: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();
  return (
    <>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true); setErr(null);
          try {
            const res = await fetch('/api/ai/review', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ activity_id: activityId }),
            });
            if (!res.ok) throw new Error(await res.text());
            router.push('/proposals');
          } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
        }}
        className="w-full rounded-lg bg-accent text-black font-semibold py-3 disabled:opacity-50"
      >
        {busy ? 'Asking Claude…' : 'Ask Claude to review this session'}
      </button>
      {err && <p className="text-xs text-danger mt-2">{err}</p>}
    </>
  );
}
