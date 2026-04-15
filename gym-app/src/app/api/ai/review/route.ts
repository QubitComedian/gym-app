import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { buildAIContext } from '@/lib/ai/context';
import { callClaudeJSON, REVIEW_SYSTEM } from '@/lib/ai/anthropic';

export const maxDuration = 60;

export async function POST(req: Request) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 });

  const { activity_id } = await req.json();
  if (!activity_id) return NextResponse.json({ error: 'activity_id required' }, { status: 400 });

  const { data: activity } = await sb.from('activities').select('*').eq('user_id', user.id).eq('id', activity_id).maybeSingle();
  if (!activity) return NextResponse.json({ error: 'activity not found' }, { status: 404 });

  const ctx = await buildAIContext({ userId: user.id });

  const userPrompt = `Just-completed activity to review:
${JSON.stringify(activity, null, 2)}

Full context:
${JSON.stringify(ctx, null, 2)}

Return JSON only.`;

  let result: any;
  try {
    result = await callClaudeJSON({ system: REVIEW_SYSTEM, user: userPrompt });
  } catch (e: any) {
    return NextResponse.json({ error: 'AI call failed: ' + e.message }, { status: 500 });
  }

  const diff = result.diff ?? { rationale: 'no change', updates: [], creates: [], deletes: [] };
  const noChanges = (!diff.updates?.length && !diff.creates?.length && !diff.deletes?.length);

  // Always store the review (even no-change) so user sees Claude's read.
  const { data: prop, error } = await sb.from('ai_proposals').insert({
    user_id: user.id,
    triggered_by: 'review',
    source_activity_id: activity_id,
    diff,
    rationale: [
      result.summary ? `Summary: ${result.summary}` : null,
      result.wins?.length ? `Wins: ${result.wins.join(' · ')}` : null,
      result.concerns?.length ? `Concerns: ${result.concerns.join(' · ')}` : null,
      diff.rationale ? `Plan: ${diff.rationale}` : null,
    ].filter(Boolean).join('\n'),
    status: noChanges ? 'applied' : 'pending',
    applied_at: noChanges ? new Date().toISOString() : null,
  }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ proposal_id: prop.id, no_changes: noChanges });
}
