/**
 * POST /api/templates/[phaseId]/preview
 *
 * Dry-run. Returns the TemplateDiff that *would* land if the user hit
 * Apply right now with this `after` pattern, given the current DB state.
 * No writes.
 *
 * Body:
 *   { after: WeeklyPattern }
 *
 * The editor calls this when the user clicks "Review changes". We compute
 * the diff server-side (rather than client-side) because the inputs —
 * current `before` pattern, phase rows, calendar events, plans in window,
 * user's tz — all live here and we want a single source of truth about
 * what "apply" means.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseServer } from '@/lib/supabase/server';
import { formatInTimeZone } from '@/lib/reconcile/tz';
import {
  getLegacyPattern,
  getWeeklyTemplate,
} from '@/lib/templates/loader';
import {
  buildTemplateDiff,
  templateApplyWindow,
  type ExistingPlan,
} from '@/lib/templates/diff.pure';
import type {
  CalendarEventRow,
  PhaseRow,
  WeeklyPattern,
  WeeklySlot,
} from '@/lib/reconcile/rollForward.pure';

// Slot schema — keep in sync with WeeklySlot (type + optional day_code).
const SlotSchema = z.object({
  type: z.string().min(1),
  day_code: z.string().nullable().optional(),
});

const PatternSchema = z.record(
  z.enum(['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']),
  SlotSchema
);

const Body = z.object({
  after: PatternSchema,
});

export async function POST(req: Request, { params }: { params: { phaseId: string } }) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 });

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const after = parsed.data.after as WeeklyPattern;

  // 1. Phase (+ ownership).
  const { data: phase } = await sb
    .from('phases')
    .select('id, code, starts_on, target_ends_on')
    .eq('id', params.phaseId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!phase) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // 2. Profile (timezone).
  const { data: profile } = await sb
    .from('profiles')
    .select('timezone')
    .eq('user_id', user.id)
    .maybeSingle();
  const tz = profile?.timezone || 'UTC';
  const todayIso = formatInTimeZone(new Date(), tz, 'yyyy-MM-dd');

  // 3. Current before-pattern + version.
  const [row, legacy] = await Promise.all([
    getWeeklyTemplate(sb, user.id, params.phaseId),
    getLegacyPattern(sb, user.id),
  ]);
  const before: WeeklyPattern =
    row && row.pattern && Object.keys(row.pattern).length > 0 ? row.pattern : legacy;
  const version = row?.version ?? null;

  // 4. Compute window so we can scope the plans load (and short-circuit
  //    if the phase is already over / entirely future).
  const window = templateApplyWindow({
    todayIso,
    phase: phase as PhaseRow,
  });

  // 5. Load all phases (phase-boundary double-check inside the diff
  //    engine), events (prescription binding), and plans in the window.
  const [{ data: allPhases }, { data: events }, plansResp] = await Promise.all([
    sb
      .from('phases')
      .select('id, code, starts_on, target_ends_on')
      .eq('user_id', user.id)
      .order('starts_on', { ascending: true }),
    sb
      .from('calendar_events')
      .select('id, phase_id, day_code, summary, prescription')
      .eq('user_id', user.id),
    window
      ? sb
          .from('plans')
          .select('id, date, type, day_code, status, source, prescription, calendar_event_id')
          .eq('user_id', user.id)
          .gte('date', window.start)
          .lte('date', window.end)
      : Promise.resolve({ data: [] as ExistingPlan[] }),
  ]);

  const eventsByPhaseDay = new Map<string, CalendarEventRow>();
  for (const e of (events ?? []) as CalendarEventRow[]) {
    if (!e.phase_id || !e.day_code) continue;
    eventsByPhaseDay.set(`${e.phase_id}:${e.day_code}`, e);
  }

  // Multi-version plan rows on the same date: prefer planned.
  const plansByDate = new Map<string, ExistingPlan>();
  for (const p of ((plansResp.data ?? []) as ExistingPlan[])) {
    const prior = plansByDate.get(p.date);
    if (!prior || p.status === 'planned') plansByDate.set(p.date, p);
  }

  // 6. Compute diff.
  const diff = buildTemplateDiff({
    todayIso,
    phase: phase as PhaseRow,
    allPhases: (allPhases ?? []) as PhaseRow[],
    before,
    after,
    plansByDate,
    eventsByPhaseDay,
  });

  return NextResponse.json({
    diff,
    version,
    today: todayIso,
    // Echoed so the editor knows what slots we rejected/normalized.
    // (We don't rewrite — `after` was already zod-validated — but the
    // client likes confirming the echoed shape matches.)
    after_echo: after satisfies Record<string, WeeklySlot>,
  });
}
