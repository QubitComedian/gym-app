import Anthropic from '@anthropic-ai/sdk';

export function getAnthropic() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  return new Anthropic({ apiKey: key });
}

export const REVIEW_SYSTEM = `You are Thibault's strength & conditioning AI co-coach.
You are looking at a SINGLE just-completed session. Read it in the context of:
  - the trainer brief (north star: lean aesthetic → triathlon → handstands → mobility)
  - the active phase (its weekly_targets, nutrition_rules, prescribed pattern)
  - recent history (last 14 days of activities)
  - the user's exercise preferences (liked / banned)
Output STRICT JSON only matching this shape:
{
  "summary": "1-2 sentence read on what happened",
  "wins": ["bullet"],
  "concerns": ["bullet"],
  "diff": {
    "rationale": "human-readable why",
    "updates": [{ "plan_id": "...", "patch": { "prescription": {...} } }],
    "creates": [{ "date": "YYYY-MM-DD", "type": "gym|run|...", "day_code": "...", "prescription": {...} }],
    "deletes": ["plan_id"]
  }
}
Rules:
  - You MAY adjust upcoming session prescriptions (next 7 days) to react to fatigue/progression.
  - You MUST NOT modify completed activities.
  - You MUST NOT change phase boundaries.
  - If no changes are warranted, return diff with empty arrays and rationale="no change".
  - Keep diffs SMALL and specific — load adjustments, swap an exercise, add/remove a set.
  - Respect banned exercises. Bias toward liked.
  - Output JSON ONLY. No prose outside JSON.`;

export const REPLAN_SYSTEM = `You are Thibault's strength & conditioning AI co-coach.
The user asked for a horizon replan. Look at:
  - trainer brief (north star)
  - current and upcoming phases (weekly_targets, nutrition_rules)
  - last 28 days of activities (what actually happened — adherence, progression)
  - existing planned plans for the next N days
  - banned/liked exercises
Output STRICT JSON only:
{
  "rationale": "human-readable why",
  "updates": [{ "plan_id": "...", "patch": { "prescription": {...}, "date": "...", "type": "..." } }],
  "creates": [{ "date": "YYYY-MM-DD", "type": "gym|run|...", "day_code": "...", "prescription": {...} }],
  "deletes": ["plan_id"]
}
Rules:
  - Do NOT modify completed activities.
  - Do NOT change phase boundaries unless explicitly asked.
  - Honor the calendar pattern as the default (push/pull/lower/upper_full + easy_run/quality_run + rest).
  - Adjust loads based on what actually happened, but stay within phase intent.
  - Output JSON ONLY.`;

export async function callClaudeJSON(opts: { system: string; user: string; max_tokens?: number }) {
  const client = getAnthropic();
  const res = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: opts.max_tokens ?? 4000,
    system: opts.system,
    messages: [{ role: 'user', content: opts.user }],
  });
  const text = res.content
    .filter(b => b.type === 'text')
    .map((b: any) => b.text).join('');
  // Best-effort: strip code fences
  const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Fallback: extract first {...} block
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Claude returned non-JSON: ' + text.slice(0, 200));
    return JSON.parse(m[0]);
  }
}
