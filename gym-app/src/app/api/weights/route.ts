/**
 * Weight tracker CRUD.
 *
 *   GET  /api/weights?days=180  → list of { measured_on, weight_kg, note, source }
 *                                 default 180-day window
 *   POST /api/weights           → upsert for (user_id, measured_on)
 *                                 body: { measured_on: 'YYYY-MM-DD', weight_kg: 72.3, note? }
 *                                 measured_on must be within [today-5y, today+1d]
 *                                 — the +1d tolerance covers timezone skew so a
 *                                 user in UTC+9 logging at 00:30 local doesn't
 *                                 trip the server's UTC "today".
 *
 * Error shape (POST):
 *   { error: "human readable", field?: "weight_kg" | "measured_on" }
 *   — the client parses a single string; no nested fieldErrors shape.
 *
 * DELETE lives at /api/weights/[id] (next to this file).
 */

import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { z } from 'zod';

export const runtime = 'nodejs';

const MAX_BACKDATE_DAYS = 1825; // 5y — matches GET cap

const PostBody = z.object({
  measured_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  weight_kg: z.number().gt(20, 'Weight must be above 20 kg').lt(400, 'Weight must be below 400 kg'),
  note: z.string().max(400).optional().nullable(),
  source: z.enum(['manual', 'strava', 'garmin', 'withings', 'apple_health', 'other']).default('manual'),
});

function firstIssue(err: z.ZodError): { message: string; field?: string } {
  const i = err.issues[0];
  if (!i) return { message: 'Invalid input' };
  const field = typeof i.path[0] === 'string' ? i.path[0] : undefined;
  return { message: i.message, field };
}

export async function GET(req: Request) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 180, 7), 1825);
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);

  const { data, error } = await sb
    .from('body_weights')
    .select('id, measured_on, weight_kg, note, source, created_at')
    .eq('user_id', user.id)
    .gte('measured_on', since)
    .order('measured_on', { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Also compute a trivial rolling 7-day average for the chart.
  const rows = data ?? [];
  const avg7: (number | null)[] = rows.map((_, i) => {
    const window = rows.slice(Math.max(0, i - 6), i + 1).map((r) => Number(r.weight_kg));
    return window.length ? +(window.reduce((a, b) => a + b, 0) / window.length).toFixed(2) : null;
  });

  return NextResponse.json({ rows, avg7 });
}

export async function POST(req: Request) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  let json;
  try { json = await req.json(); }
  catch { return NextResponse.json({ error: 'Request body was not valid JSON' }, { status: 400 }); }
  const parsed = PostBody.safeParse(json);
  if (!parsed.success) {
    const { message, field } = firstIssue(parsed.error);
    return NextResponse.json({ error: message, field }, { status: 400 });
  }
  const b = parsed.data;

  // Bound the date. Server-side "today" is UTC; allow +1d tolerance so a user
  // east of UTC logging at local-midnight doesn't trip the upper bound.
  const maxDate = new Date(Date.now() + 86400 * 1000).toISOString().slice(0, 10);
  const minDate = new Date(Date.now() - MAX_BACKDATE_DAYS * 86400 * 1000).toISOString().slice(0, 10);
  if (b.measured_on > maxDate) {
    return NextResponse.json(
      { error: "Can't log a weight in the future.", field: 'measured_on' },
      { status: 400 },
    );
  }
  if (b.measured_on < minDate) {
    return NextResponse.json(
      { error: `Date is too far in the past (max ${Math.round(MAX_BACKDATE_DAYS / 365)} years).`, field: 'measured_on' },
      { status: 400 },
    );
  }

  const { data, error } = await sb.from('body_weights').upsert(
    {
      user_id: user.id,
      measured_on: b.measured_on,
      weight_kg: b.weight_kg,
      note: b.note ?? null,
      source: b.source,
    },
    { onConflict: 'user_id,measured_on' },
  ).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, row: data });
}
