/**
 * GET /api/templates/[phaseId]
 *
 * Returns the current weekly template for a phase, plus the scaffolding
 * the editor UI needs to render options:
 *
 *   - pattern + version (null version → no row yet, falling back to legacy)
 *   - phase snapshot (code, bounds) for the editor header
 *   - available day_codes sourced from this phase's `calendar_events`
 *     (so the day_code dropdown only shows templates that actually exist)
 *
 * The version is load-bearing: the client must send it back on apply for
 * optimistic-concurrency CAS. When the template row doesn't exist yet we
 * return `version: null` and the apply path will INSERT (first edit).
 */

import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import {
  getLegacyPattern,
  getWeeklyTemplate,
} from '@/lib/templates/loader';

export async function GET(_req: Request, { params }: { params: { phaseId: string } }) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 });

  // Phase — also the ownership check. A missing row means either the
  // phase doesn't exist or it isn't ours; either way, 404.
  const { data: phase, error: phErr } = await sb
    .from('phases')
    .select('id, code, starts_on, target_ends_on')
    .eq('id', params.phaseId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (phErr) return NextResponse.json({ error: phErr.message }, { status: 500 });
  if (!phase) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Template row + legacy fallback + calendar events, in parallel.
  const [row, legacy, events] = await Promise.all([
    getWeeklyTemplate(sb, user.id, params.phaseId),
    getLegacyPattern(sb, user.id),
    sb
      .from('calendar_events')
      .select('id, day_code, summary, prescription')
      .eq('user_id', user.id)
      .eq('phase_id', params.phaseId),
  ]);

  const pattern =
    row && row.pattern && Object.keys(row.pattern).length > 0 ? row.pattern : legacy;
  const version = row?.version ?? null;

  const dayCodes = ((events.data ?? []) as Array<{ id: string; day_code: string | null; summary: string | null }>).
    filter((e) => !!e.day_code)
    .map((e) => ({ day_code: e.day_code as string, summary: e.summary ?? null, id: e.id }));

  return NextResponse.json({
    phase,
    pattern,
    version,
    day_codes: dayCodes,
    is_legacy_fallback: row === null || Object.keys(row.pattern ?? {}).length === 0,
  });
}
