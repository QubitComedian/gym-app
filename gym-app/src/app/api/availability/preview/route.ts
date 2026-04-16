/**
 * Availability windows — preview (dry-run) endpoint.
 *
 *   POST /api/availability/preview
 *
 * Body variants:
 *
 *   Create preview (no window_id):
 *     {
 *       starts_on: 'yyyy-MM-dd',
 *       ends_on:   'yyyy-MM-dd',
 *       kind:      'travel' | 'injury' | 'pause',
 *       strategy?: 'auto' | 'bodyweight' | 'rest' | 'suppress',
 *       note?:     string | null
 *     }
 *
 *   Modify preview (window_id + patch):
 *     {
 *       window_id: string,
 *       patch: {
 *         starts_on?: 'yyyy-MM-dd',
 *         ends_on?:   'yyyy-MM-dd',
 *         strategy?:  'auto' | 'bodyweight' | 'rest' | 'suppress',
 *         note?:      string | null
 *       }
 *     }
 *
 * Runs the pure diff engine without writing anything. Returns either
 *   { diff: AvailabilityDiffOk }
 * or
 *   { error: 'overlaps_existing', conflicts: [...] }
 *
 * The client uses this to render the review modal before confirming an
 * apply (POST /api/availability or PATCH /api/availability/[id]).
 *
 * Response codes:
 *   200 — preview ok (diff in body)
 *   400 — invalid input
 *   401 — unauthenticated
 *   404 — window_id not found (modify preview)
 *   409 — overlaps existing active window (conflicts in body)
 *   500 — unexpected DB error
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseServer } from '@/lib/supabase/server';
import { formatInTimeZone } from '@/lib/reconcile/tz';
import { getAllWeeklyPatternsForUser } from '@/lib/templates/loader';
import {
  buildCreateWindowDiff,
  buildModifyWindowDiff,
  type AvailabilityDiff,
  type ExistingPlan,
} from '@/lib/availability/diff.pure';
import { MAX_WINDOW_LENGTH_DAYS } from '@/lib/availability/apply';
import type {
  ActiveWindow,
  AvailabilityWindowKind,
  AvailabilityWindowStrategy,
  CalendarEventRow,
  PhaseRow,
} from '@/lib/reconcile/rollForward.pure';

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'yyyy-MM-dd expected');

const CreatePreview = z.object({
  starts_on: IsoDate,
  ends_on: IsoDate,
  kind: z.enum(['travel', 'injury', 'pause']),
  strategy: z.enum(['auto', 'bodyweight', 'rest', 'suppress']).optional(),
  note: z.string().max(500).nullable().optional(),
}).refine((v) => v.starts_on <= v.ends_on, {
  message: 'starts_on must be <= ends_on',
});

const ModifyPreview = z.object({
  window_id: z.string().uuid(),
  patch: z.object({
    starts_on: IsoDate.optional(),
    ends_on: IsoDate.optional(),
    strategy: z.enum(['auto', 'bodyweight', 'rest', 'suppress']).optional(),
    note: z.string().max(500).nullable().optional(),
  }).refine(
    (v) =>
      v.starts_on !== undefined ||
      v.ends_on !== undefined ||
      v.strategy !== undefined ||
      v.note !== undefined,
    { message: 'at least one patch field required' }
  ),
});

type ParsedBody =
  | { kind: 'create'; body: z.infer<typeof CreatePreview> }
  | { kind: 'modify'; body: z.infer<typeof ModifyPreview> };

function parseBody(raw: unknown): ParsedBody | { error: string } {
  // A "modify" body has window_id; everything else is create.
  if (raw && typeof raw === 'object' && 'window_id' in (raw as object)) {
    // Reject `kind` in the patch explicitly — it's immutable. Without this
    // Zod silently strips the field and the client thinks it took effect.
    const maybePatch = (raw as { patch?: unknown }).patch;
    if (maybePatch && typeof maybePatch === 'object' && 'kind' in maybePatch) {
      return {
        error: 'kind is immutable — cancel this window and create a new one to change kind',
      };
    }
    const parsed = ModifyPreview.safeParse(raw);
    if (!parsed.success) return { error: parsed.error.message };
    return { kind: 'modify', body: parsed.data };
  }
  const parsed = CreatePreview.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.message };
  return { kind: 'create', body: parsed.data };
}

function inclusiveDayCount(startIso: string, endIso: string): number {
  const ms =
    Date.parse(endIso + 'T00:00:00Z') - Date.parse(startIso + 'T00:00:00Z');
  return Math.round(ms / 86_400_000) + 1;
}

export async function POST(req: Request) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 });

  const raw = await req.json().catch(() => null);
  const parsed = parseBody(raw);
  if ('error' in parsed) {
    return NextResponse.json(
      { error: 'invalid_input', detail: parsed.error },
      { status: 400 }
    );
  }

  // ---- Load timezone + today iso --------------------------------------
  const { data: profile } = await sb
    .from('profiles')
    .select('timezone')
    .eq('user_id', user.id)
    .maybeSingle();
  const tz = (profile?.timezone as string | null) || 'UTC';
  const todayIso = formatInTimeZone(new Date(), tz, 'yyyy-MM-dd');

  // ---- Branch: resolve the candidate window + range to load ----------
  let oldWindow: ActiveWindow | null = null;
  let newWindow: ActiveWindow;
  let rangeStart: string;
  let rangeEnd: string;
  let excludeId: string | undefined;

  if (parsed.kind === 'create') {
    const b = parsed.body;
    newWindow = {
      id: '00000000-0000-0000-0000-000000000000', // placeholder — preview only
      starts_on: b.starts_on,
      ends_on: b.ends_on,
      kind: b.kind as AvailabilityWindowKind,
      strategy: (b.strategy ?? 'auto') as AvailabilityWindowStrategy,
      note: b.note ?? null,
    };
    rangeStart = b.starts_on;
    rangeEnd = b.ends_on;
  } else {
    const { data: row, error } = await sb
      .from('availability_windows')
      .select('id, starts_on, ends_on, kind, strategy, note, status')
      .eq('user_id', user.id)
      .eq('id', parsed.body.window_id)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!row) return NextResponse.json({ error: 'window_not_found' }, { status: 404 });
    if (row.status !== 'active') {
      return NextResponse.json(
        { error: 'window_not_active', detail: `status=${row.status}` },
        { status: 409 }
      );
    }
    oldWindow = {
      id: row.id,
      starts_on: row.starts_on,
      ends_on: row.ends_on,
      kind: row.kind as AvailabilityWindowKind,
      strategy: row.strategy as AvailabilityWindowStrategy,
      note: row.note,
    };
    const p = parsed.body.patch;
    newWindow = {
      id: oldWindow.id,
      starts_on: p.starts_on ?? oldWindow.starts_on,
      ends_on: p.ends_on ?? oldWindow.ends_on,
      kind: oldWindow.kind, // immutable
      strategy: (p.strategy ?? oldWindow.strategy) as AvailabilityWindowStrategy,
      note: p.note !== undefined ? p.note : oldWindow.note,
    };
    if (newWindow.starts_on > newWindow.ends_on) {
      return NextResponse.json(
        { error: 'invalid_input', detail: 'starts_on must be <= ends_on' },
        { status: 400 }
      );
    }
    rangeStart = oldWindow.starts_on < newWindow.starts_on ? oldWindow.starts_on : newWindow.starts_on;
    rangeEnd = oldWindow.ends_on > newWindow.ends_on ? oldWindow.ends_on : newWindow.ends_on;
    excludeId = oldWindow.id;
  }

  // Enforce the same length cap the apply layer uses so preview and apply
  // stay in lockstep. Without this, preview would render a diff for a
  // 10-year window and the subsequent apply would 400.
  const resolvedDays = inclusiveDayCount(newWindow.starts_on, newWindow.ends_on);
  if (resolvedDays > MAX_WINDOW_LENGTH_DAYS) {
    return NextResponse.json(
      {
        error: 'invalid_input',
        detail: `window length ${resolvedDays} days exceeds max ${MAX_WINDOW_LENGTH_DAYS}`,
      },
      { status: 400 }
    );
  }

  // ---- Load supporting context in parallel ----------------------------
  const [
    patternByPhase,
    phasesResp,
    eventsResp,
    plansResp,
    otherWindowsResp,
  ] = await Promise.all([
    getAllWeeklyPatternsForUser(sb, user.id),
    sb
      .from('phases')
      .select('id, code, starts_on, target_ends_on')
      .eq('user_id', user.id)
      .order('starts_on', { ascending: true }),
    sb
      .from('calendar_events')
      .select('id, phase_id, day_code, summary, prescription')
      .eq('user_id', user.id),
    sb
      .from('plans')
      .select('id, date, type, day_code, status, source, phase_id, window_id, prescription, calendar_event_id')
      .eq('user_id', user.id)
      .gte('date', rangeStart)
      .lte('date', rangeEnd),
    sb
      .from('availability_windows')
      .select('id, starts_on, ends_on, kind, strategy, note')
      .eq('user_id', user.id)
      .eq('status', 'active'),
  ]);

  const phases = (phasesResp.data ?? []) as PhaseRow[];

  const eventsByPhaseDay = new Map<string, CalendarEventRow>();
  for (const e of (eventsResp.data ?? []) as CalendarEventRow[]) {
    if (!e.phase_id || !e.day_code) continue;
    eventsByPhaseDay.set(`${e.phase_id}:${e.day_code}`, e);
  }

  const plansByDate = new Map<string, ExistingPlan>();
  for (const p of ((plansResp.data ?? []) as ExistingPlan[])) {
    const prior = plansByDate.get(p.date);
    if (!prior || p.status === 'planned') plansByDate.set(p.date, p);
  }

  const otherActiveWindows: ActiveWindow[] = [];
  for (const w of (otherWindowsResp.data ?? []) as Array<ActiveWindow>) {
    if (excludeId && w.id === excludeId) continue;
    otherActiveWindows.push(w);
  }

  // ---- Run the pure diff engine ---------------------------------------
  let diff: AvailabilityDiff;
  if (parsed.kind === 'create') {
    diff = buildCreateWindowDiff({
      userId: user.id,
      todayIso,
      window: newWindow,
      otherActiveWindows,
      plansByDate,
      phases,
      weeklyPattern: patternByPhase,
      eventsByPhaseDay,
    });
  } else {
    diff = buildModifyWindowDiff({
      userId: user.id,
      todayIso,
      oldWindow: oldWindow!,
      newWindow,
      otherActiveWindows,
      plansByDate,
      phases,
      weeklyPattern: patternByPhase,
      eventsByPhaseDay,
    });
  }

  if (diff.kind === 'error') {
    return NextResponse.json(
      { error: 'overlaps_existing', conflicts: diff.conflicts },
      { status: 409 }
    );
  }

  return NextResponse.json({ diff, todayIso });
}
