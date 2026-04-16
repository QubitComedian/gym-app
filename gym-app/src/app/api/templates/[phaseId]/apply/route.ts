/**
 * POST /api/templates/[phaseId]/apply
 *
 * Commits a reviewed TemplateDiff. Recomputes the diff server-side from
 * the user's posted `after` pattern + `expected_version`, then calls
 * applyTemplateDiff.
 *
 * We deliberately recompute the diff on apply rather than trusting the
 * client-sent diff blob — the user may have opened the editor, then a
 * background reconcile ran, then they hit Apply. The preview they saw may
 * be stale. Recomputing against live data means:
 *
 *   - The `updates[]` target the current plan row ids (not stale ones).
 *   - New activity states (done/missed since preview) are respected.
 *   - The audit row captures what actually shipped, not what was shown.
 *
 * The CAS on `weekly_templates.version` inside applyTemplateDiff still
 * catches the narrower race (someone else edited the template concurrently).
 *
 * Body:
 *   { after: WeeklyPattern, expected_version: number | null }
 *
 * Response:
 *   200 { ok: true, proposal_id, template_version, applied, skipped, diff }
 *   409 { ok: false, reason: 'version_conflict', current_version, current_pattern }
 *   500 { ok: false, reason, detail? }
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
import { applyTemplateDiff } from '@/lib/templates/apply';
import type {
  CalendarEventRow,
  PhaseRow,
  WeeklyPattern,
} from '@/lib/reconcile/rollForward.pure';

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
  expected_version: z.number().int().nullable(),
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
  const expectedVersion = parsed.data.expected_version;

  // Phase (+ ownership).
  const { data: phase } = await sb
    .from('phases')
    .select('id, code, starts_on, target_ends_on')
    .eq('id', params.phaseId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!phase) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Profile (timezone).
  const { data: profile } = await sb
    .from('profiles')
    .select('timezone')
    .eq('user_id', user.id)
    .maybeSingle();
  const tz = profile?.timezone || 'UTC';
  const todayIso = formatInTimeZone(new Date(), tz, 'yyyy-MM-dd');

  // Current before-pattern + version.
  const [row, legacy] = await Promise.all([
    getWeeklyTemplate(sb, user.id, params.phaseId),
    getLegacyPattern(sb, user.id),
  ]);
  const before: WeeklyPattern =
    row && row.pattern && Object.keys(row.pattern).length > 0 ? row.pattern : legacy;
  const currentVersion = row?.version ?? null;

  // Early-out CAS: cheaper than running the diff + failing inside apply.
  // Returns the current state so the client can re-render without a second
  // round-trip.
  if (currentVersion !== expectedVersion) {
    return NextResponse.json(
      {
        ok: false,
        reason: 'version_conflict',
        current_version: currentVersion,
        current_pattern: before,
      },
      { status: 409 }
    );
  }

  const window = templateApplyWindow({
    todayIso,
    phase: phase as PhaseRow,
  });

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

  const plansByDate = new Map<string, ExistingPlan>();
  for (const p of ((plansResp.data ?? []) as ExistingPlan[])) {
    const prior = plansByDate.get(p.date);
    if (!prior || p.status === 'planned') plansByDate.set(p.date, p);
  }

  const diff = buildTemplateDiff({
    todayIso,
    phase: phase as PhaseRow,
    allPhases: (allPhases ?? []) as PhaseRow[],
    before,
    after,
    plansByDate,
    eventsByPhaseDay,
  });

  // No-op shortcut: don't write a template row + audit proposal if nothing
  // actually changed. That keeps the History feed clean when a user opens
  // the editor, fiddles, reverts, and hits Apply.
  const isNoOp =
    diff.updates.length === 0 &&
    diff.creates.length === 0 &&
    diff.deletes.length === 0;
  if (isNoOp) {
    return NextResponse.json({
      ok: true,
      proposal_id: null,
      template_version: currentVersion,
      applied: { updates: 0, creates: 0, deletes: 0 },
      skipped: { updates_drifted: 0, deletes_not_planned: 0 },
      diff,
      no_op: true,
    });
  }

  const result = await applyTemplateDiff({
    sb,
    userId: user.id,
    phaseId: phase.id as string,
    diff,
    expectedVersion,
  });

  if (!result.ok) {
    const status = result.reason === 'version_conflict' ? 409 : 500;
    return NextResponse.json({ ...result, diff }, { status });
  }

  return NextResponse.json({
    ...result,
    diff,
  });
}
