/**
 * Availability windows — collection endpoint.
 *
 *   GET  /api/availability      → list all windows (active + cancelled)
 *   POST /api/availability      → create a window (applied at creation)
 *
 * POST body:
 *   {
 *     starts_on: 'yyyy-MM-dd',
 *     ends_on: 'yyyy-MM-dd',
 *     kind: 'travel' | 'injury' | 'pause',
 *     strategy?: 'auto' | 'bodyweight' | 'rest' | 'suppress',
 *     note?: string | null,
 *     metadata?: object
 *   }
 *
 * Response codes:
 *   200 — created (returns window_id, proposal_id, diff, counts)
 *   400 — invalid input (malformed dates, unknown kind/strategy, ends < starts)
 *   401 — unauthenticated
 *   409 — overlaps an existing active window (conflicts list in body)
 *   500 — DB write or audit failure
 *
 * The window row + plan ops + audit proposal are all written in a single
 * handler call. If the audit insert fails AFTER plan writes, we still
 * return the conflict in the reason so the UI can surface it, but the
 * plan state is correctly up to date.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseServer } from '@/lib/supabase/server';
import { applyCreateWindow } from '@/lib/availability/apply';

const CreateBody = z.object({
  starts_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'yyyy-MM-dd expected'),
  ends_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'yyyy-MM-dd expected'),
  kind: z.enum(['travel', 'injury', 'pause']),
  strategy: z.enum(['auto', 'bodyweight', 'rest', 'suppress']).optional(),
  note: z.string().max(500).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export async function GET() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 });

  // Two ordering keys:
  //   - status first so active rows float to the top regardless of date
  //   - then starts_on ascending for chronological reading within a group
  const { data, error } = await sb
    .from('availability_windows')
    .select('id, starts_on, ends_on, kind, strategy, note, metadata, status, created_at, cancelled_at')
    .eq('user_id', user.id)
    .order('status', { ascending: true }) // 'active' sorts before 'cancelled' lexicographically
    .order('starts_on', { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ windows: data ?? [] });
}

export async function POST(req: Request) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 });

  const parsed = CreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_input', detail: parsed.error.message },
      { status: 400 }
    );
  }

  const result = await applyCreateWindow({
    sb,
    userId: user.id,
    input: parsed.data,
  });

  if (!result.ok) {
    const status =
      result.reason === 'overlaps_existing' ? 409
      : result.reason === 'invalid_input'   ? 400
      : result.reason === 'window_not_found' || result.reason === 'window_not_active' ? 404
      : 500;
    return NextResponse.json(result, { status });
  }

  return NextResponse.json(result);
}
