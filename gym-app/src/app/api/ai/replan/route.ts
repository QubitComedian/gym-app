import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { buildAIContext } from '@/lib/ai/context';
import { callClaudeJSON, REPLAN_SYSTEM } from '@/lib/ai/anthropic';

export const maxDuration = 60;

export async function POST(req: Request) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const horizonDays = Math.min(Math.max(Number(body.horizon_days) || 14, 7), 60);
  const userInstruction: string = body.instruction || '';

  const ctx = await buildAIContext({ userId: user.id, horizonDays });
  const userPrompt = `Replan request${userInstruction ? ` — user note: "${userInstruction}"` : ''}.
Horizon: ${horizonDays} days.

Full context:
${JSON.stringify(ctx, null, 2)}

Return JSON only.`;

  let result: any;
  try {
    result = await callClaudeJSON({ system: REPLAN_SYSTEM, user: userPrompt, max_tokens: 6000 });
  } catch (e: any) {
    return NextResponse.json({ error: 'AI call failed: ' + e.message }, { status: 500 });
  }

  const noChanges = (!result.updates?.length && !result.creates?.length && !result.deletes?.length);

  const { data: prop, error } = await sb.from('ai_proposals').insert({
    user_id: user.id,
    triggered_by: 'replan',
    diff: {
      rationale: result.rationale ?? '',
      updates: result.updates ?? [],
      creates: result.creates ?? [],
      deletes: result.deletes ?? [],
    },
    rationale: result.rationale ?? '',
    status: noChanges ? 'applied' : 'pending',
    applied_at: noChanges ? new Date().toISOString() : null,
  }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ proposal_id: prop.id, no_changes: noChanges });
}
