/**
 * POST /api/ai/chat
 *
 * Free-form natural-language endpoint for the Today page chatbox.
 *
 * Users say things like:
 *   • "I can't train today, slept badly"
 *   • "I'm travelling next 7 days with no gym"
 *   • "I have a minor knee thing, no running for 4 days"
 *   • "I'm sick and won't exercise for 3 days"
 *   • "Work dumpster fire until Monday, keep it light all week"
 *
 * The endpoint:
 *   1. Calls Claude to interpret intent → produce an availability_windows
 *      insert + an optional plan diff (updates/creates/deletes) that reflects
 *      the disruption (e.g. turn all gym days into bodyweight, delete specific
 *      plans, shift the long run).
 *   2. Stores the plan diff as an ai_proposals row (status='pending') so the
 *      existing Today UI can show it for approval.
 *   3. If an availability_windows insert is suggested, we stage it as part of
 *      the proposal (NOT applied immediately) — the user must confirm. This
 *      mirrors how the existing `/api/ai/adjust` and `/api/ai/replan` flows
 *      stay reversible.
 *
 * Request: { message: string, timezone?: string }
 * Response:
 *   { proposal_id, assistant_message, diff, availability_suggestion, structured_intent }
 */

import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { buildAIContext } from '@/lib/ai/context';
import { callClaudeJSON, PRESCRIPTION_SCHEMA_DOC } from '@/lib/ai/anthropic';
import { z } from 'zod';

export const maxDuration = 60;
export const runtime = 'nodejs';

const Body = z.object({
  message: z.string().min(1).max(2000),
  timezone: z.string().max(100).optional(),
});

const CHAT_SYSTEM = `You are Thibault's strength & conditioning AI co-coach.
The user speaks to you in everyday language on their Today page — NOT a structured form.
Your job: understand the situation (sick, travelling, tired, short on time, equipment changed)
and produce a SMALL, REVERSIBLE adjustment to their upcoming plan that keeps them on track
toward their long-term goals (lean aesthetic → triathlon → handstands → mobility).

You receive:
  - trainer brief (north star) + active phase (weekly_targets, nutrition_rules)
  - recent activity history (last 28 days)
  - upcoming plans (next 14 days)
  - banned/liked exercises
  - today's date (string)
  - the user's message

Output STRICT JSON only with this shape:
{
  "assistant_message": "1-3 sentence friendly reply, acknowledge what they said, explain what you're proposing",
  "structured_intent": {
    "kind": "travel" | "injury" | "pause" | "time_crunch" | "ad_hoc" | "none",
    "starts_on": "YYYY-MM-DD" | null,
    "ends_on":   "YYYY-MM-DD" | null,
    "notes": "short"
  },
  "availability_suggestion": null | {
    "kind": "travel"|"injury"|"pause",
    "starts_on": "YYYY-MM-DD",
    "ends_on":   "YYYY-MM-DD",
    "strategy":  "auto" | "bodyweight" | "rest" | "suppress",
    "reason":    "short human-readable"
  },
  "diff": {
    "rationale": "2-3 sentence why",
    "updates": [{ "plan_id": "...", "patch": { "prescription": {...}, "type": "...", "day_code": "..." } }],
    "creates": [{ "date": "YYYY-MM-DD", "type": "gym|run|...", "day_code": "...", "prescription": {...} }],
    "deletes": ["plan_id"]
  }
}

RULES:
  - Be WARM, not robotic. Use the user's language back to them.
  - If the user describes time off (travel/sick/injured), ALWAYS propose an availability_suggestion.
    Strategies:
      travel  → "bodyweight" by default (swap gym sessions for hotel-room bodyweight)
      injury  → "suppress" if limb-specific (replace affected modality, keep the rest), else "rest"
      sick    → "rest" (kind: "pause")
      short on time → don't create a window, just reduce upcoming prescriptions' estimated_minutes
  - Keep the diff MINIMAL — only touch dates actually affected.
  - When swapping gym → bodyweight, populate a FULL bodyweight prescription (pushups, squats,
    single-leg variants, planks) — not a stub. Every prescription must be complete per the schema.
  - When deleting a plan, pick the plan_id from upcoming_plans. Don't invent ids.
  - Respect banned exercises; bias toward liked.
  - If the user asks something off-topic (gear reviews, nutrition questions, mindset) reply in
    assistant_message and leave diff empty and availability_suggestion null.
  - If unsure about dates, assume starting TODAY. Prefer under-promising over over-promising.
  - Output JSON ONLY, no prose outside JSON.
${PRESCRIPTION_SCHEMA_DOC}`;

