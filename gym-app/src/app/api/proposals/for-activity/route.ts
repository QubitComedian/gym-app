import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';

/**
 * Lightweight lookup used by the session-recap polling client.
 * Returns the most recent proposal (pending OR applied) sourced from a given
 * activity, or null if the auto-review is still running / never ran.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const activityId = url.searchParams.get('activity_id');
  if (!activityId) return NextResponse.json({ proposal: null });

  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ proposal: null });

  const { data } = await sb.from('ai_proposals')
    .select('id,status,rationale,diff,created_at')
    .eq('user_id', user.id)
    .eq('source_activity_id', activityId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({ proposal: data ?? null });
}
