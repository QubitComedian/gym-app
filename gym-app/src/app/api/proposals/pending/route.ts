import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';

/** Lightweight listing of pending AI proposals — used by the client toast poller. */
export async function GET() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ proposals: [] });

  const { data } = await sb.from('ai_proposals')
    .select('id,rationale,triggered_by,created_at,diff')
    .eq('user_id', user.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(10);

  const proposals = (data ?? []).map(p => ({
    id: p.id,
    triggered_by: p.triggered_by,
    created_at: p.created_at,
    headline: p.rationale?.split('\n').find((l: string) => l.startsWith('Headline:'))?.replace(/^Headline:\s*/, '')
           ?? p.rationale?.split('\n')[0]?.slice(0, 140)
           ?? null,
    rationale: p.rationale,
    counts: {
      updates: p.diff?.updates?.length ?? 0,
      creates: p.diff?.creates?.length ?? 0,
      deletes: p.diff?.deletes?.length ?? 0,
    },
  }));

  return NextResponse.json({ proposals });
}
