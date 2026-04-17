/**
 * POST /api/profile/goals — apply a coach-proposed goals patch.
 *
 * The coach's \`goals_suggestion.patch\` is a JSON-merge-style patch over
 * profiles.brief. This endpoint validates the shape, shallow-merges it
 * into the existing brief, and persists.
 *
 * Why explicit merge (not RFC-7396):
 *   RFC-7396 replaces arrays wholesale. That's what we want for
 *   style_rules / limitations (the coach is instructed to return the
 *   FULL replacement array), but we do it as a shallow merge at the
 *   top-level so non-touched keys (e.g. "profile", "training_age") are
 *   preserved. For \`north_star\`, we also shallow-merge sub-fields so
 *   the coach can update just "short_term" without nuking "long_term".
 *
 * Shape returned: { ok: true, brief: <new merged value> } on success.
 *                 { error: string } on validation/DB failure.
 *
 * Auth: RLS + explicit user_id check.
 */

import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { z } from 'zod';

export const runtime = 'nodejs';

const NorthStarPatch = z.object({
  short_term: z.array(z.string().max(500)).max(20).optional(),
  mid_term:   z.array(z.string().max(500)).max(20).optional(),
  long_term:  z.array(z.string().max(500)).max(20).optional(),
  end_state:  z.string().max(1000).optional(),
}).strict();

const GoalsPatch = z.object({
  north_star:  NorthStarPatch.optional(),
  limitations: z.array(z.string().max(500)).max(30).optional(),
  style_rules: z.array(z.string().max(500)).max(30).optional(),
}).strict();

const Body = z.object({
  patch: GoalsPatch,
  // Optional bookkeeping — we link the goals change back to the chat proposal
  // that surfaced it so we can audit "why did this goal change?" later.
  source_proposal_id: z.string().uuid().optional(),
});

export async function POST(req: Request) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  let json: unknown;
  try { json = await req.json(); }
  catch { return NextResponse.json({ error: 'Request body was not valid JSON' }, { status: 400 }); }

  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? 'Invalid goals patch', field: first?.path?.join('.') },
      { status: 400 },
    );
  }
  const { patch } = parsed.data;

  const { data: prof, error: fetchErr } = await sb.from('profiles')
    .select('brief')
    .eq('user_id', user.id)
    .maybeSingle();
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });

  const prev = (prof?.brief ?? {}) as Record<string, unknown>;
  const prevNorthStar = (prev.north_star ?? {}) as Record<string, unknown>;

  const merged: Record<string, unknown> = { ...prev };
  if (patch.north_star) {
    merged.north_star = { ...prevNorthStar, ...patch.north_star };
  }
  if (patch.limitations !== undefined) merged.limitations = patch.limitations;
  if (patch.style_rules !== undefined) merged.style_rules = patch.style_rules;

  // Upsert instead of update: signup doesn't auto-create a profiles row,
  // so a fresh user might have no row to update. `user_id` is the PK.
  const { error: upErr } = await sb.from('profiles')
    .upsert({ user_id: user.id, brief: merged }, { onConflict: 'user_id' });
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, brief: merged });
}
