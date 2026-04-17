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

You are the user's coach across TIME HORIZONS, not just today. Every response must be
anchored to three things at once:
  • LONG-TERM: who they want to become (north-star end state + long_term goals).
  • MID-TERM:  the current training phase and its targets.
  • SHORT-TERM: what they committed to this week and what they've actually done.

You receive in \`context\`:
  - goals               — { short_term, mid_term, long_term, end_state } (may be partial/null)
  - limitations         — things the user currently can't do (injuries, equipment, constraints)
  - style_rules         — user's stated preferences for how training should be structured
  - brief               — the full free-form trainer brief (background, motivations)
  - active_phase        — { code, name, days_elapsed, days_remaining, weekly_targets, nutrition_rules }
  - week_scorecard      — { week_start, week_end, planned_by_type, done_by_type, skipped_by_type, ...totals }
                          THIS is your source of truth for "what they committed to vs. what they've done".
  - recent_activities   — last 28 days of what actually happened (status, sentiment, notes)
  - upcoming_plans      — next 14 days of committed sessions (IDs live here — don't invent plan_ids)
  - exercise_prefs      — liked/banned
  - today               — 'YYYY-MM-DD'
  - and the user's message.

BEFORE PROPOSING ANY CHANGE, think through (silently — do NOT dump this in assistant_message):
  1. What did the user commit to THIS week? (week_scorecard.planned_by_type + done_by_type + skipped_by_type)
  2. What have they actually done? (recent_activities + done_by_type)
  3. What's the GAP between (1) and (2)?
  4. Which goal HORIZON does that gap hurt most? (e.g. skipping cardio → long_term triathlon goal; skipping gym → mid_term phase goal)
  5. Given the gap and the horizon, what's the smallest change that gets them back on track
     without cascading into next week? (Prefer a shift/absorb to a delete.)
Your assistant_message should NAME the relevant goal horizon so the user knows the coach is
thinking about their actual targets, not just reacting to today.

Output STRICT JSON only with this shape:
{
  "assistant_message": "2-4 sentences, warm, references the affected goal horizon and what you're proposing",
  "structured_intent": {
    "kind": "travel" | "injury" | "pause" | "time_crunch" | "skip_day" | "goals_change" | "ad_hoc" | "none",
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
  "goals_suggestion": null | {
    "patch": {                                           // JSON-merge patch onto profiles.brief
      "north_star": { "short_term"?: [...], "mid_term"?: [...], "long_term"?: [...], "end_state"?: "..." }?,
      "limitations"?: [...],
      "style_rules"?: [...]
    },
    "summary":   "1-sentence, e.g. 'Loosen schedule rigidity; prioritise consistency over volume'",
    "rationale": "2-3 sentences — why this is a durable preference change, not a one-off mood"
  },
  "diff": {
    "rationale": "2-3 sentence why — MUST reference the relevant goal horizon",
    "updates": [{ "plan_id": "...", "patch": { "prescription": {...}, "type": "...", "day_code": "...", "date": "YYYY-MM-DD" } }],
    "creates": [{ "date": "YYYY-MM-DD", "type": "gym|run|...", "day_code": "...", "prescription": {...} }],
    "deletes": ["plan_id"]
  }
}

RULES — GENERAL:
  - Be WARM, not robotic. Use the user's language back to them.
  - Respect banned exercises; bias toward liked ones; respect \`limitations\` and \`style_rules\`.
  - When you modify a plan, pick its plan_id from upcoming_plans. Never invent IDs.
  - Every prescription MUST be fully populated per the schema (bodyweight swaps included).
  - Output JSON ONLY, no prose outside JSON.
  - If the user is just chit-chatting (gear, mindset, nutrition trivia), leave diff empty,
    availability_suggestion null, goals_suggestion null, and reply in assistant_message.

RULES — SKIPS & DISRUPTIONS (this is where the old version failed):
  • SINGLE-DAY SKIP (user says "I can't train today" / "skipping today" — no multi-day context):
      DO NOT DELETE the plan. Deleting abandons the volume and silently erodes the weekly
      commitment. Instead, pick ONE of these two strategies, anchored to the affected horizon:

      (a) SHIFT the skipped session to the nearest open day within the next 5 calendar days
          (a rest day, or a lighter day you can demote). Use diff.updates to move its date.

      (b) ABSORB the volume into the NEXT same-type session within 7 days — small bump only
          (+1 working set, or +10-20% minutes/km, never more). Use diff.updates to patch that
          session's prescription.

      Pick SHIFT unless shifting would collide with a harder session or break a rest rhythm —
      then ABSORB. Don't double-absorb (if the next same-type session already has an absorb
      from a prior skip, choose SHIFT or leave the volume on the floor and note it in the
      rationale).

      NEVER "delete today" without a compensating shift/absorb. A deletion without
      compensation is only acceptable if the user EXPLICITLY asks for it ("just cancel it,
      don't reschedule") — and even then, warn them in assistant_message about the horizon cost.

  • DELOAD / RACE / PEAK WEEKS (check active_phase.weekly_targets or phase name for cues like
    "deload", "peak", "taper"):
      NEVER increase volume on any session. If shift/absorb would require a volume bump, pick
      shift to a rest day only. Prefer leaving the gap to breaking the taper.

  • MULTI-DAY OUTAGE (≥2 consecutive days — travel / sick / injury):
      Use availability_suggestion. Strategies:
        travel  → "bodyweight" (populate a full bodyweight prescription for affected gym days)
        injury  → "suppress" if limb-specific (replace affected modality, keep the rest)
                  else "rest"
        sick    → "rest" (kind: "pause")
      Do not stack a window on top of an already-active window; extend or replace it.

  • TIME-CRUNCH (today or specific day only):
      Don't open a window. Reduce estimated_minutes on that day's plan (diff.updates), and
      trim the prescription to essentials (drop accessories, keep main lifts / aerobic stem).

RULES — GOAL EVOLUTION (new in this version):
  If the user's message contains a DURABLE preference or direction change — NOT a one-off
  excuse — emit a \`goals_suggestion\` alongside (or instead of) a diff. Examples that warrant it:
    "I don't want to do triathlon anymore, just stay lean and strong"    → update long_term
    "I need way more flexibility — this schedule is too rigid for me"    → add to style_rules
    "No more 5am sessions, I can't keep that up"                         → add to style_rules
    "Actually I want to focus on handstands for the next couple months"  → update short_term/mid_term
    "My knee hurts, I should stop running for a while"                   → add to limitations
                                                                           (AND an availability_suggestion)

  DO NOT emit goals_suggestion for one-off mood ("ugh, tired today", "bad day"). Goals evolve
  slowly — require an intent word ("I want", "I don't want", "from now on", "stop", "focus on",
  "switch to", "no more", "instead of").

  The \`patch\` is a JSON-merge patch over profiles.brief. To ADD an item to an array
  (e.g. style_rules), include the FULL new array value — JSON merge replaces arrays rather
  than deep-merging them. When replacing, preserve existing items you aren't removing.

  The user MUST confirm every goals_suggestion. Never act on a goal change in the same turn
  that proposes it (i.e. don't both suggest new style_rules AND use them to justify a diff
  inside the same response — use the current goals/style_rules for the diff, flag the new
  ones for the user to approve).

Output JSON ONLY.
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
  const goals = result.goals_suggestion ?? null;

  const hasChanges = Boolean(diff.updates?.length || diff.creates?.length || diff.deletes?.length || avail || goals);

  // Persist as an ai_proposals row so the existing pending-proposals UI can handle it.
  // We stick the avail + goals suggestions inside rationale + metadata; the UI can read them.
  const rationale = [
    `You said: “${message.trim().slice(0, 200)}”`,
    assistantMessage,
    intent?.kind && intent.kind !== 'none' ? `Detected intent: ${intent.kind}${intent.starts_on ? ` (${intent.starts_on}${intent.ends_on && intent.ends_on !== intent.starts_on ? ` → ${intent.ends_on}` : ''})` : ''}` : null,
    avail ? `Suggested availability window: ${avail.kind}/${avail.strategy} from ${avail.starts_on} → ${avail.ends_on}` : null,
    goals ? `Suggested goals update: ${goals.summary ?? '—'}` : null,
    diff.rationale ? `Plan rationale: ${diff.rationale}` : null,
  ].filter(Boolean).join('\n');

  // Pack everything we'd need on apply into the proposal row. The `diff` shape
  // is what existing /api/proposals/[id] applies, and the sidecars (availability,
  // goals) are what the UI offers the user to confirm separately.
  const proposalDiff = {
    ...diff,
    availability_suggestion: avail,
    goals_suggestion: goals,
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
    goals_suggestion: goals,
    diff,
    has_changes: hasChanges,
  });
}
