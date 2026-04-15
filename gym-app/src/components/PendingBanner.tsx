import Link from 'next/link';

type P = { id: string; rationale: string | null; triggered_by: string; created_at: string };

export default function PendingBanner({ pending }: { pending: P[] }) {
  if (!pending.length) return null;
  const top = pending[0];
  const headline = top.rationale?.split('\n').find(l => l.startsWith('Headline:'))?.replace(/^Headline:\s*/, '')
               ?? top.rationale?.split('\n')[0]?.slice(0, 120)
               ?? 'Claude has a suggestion';
  return (
    <Link
      href={`/ai/${top.id}`}
      className="flex items-center gap-3 rounded-xl bg-accent-soft border border-accent/40 px-4 py-3 mb-5 animate-fade-in"
    >
      <span className="inline-block w-2 h-2 rounded-full bg-accent animate-pulse" />
      <div className="flex-1 min-w-0">
        <div className="text-tiny text-accent uppercase tracking-wider">AI suggestion{pending.length > 1 ? `s · ${pending.length}` : ''}</div>
        <div className="text-small font-medium truncate">{headline}</div>
      </div>
      <span className="text-accent text-lg">›</span>
    </Link>
  );
}
