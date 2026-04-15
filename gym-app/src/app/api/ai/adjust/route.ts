import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { buildAIContext } from '@/lib/ai/context';
import { callClaudeJSON, ADJUST_SYSTEM } from '@/lib/ai/anthropic';

export const maxDuration = 60;

const REASON_HINT: Record<string, string> = {
  too_easy: "The last prescription felt too easy. Progress load / volume within safe bounds.",
  too_hard: "The last prescription felt too hard. Reduce load / volume — preserve the shape.",
  short_time: "Constrained time today. Keep the stimulus but shorten the session.",
  swap_ex: "User wants to swap out an exercise they dislike. Use banned/liked to pick a substitute.",
  other: "Open-ended adjustment — interpret the user note.",
  surprise: "No specific preference. Pick a session that fits the phase.",
  gym: "Propose a gym session aligned with the phase's day rotation.",
  run: "Propose a run (respect phase targets — easy vs quality).",
  bike: "Propose a bike session.",
  yoga: "Propose a yoga / mobility session.",
  rest: "Propose a rest day (no activity).",
};

export async function POST(req: Request) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const mode = body.mode === 'propose' ? 'propose' : 'adjust';
  const date: string | undefined = body.date;
  const planId: string | undefined = body.plan_id;
  const reason: string = body.reason ?? 'other';
  const note: string | undefined = body.note;
  if (!date) return NextResponse.json({ error: 'date required' }, { status: 400 });

  const ctx = await buildAIContext({ userId: user.id, horizonDays: 14 });
  const { data: targetPlan } = planId
    ? await sb.from('plans').select('*').eq('id', planId).eq('user_id', user.id).maybeSingle()
    : { data: null } as any;

  const userPrompt = `Scoped ${mode} request.
Target date: ${date}
Reason: ${reason} — ${REASON_HINT[reason] ?? ''}${note ? `\nUser note: "${note}"` : ''}

Target plan (may be null):
${JSON.stringify(targetPlan, null, 2)}

Full context:
${JSON.stringify(ctx, null, 2)}

Return JSON only.`;

  let result: any;
  try {
    result = await callClaudeJSON({ system: ADJUST_SYSTEM, user: userPrompt, max_tokens: 4000 });
  } catch (e: any) {
    return NextResponse.json({ error: 'AI call failed: ' + e.message }, { status: 500 });
  }

  const diff = {
    rationale: result.rationale ?? '',
    updates: result.updates ?? [],
    creates: result.creates ?? [],
    deletes: result.deletes ?? [],
  };
  const noChanges = !diff.updates.length && !diff.creates.length && !diff.deletes.length;

  const { data: prop, error } = await sb.from('ai_proposals').insert({
    user_id: user.id,
    triggered_by: `adjust_${reason}`,
    diff,
    rationale: [
      result.headline ? `Headline: ${result.headline}` : null,
      diff.rationale ? `Why: ${diff.rationale}` : null,
    ].filter(Boolean).join('\n'),
    status: noChanges ? 'applied' : 'pending',
    applied_at: noChanges ? new Date().toISOString() : null,
  }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ proposal_id: prop.id, no_changes: noChanges });
}