export async function POST(req: Request) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { message, timezone } = parsed.data;

  let ctx;
  try {
    ctx = await buildAIContext({ userId: user.id, horizonDays: 14, recentDays: 28 });
  } catch (e: any) {
    return NextResponse.json({ error: 'context_failed', detail: e?.message }, { status: 500 });
  }

  const userPrompt = `User message:
"""
${message}
"""

Timezone: ${timezone || 'UTC'}
Today: ${ctx.today}

Context:
${JSON.stringify(ctx, null, 2)}

Return JSON only.`;

  let result: any;
  try {
    result = await callClaudeJSON({ system: CHAT_SYSTEM, user: userPrompt, max_tokens: 4000 });
  } catch (e: any) {
    console.error('[ai/chat] Claude call failed', e?.message);
    return NextResponse.json({ error: 'ai_failed', detail: e?.message }, { status: 502 });
  }

  const diff = result.diff ?? { rationale: 'no change', updates: [], creates: [], deletes: [] };
  const assistantMessage = result.assistant_message ?? 'Got it.';
  const intent = result.structured_intent ?? { kind: 'none' };
  const avail = result.availability_suggestion ?? null;

  const hasChanges = Boolean(diff.updates?.length || diff.creates?.length || diff.deletes?.length || avail);

  // Persist as an ai_proposals row so the existing pending-proposals UI can handle it.
  // We stick the avail suggestion inside rationale + metadata for now; the UI can read it.
  const rationale = [
    `You said: “${message.trim().slice(0, 200)}”`,
    assistantMessage,
    intent?.kind && intent.kind !== 'none' ? `Detected intent: ${intent.kind}${intent.starts_on ? ` (${intent.starts_on}${intent.ends_on && intent.ends_on !== intent.starts_on ? ` → ${intent.ends_on}` : ''})` : ''}` : null,
    avail ? `Suggested availability window: ${avail.kind}/${avail.strategy} from ${avail.starts_on} → ${avail.ends_on}` : null,
    diff.rationale ? `Plan rationale: ${diff.rationale}` : null,
  ].filter(Boolean).join('\n');

  // Pack everything we'd need on apply into the proposal row. The `diff` shape
  // is what existing /api/proposals/[id] applies, and the `availability` blob is
  // what the new UI will offer the user to confirm separately.
  const proposalDiff = {
    ...diff,
    availability_suggestion: avail,
    structured_intent: intent,
    source: 'chat',
  };

  const { data: prop, error } = await sb.from('ai_proposals').insert({
    user_id: user.id,
    triggered_by: 'chat',
    diff: proposalDiff,
    rationale,
    status: hasChanges ? 'pending' : 'applied', // chit-chat doesn't need approval
    applied_at: hasChanges ? null : new Date().toISOString(),
  }).select('id, status').single();
  if (error) {
    console.error('[ai/chat] proposal insert failed', error);
    return NextResponse.json({ error: 'db_error', detail: error.message }, { status: 500 });
  }

  return NextResponse.json({
    proposal_id: prop.id,
    status: prop.status,
    assistant_message: assistantMessage,
    structured_intent: intent,
    availability_suggestion: avail,
    diff,
    has_changes: hasChanges,
  });
}
