/**
 * Availability windows — per-window endpoints.
 *
 *   GET    /api/availability/[id]   → single window (with its audit tail)
 *   PATCH  /api/availability/[id]   → modify (range / strategy / note)
 *   DELETE /api/availability/[id]   → cancel (soft: status='cancelled')
 *
 * PATCH body (all fields optional; at least one must be present):
 *   {
 *     starts_on?: 'yyyy-MM-dd',
 *     ends_on?:   'yyyy-MM-dd',
 *     strategy?:  'auto' | 'bodyweight' | 'rest' | 'suppress',
 *     note?:      string | null,
 *     metadata?:  object
 *   }
 *
 * DELETE body: none (the window id is in the URL).
 *
 * Kind is IMMUTABLE — to change a window from travel to injury the caller
 * must DELETE the old one and POST a fresh one. Enforced both in the
 * pure diff engine and (by omission) in the Zod schema here.
 *
 * Response codes:
 *   200 — success (diff, counts, proposal_id)
 *   400 — invalid input
 *   401 — unauthenticated
 *   404 — window not found (or doesn't belong to caller)
 *   409 — modify overlaps another active window, or window is not active
 *         (already cancelled — the UI should refresh)
 *   500 — DB write or audit failure
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseServer } from '@/lib/supabase/server';
import {
  applyCancelWindow,
  applyModifyWindow,
} from '@/lib/availability/apply';

const PatchBody = z.object({
  starts_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'yyyy-MM-dd expected').optional(),
  ends_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'yyyy-MM-dd expected').optional(),
  strategy: z.enum(['auto', 'bodyweight', 'rest', 'suppress']).optional(),
  note: z.string().max(500).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
}).refine(
  (v) =>
    v.starts_on !== undefined ||
    v.ends_on !== undefined ||
    v.strategy !== undefined ||
    v.note !== undefined ||
    v.metadata !== undefined,
  { message: 'at least one field required' }
);

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 });

  const { data: window, error } = await sb
    .from('availability_windows')
    .select('id, starts_on, ends_on, kind, strategy, note, metadata, status, created_at, cancelled_at')
    .eq('id', params.id)
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!window) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Load the audit tail — every availability_change proposal that
  // touched this window, oldest first. The UI renders this as a history
  // timeline with rollback buttons on the most recent applied entry.
  //
  // We match on `diff->>'window_id'`. For rollbacks-of-cancels the new
  // row has a fresh window id, so the UI walks `diff->>'rollback_of'`
  // to connect the dots.
  const { data: audits } = await sb
    .from('ai_proposals')
    .select('id, status, applied_at, created_at, triggered_by, rationale, diff')
    .eq('user_id', user.id)
    .eq('kind', 'availability_change')
    .filter('diff->>window_id', 'eq', params.id)
    .order('created_at', { ascending: true });

  return NextResponse.json({ window, audits: audits ?? [] });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 });

  const raw = await req.json().catch(() => ({}));
  // Explicit reject on `kind` so a confused client gets a clear error
  // instead of a silently-stripped field. Zod's default stripping would
  // make this look like it "worked" from the client's perspective.
  if (raw && typeof raw === 'object' && 'kind' in raw) {
    return NextResponse.json(
      {
        error: 'invalid_input',
        detail: 'kind is immutable — cancel this window and create a new one to change kind',
      },
      { status: 400 }
    );
  }
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_input', detail: parsed.error.message },
      { status: 400 }
    );
  }

  const result = await applyModifyWindow({
    sb,
    userId: user.id,
    windowId: params.id,
    patch: parsed.data,
  });

  if (!result.ok) {
    const status =
      result.reason === 'window_not_found'     ? 404
      : result.reason === 'window_not_active'  ? 409
      : result.reason === 'overlaps_existing'  ? 409
      : result.reason === 'invalid_input'      ? 400
      : 500;
    return NextResponse.json(result, { status });
  }

  return NextResponse.json(result);
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 });

  const result = await applyCancelWindow({
    sb,
    userId: user.id,
    windowId: params.id,
  });

  if (!result.ok) {
    const status =
      result.reason === 'window_not_found'    ? 404
      : result.reason === 'window_not_active' ? 409
      : 500;
    return NextResponse.json(result, { status });
  }

  return NextResponse.json(result);
}
