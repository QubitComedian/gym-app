/**
 * Availability-window I/O wrapper (P1.3 / PR-O).
 *
 * Thin, Supabase-aware layer around the pure diff engine in
 * `./diff.pure.ts`. This is where DB reads, writes, ordering guarantees,
 * and the audit-proposal lifecycle live.
 *
 * Four public entry points:
 *
 *   - `applyCreateWindow`    — insert an availability_windows row, apply
 *                              the window over its effective range, log a
 *                              kind='availability_change' audit proposal.
 *   - `applyModifyWindow`    — update an existing window's range /
 *                              strategy / note, reshape plan rows over
 *                              (oldRange ∪ newRange), log an audit entry.
 *   - `applyCancelWindow`    — set status='cancelled' on a window row,
 *                              roll affected plan rows back to the
 *                              template, log an audit entry.
 *   - `applyRollbackAvailability` — given a prior audit proposal,
 *                              invert it (create→cancel, cancel→create,
 *                              modify→swap) so the `/api/proposals/[id]`
 *                              rollback endpoint has a single handle.
 *
 * Ordering (same spirit as `templates/apply.ts`):
 *
 *   1. Load minimal context (todayIso via tz).
 *   2. Validate + compute overlap pre-check against OTHER active
 *      windows. Cheap and lets us bail before writing anything.
 *   3. Window row write (insert / update / soft-delete). Any failure
 *      here aborts BEFORE plan-row writes — we never leave a half-built
 *      window with partial plan coverage.
 *   4. Load the rest of the context (phases, patterns, events, plans in
 *      the affected range) and compute the pure diff.
 *   5. Plan ops: updates (with drift guard), batch creates, deletes
 *      (guarded to status='planned'). Serial writes; Supabase doesn't
 *      offer multi-table transactions from the Node client.
 *   6. Audit `ai_proposals` row LAST — if plan writes partially failed,
 *      the counters reflect what actually landed and the stored diff
 *      captures intent for the rollback path.
 *   7. Fire-and-forget reconcile(cause='availability_changed') so any
 *      downstream settle (e.g. roll-forward filling horizon dates the
 *      window shifted around) happens before the next page load.
 *
 * Partial-failure policy: the window row is the authority. If we've
 * written the window row but some plan writes drifted or errored, the
 * next reconciler pass will detect the mismatch on a subsequent run
 * (PR-P integrates windows into roll-forward); in the meantime the UI
 * still reflects the user's intent via the window list + audit entry.
 *
 * Drift guard: plan-row updates are scoped to the exact (plan_id,
 * status='planned', type, day_code) we observed at diff time. If the
 * row shifted under us (logged activity, another edit landed), we skip
 * silently and count it as drifted. The next diff preview surfaces the
 * drift.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { reconcile } from '@/lib/reconcile';
import { enqueuePlanSync } from '@/lib/plans/write';
import { formatInTimeZone } from '@/lib/reconcile/tz';
import { getAllWeeklyPatternsForUser } from '@/lib/templates/loader';
import type {
  ActiveWindow,
  AvailabilityWindowKind,
  AvailabilityWindowStrategy,
  CalendarEventRow,
  PhaseRow,
} from '@/lib/reconcile/rollForward.pure';
import {
  buildCancelWindowDiff,
  buildCreateWindowDiff,
  buildModifyWindowDiff,
  findOverlappingWindows,
  type AvailabilityDiff,
  type AvailabilityDiffError,
  type AvailabilityDiffOk,
  type ExistingPlan,
  type PlanCreate,
  type PlanDelete,
  type PlanUpdate,
} from './diff.pure';

// =====================================================================
// Public types
// =====================================================================

/** User-supplied fields for a new window. */
export type CreateWindowInput = {
  starts_on: string;              // ISO yyyy-MM-dd, inclusive
  ends_on: string;                // ISO yyyy-MM-dd, inclusive
  kind: AvailabilityWindowKind;
  strategy?: AvailabilityWindowStrategy; // default 'auto'
  note?: string | null;
  metadata?: Record<string, unknown>;
};

/** Patch fields for a window modify. Kind is immutable by contract. */
export type ModifyWindowPatch = {
  starts_on?: string;
  ends_on?: string;
  strategy?: AvailabilityWindowStrategy;
  note?: string | null;
  metadata?: Record<string, unknown>;
};

/** Counters on a successful apply. */
export type ApplyCounts = {
  applied: { updates: number; creates: number; deletes: number };
  skipped: {
    updates_drifted: number;
    deletes_not_planned: number;
    preserved_logged: number;
    preserved_manual: number;
    preserved_ai_proposed: number;
    preserved_other_window: number;
  };
};

/** Result shape shared across the four entry points. */
export type ApplyAvailabilityResult =
  | ({
      ok: true;
      proposal_id: string | null; // null for no-op modifies
      window_id: string;
      intent: 'create' | 'modify' | 'cancel' | 'rollback';
      diff: AvailabilityDiffOk;
    } & ApplyCounts)
  | {
      ok: false;
      reason:
        | 'overlaps_existing'
        | 'window_not_found'
        | 'window_not_active'
        | 'window_write_failed'
        | 'audit_insert_failed'
        | 'invalid_input'
        | 'rollback_target_not_availability'
        | 'rollback_already_rolled_back';
      detail?: string;
      conflicts?: AvailabilityDiffError['conflicts'];
    };

// =====================================================================
// Internal context loader
// =====================================================================

type Ctx = {
  todayIso: string;
  phases: PhaseRow[];
  weeklyPattern: ReadonlyMap<string, import('@/lib/reconcile/rollForward.pure').WeeklyPattern>;
  eventsByPhaseDay: ReadonlyMap<string, CalendarEventRow>;
  plansByDate: ReadonlyMap<string, ExistingPlan>;
  otherActiveWindows: ActiveWindow[];
};

/**
 * Load the ambient context the pure diff needs. The plans query is
 * scoped to [start, end] so we don't drag in every row the user owns.
 */
async function loadContext(args: {
  sb: SupabaseClient;
  userId: string;
  now: Date;
  rangeStart: string;
  rangeEnd: string;
  excludeWindowId?: string;
}): Promise<Ctx> {
  const { sb, userId, now, rangeStart, rangeEnd, excludeWindowId } = args;

  // Profile → timezone → today
  const { data: profile } = await sb
    .from('profiles')
    .select('timezone')
    .eq('user_id', userId)
    .maybeSingle();
  const tz = (profile?.timezone as string | null) || 'UTC';
  const todayIso = formatInTimeZone(now, tz, 'yyyy-MM-dd');

  // Phases, calendar events, plans, patterns, other active windows — in
  // parallel. Everything here is a narrow projection.
  const [
    patternByPhase,
    phasesResp,
    eventsResp,
    plansResp,
    otherWindowsResp,
  ] = await Promise.all([
    getAllWeeklyPatternsForUser(sb, userId),
    sb
      .from('phases')
      .select('id, code, starts_on, target_ends_on')
      .eq('user_id', userId)
      .order('starts_on', { ascending: true }),
    sb
      .from('calendar_events')
      .select('id, phase_id, day_code, summary, prescription')
      .eq('user_id', userId),
    sb
      .from('plans')
      .select('id, date, type, day_code, status, source, phase_id, window_id, prescription, calendar_event_id')
      .eq('user_id', userId)
      .gte('date', rangeStart)
      .lte('date', rangeEnd),
    sb
      .from('availability_windows')
      .select('id, starts_on, ends_on, kind, strategy, note')
      .eq('user_id', userId)
      .eq('status', 'active'),
  ]);

  const phases = (phasesResp.data ?? []) as PhaseRow[];

  const eventsByPhaseDay = new Map<string, CalendarEventRow>();
  for (const e of (eventsResp.data ?? []) as CalendarEventRow[]) {
    if (!e.phase_id || !e.day_code) continue;
    eventsByPhaseDay.set(`${e.phase_id}:${e.day_code}`, e);
  }

  // If two rows exist on the same date (e.g. gym + run future), prefer
  // status='planned' — that's the row the diff should reshape. Logged
  // rows are preserved regardless so picking the planned one lets us
  // realign the replaceable slot.
  const plansByDate = new Map<string, ExistingPlan>();
  for (const p of ((plansResp.data ?? []) as ExistingPlan[])) {
    const prior = plansByDate.get(p.date);
    if (!prior || p.status === 'planned') plansByDate.set(p.date, p);
  }

  const otherActiveWindows: ActiveWindow[] = [];
  for (const w of (otherWindowsResp.data ?? []) as Array<{
    id: string;
    starts_on: string;
    ends_on: string;
    kind: AvailabilityWindowKind;
    strategy: AvailabilityWindowStrategy;
    note: string | null;
  }>) {
    if (excludeWindowId && w.id === excludeWindowId) continue;
    otherActiveWindows.push(w);
  }

  return {
    todayIso,
    phases,
    weeklyPattern: patternByPhase,
    eventsByPhaseDay,
    plansByDate,
    otherActiveWindows,
  };
}

// =====================================================================
// Validation helpers
// =====================================================================

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidIso(s: unknown): s is string {
  return typeof s === 'string' && ISO_DATE.test(s);
}

function isValidKind(k: unknown): k is AvailabilityWindowKind {
  return k === 'travel' || k === 'injury' || k === 'pause';
}

function isValidStrategy(s: unknown): s is AvailabilityWindowStrategy {
  return s === 'auto' || s === 'bodyweight' || s === 'rest' || s === 'suppress';
}

/**
 * Maximum inclusive length of a single window in days. Kept to a year
 * because:
 *   - Roll-forward's enumeration helpers cap at ~400 iterations.
 *   - The audit diff is stored as a jsonb row; multi-year ranges bloat
 *     it needlessly.
 *   - UX — if a user wants "retired", that's a product decision, not a
 *     365-day pause.
 * Client forms also cap at 365; this is the server-side authoritative
 * guardrail.
 */
export const MAX_WINDOW_LENGTH_DAYS = 365;

/** Inclusive day count between two ISO yyyy-MM-dd dates. */
function inclusiveDayCount(startIso: string, endIso: string): number {
  const ms =
    Date.parse(endIso + 'T00:00:00Z') - Date.parse(startIso + 'T00:00:00Z');
  return Math.round(ms / 86_400_000) + 1;
}

export function validateCreateInput(
  input: CreateWindowInput
): { ok: true } | { ok: false; detail: string } {
  if (!isValidIso(input.starts_on)) return { ok: false, detail: 'starts_on must be yyyy-MM-dd' };
  if (!isValidIso(input.ends_on)) return { ok: false, detail: 'ends_on must be yyyy-MM-dd' };
  if (input.starts_on > input.ends_on) {
    return { ok: false, detail: 'starts_on must be <= ends_on' };
  }
  const days = inclusiveDayCount(input.starts_on, input.ends_on);
  if (days > MAX_WINDOW_LENGTH_DAYS) {
    return {
      ok: false,
      detail: `window length ${days} days exceeds max ${MAX_WINDOW_LENGTH_DAYS}`,
    };
  }
  if (!isValidKind(input.kind)) return { ok: false, detail: 'kind must be travel|injury|pause' };
  if (input.strategy !== undefined && !isValidStrategy(input.strategy)) {
    return { ok: false, detail: 'strategy must be auto|bodyweight|rest|suppress' };
  }
  if (input.note !== undefined && input.note !== null && typeof input.note !== 'string') {
    return { ok: false, detail: 'note must be string or null' };
  }
  return { ok: true };
}

export function validateModifyPatch(
  patch: ModifyWindowPatch
): { ok: true } | { ok: false; detail: string } {
  if (patch.starts_on !== undefined && !isValidIso(patch.starts_on)) {
    return { ok: false, detail: 'starts_on must be yyyy-MM-dd' };
  }
  if (patch.ends_on !== undefined && !isValidIso(patch.ends_on)) {
    return { ok: false, detail: 'ends_on must be yyyy-MM-dd' };
  }
  // If both dates are present in the patch, pre-check ordering + length
  // early so we return 400 without a DB round-trip. The final check
  // against the RESOLVED (patch ∪ old) range still happens after load.
  if (patch.starts_on !== undefined && patch.ends_on !== undefined) {
    if (patch.starts_on > patch.ends_on) {
      return { ok: false, detail: 'starts_on must be <= ends_on' };
    }
    const days = inclusiveDayCount(patch.starts_on, patch.ends_on);
    if (days > MAX_WINDOW_LENGTH_DAYS) {
      return {
        ok: false,
        detail: `window length ${days} days exceeds max ${MAX_WINDOW_LENGTH_DAYS}`,
      };
    }
  }
  if (patch.strategy !== undefined && !isValidStrategy(patch.strategy)) {
    return { ok: false, detail: 'strategy must be auto|bodyweight|rest|suppress' };
  }
  if (patch.note !== undefined && patch.note !== null && typeof patch.note !== 'string') {
    return { ok: false, detail: 'note must be string or null' };
  }
  return { ok: true };
}

// =====================================================================
// Plan-op executor (shared across all entry points)
// =====================================================================

/**
 * Apply `{updates, creates, deletes}` to the `plans` table. Caller
 * pre-computed the diff; this is purely the Supabase side.
 *
 * Returns counters that mirror the diff's intent vs what actually
 * landed. Drift / not-planned guards are the only reasons to "skip";
 * they don't fail the whole apply.
 */
async function executePlanOps(args: {
  sb: SupabaseClient;
  userId: string;
  updates: PlanUpdate[];
  creates: PlanCreate[];
  deletes: PlanDelete[];
}): Promise<{
  applied_updates: number;
  applied_creates: number;
  applied_deletes: number;
  skipped_drifted: number;
  skipped_not_planned: number;
}> {
  const { sb, userId, updates, creates, deletes } = args;

  let applied_updates = 0;
  let applied_creates = 0;
  let applied_deletes = 0;
  let skipped_drifted = 0;
  let skipped_not_planned = 0;

  // Plan ids whose Google-event projection we'll enqueue for sync at the
  // end. Populated only on successful writes so we don't queue work the
  // worker would silently drop.
  const upsertedPlanIds: string[] = [];

  // 1. Updates — drift-guarded, serial.
  for (const u of updates) {
    const { data: existing, error: loadErr } = await sb
      .from('plans')
      .select('id, type, day_code, status, source, window_id, version')
      .eq('user_id', userId)
      .eq('id', u.plan_id)
      .maybeSingle();
    if (loadErr || !existing) {
      skipped_drifted += 1;
      continue;
    }
    if (existing.status !== 'planned') {
      skipped_drifted += 1;
      continue;
    }
    // Drift check — the "before" snapshot must still match. If the row
    // changed type/day_code/source/window_id since diff time, another
    // write raced us and the diff's ops are stale.
    if (
      existing.type !== u.before.type ||
      (existing.day_code ?? null) !== (u.before.day_code ?? null) ||
      existing.source !== u.before.source ||
      (existing.window_id ?? null) !== (u.before.window_id ?? null)
    ) {
      skipped_drifted += 1;
      continue;
    }

    const { error: updErr } = await sb
      .from('plans')
      .update({
        type: u.patch.type,
        day_code: u.patch.day_code,
        prescription: u.patch.prescription,
        calendar_event_id: u.patch.calendar_event_id,
        phase_id: u.patch.phase_id,
        source: u.patch.source,
        window_id: u.patch.window_id,
        ai_rationale: u.patch.ai_rationale,
        version: ((existing.version as number | null) ?? 1) + 1,
      })
      .eq('id', u.plan_id)
      .eq('user_id', userId)
      .eq('status', 'planned'); // belt-and-suspenders

    if (updErr) {
      console.error('[availability/apply] plan update failed', updErr, { plan_id: u.plan_id });
      skipped_drifted += 1;
      continue;
    }
    applied_updates += 1;
    upsertedPlanIds.push(u.plan_id);
  }

  // 2. Creates — batch insert. No ON CONFLICT; the diff already filtered
  //    dates holding a plan row via the plansByDate map.
  //    We capture the inserted ids via `.select('id')` so the calendar
  //    sync hook (below) can queue each new plan for Google Calendar
  //    projection.
  if (creates.length > 0) {
    const rows = creates.map((c) => ({
      user_id: userId,
      phase_id: c.phase_id,
      date: c.date,
      type: c.type,
      day_code: c.day_code,
      prescription: c.prescription,
      calendar_event_id: c.calendar_event_id,
      source: c.source,
      window_id: c.window_id,
      status: c.status,
      ai_rationale: c.ai_rationale,
    }));
    const { data: insertedRows, error: insErr } = await sb
      .from('plans')
      .insert(rows)
      .select('id');
    if (insErr) {
      console.error('[availability/apply] plan creates failed', insErr);
    } else {
      applied_creates = insertedRows?.length ?? 0;
      for (const r of (insertedRows ?? []) as Array<{ id: string }>) {
        upsertedPlanIds.push(r.id);
      }
    }
  }

  // 3. Pre-snapshot delete links for calendar sync — MUST happen before
  //    the delete loop runs. After a plan row is deleted, its
  //    `calendar_links.plan_id` is set to NULL (migration 0008), so a
  //    later lookup by plan_id returns nothing. We enqueue the
  //    `plan_delete` jobs now so the worker carries google_event_id +
  //    google_calendar_id in the payload.
  //
  //    We enqueue for EVERY delete candidate, even ones that will end
  //    up skipped below (e.g. user logged the activity concurrently).
  //    Over-enqueueing is cheap: the worker fetches the plan row on
  //    pickup and no-ops if the row is gone in the "delete" direction
  //    but the calendar_link row confirms the event should be removed.
  //    Under-enqueueing would silently leave ghost events on the
  //    user's Google Calendar.
  if (deletes.length > 0) {
    await enqueuePlanSync(sb, userId, { deleteIds: deletes.map((d) => d.plan_id) });
  }

  // 4. Deletes — planned-only guard. If the user logged the activity in
  //    the window of time between diff and apply, the plan is now part
  //    of their history and we don't touch it.
  for (const d of deletes) {
    const { error: delErr, count } = await sb
      .from('plans')
      .delete({ count: 'exact' })
      .eq('id', d.plan_id)
      .eq('user_id', userId)
      .eq('status', 'planned');
    if (delErr) {
      console.error('[availability/apply] plan delete failed', delErr, { plan_id: d.plan_id });
      skipped_not_planned += 1;
      continue;
    }
    if ((count ?? 0) === 0) {
      skipped_not_planned += 1;
      continue;
    }
    applied_deletes += 1;
  }

  // 5. Enqueue plan_upsert jobs for everything we successfully updated
  //    or inserted. Call AFTER all writes commit so the worker, when it
  //    re-reads the plan row, sees the final state.
  //
  //    Failure to enqueue does not fail the apply — plan writes are the
  //    source of truth, and the reconciler's nightly full-scan (PR-W)
  //    can rebuild the sync queue from scratch.
  if (upsertedPlanIds.length > 0) {
    await enqueuePlanSync(sb, userId, { upsertIds: upsertedPlanIds });
  }

  return {
    applied_updates,
    applied_creates,
    applied_deletes,
    skipped_drifted,
    skipped_not_planned,
  };
}

// =====================================================================
// Audit writer
// =====================================================================

type AuditIntent = 'create' | 'modify' | 'cancel' | 'rollback';

/**
 * Write the `ai_proposals` audit row. Stored LAST so we only log
 * history for applies that at least partially landed (plan writes
 * already ran; a missing audit entry is the least-bad failure mode).
 *
 * The `diff` jsonb carries everything needed for a rollback:
 *   - the computed AvailabilityDiffOk (creates/updates/deletes)
 *   - window_before and window_after (for modify)
 *   - window snapshot (for create/cancel)
 *   - applied/skipped counters
 *
 * `triggered_by` describes the human action; `rollback_of` chains
 * rollback audits to the original audit row.
 */
async function writeAudit(args: {
  sb: SupabaseClient;
  userId: string;
  intent: AuditIntent;
  diff: AvailabilityDiffOk;
  windowBefore: ActiveWindow | null;
  windowAfter: ActiveWindow | null;
  counts: ApplyCounts;
  rollbackOf?: string | null;
  triggeredBy: string;
  now: Date;
}): Promise<string | null> {
  const {
    sb, userId, intent, diff, windowBefore, windowAfter, counts, rollbackOf, triggeredBy, now,
  } = args;

  const { data, error } = await sb
    .from('ai_proposals')
    .insert({
      user_id: userId,
      kind: 'availability_change',
      triggered_by: triggeredBy,
      status: 'applied',
      applied_at: now.toISOString(),
      rationale: diff.rationale,
      diff: {
        intent,
        window_id: diff.window_id,
        range: diff.range,
        creates: diff.creates,
        updates: diff.updates,
        deletes: diff.deletes,
        summary: diff.summary,
        window_before: windowBefore,
        window_after: windowAfter,
        rollback_of: rollbackOf ?? null,
        applied_counts: counts.applied,
        skipped_counts: counts.skipped,
      },
    })
    .select('id')
    .single();

  if (error || !data) {
    console.error('[availability/apply] audit insert failed', error);
    return null;
  }
  return data.id as string;
}

// =====================================================================
// Result builder
// =====================================================================

function buildCounts(
  diff: AvailabilityDiffOk,
  ops: Awaited<ReturnType<typeof executePlanOps>>
): ApplyCounts {
  return {
    applied: {
      updates: ops.applied_updates,
      creates: ops.applied_creates,
      deletes: ops.applied_deletes,
    },
    skipped: {
      updates_drifted: ops.skipped_drifted,
      deletes_not_planned: ops.skipped_not_planned,
      preserved_logged: diff.summary.skipped_logged,
      preserved_manual: diff.summary.skipped_manual,
      preserved_ai_proposed: diff.summary.skipped_ai_proposed,
      preserved_other_window: diff.summary.skipped_other_window,
    },
  };
}

// =====================================================================
// Helpers for window row shape
// =====================================================================

function rowToActiveWindow(row: {
  id: string;
  starts_on: string;
  ends_on: string;
  kind: string;
  strategy: string;
  note: string | null;
}): ActiveWindow {
  return {
    id: row.id,
    starts_on: row.starts_on,
    ends_on: row.ends_on,
    kind: row.kind as AvailabilityWindowKind,
    strategy: row.strategy as AvailabilityWindowStrategy,
    note: row.note,
  };
}

function fireAndForgetReconcile(sb: SupabaseClient, userId: string, now: Date): void {
  reconcile(sb, userId, now, 'availability_changed').catch((e) => {
    console.error('[availability/apply] reconcile hook failed', e);
  });
}

// =====================================================================
// applyCreateWindow
// =====================================================================

export async function applyCreateWindow(args: {
  sb: SupabaseClient;
  userId: string;
  input: CreateWindowInput;
  now?: Date;
  /** Internal: set when called from the rollback path so the audit
   *  entry chains back to the original. */
  rollbackOf?: string | null;
  /** Internal: override the audit triggered_by label. */
  triggeredBy?: string;
}): Promise<ApplyAvailabilityResult> {
  const { sb, userId, input } = args;
  const now = args.now ?? new Date();

  // -------- 1. Validate --------------------------------------------------
  const validated = validateCreateInput(input);
  if (!validated.ok) {
    return { ok: false, reason: 'invalid_input', detail: validated.detail };
  }

  // -------- 2. Pre-flight context + overlap check ------------------------
  // We load BEFORE the window insert so we can reject overlaps without
  // having to delete a freshly-inserted row.
  const preCtx = await loadContext({
    sb, userId, now,
    rangeStart: input.starts_on,
    rangeEnd: input.ends_on,
  });

  const effectiveStart = input.starts_on > preCtx.todayIso ? input.starts_on : preCtx.todayIso;
  const effectiveEnd = input.ends_on;

  if (effectiveStart <= effectiveEnd) {
    const conflicts = findOverlappingWindows({
      start: effectiveStart,
      end: effectiveEnd,
      activeWindows: preCtx.otherActiveWindows,
    });
    if (conflicts.length > 0) {
      return {
        ok: false,
        reason: 'overlaps_existing',
        conflicts: conflicts.map((c) => ({
          id: c.id, starts_on: c.starts_on, ends_on: c.ends_on, kind: c.kind,
        })),
      };
    }
  }

  // -------- 3. Insert the window row -------------------------------------
  const strategy = input.strategy ?? 'auto';
  const { data: inserted, error: insErr } = await sb
    .from('availability_windows')
    .insert({
      user_id: userId,
      starts_on: input.starts_on,
      ends_on: input.ends_on,
      kind: input.kind,
      strategy,
      note: input.note ?? null,
      metadata: input.metadata ?? {},
      status: 'active',
    })
    .select('id, starts_on, ends_on, kind, strategy, note')
    .single();

  if (insErr || !inserted) {
    console.error('[availability/apply] window insert failed', insErr);
    return { ok: false, reason: 'window_write_failed', detail: insErr?.message };
  }

  const windowRow = rowToActiveWindow(inserted);

  // -------- 4. Compute + apply the diff ---------------------------------
  const diff: AvailabilityDiff = buildCreateWindowDiff({
    userId,
    todayIso: preCtx.todayIso,
    window: windowRow,
    otherActiveWindows: preCtx.otherActiveWindows,
    plansByDate: preCtx.plansByDate,
    phases: preCtx.phases,
    weeklyPattern: preCtx.weeklyPattern,
    eventsByPhaseDay: preCtx.eventsByPhaseDay,
  });

  // Defensive: the pre-check should have caught this, but if the pure
  // engine surfaces an overlap we still need to un-insert the window row
  // so we don't leak a ghost.
  if (diff.kind === 'error') {
    await sb.from('availability_windows').delete().eq('id', windowRow.id).eq('user_id', userId);
    return { ok: false, reason: 'overlaps_existing', conflicts: diff.conflicts };
  }

  const ops = await executePlanOps({
    sb, userId,
    updates: diff.updates,
    creates: diff.creates,
    deletes: diff.deletes,
  });

  const counts = buildCounts(diff, ops);

  // -------- 5. Audit + fire-and-forget reconcile ------------------------
  const proposalId = await writeAudit({
    sb, userId,
    intent: 'create',
    diff,
    windowBefore: null,
    windowAfter: windowRow,
    counts,
    rollbackOf: args.rollbackOf ?? null,
    triggeredBy: args.triggeredBy ?? 'user_availability_create',
    now,
  });

  if (!proposalId) {
    // Plan writes already landed; we still return ok so the UI shows the
    // window but flag the audit failure in the reason so callers can
    // surface a toast.
    fireAndForgetReconcile(sb, userId, now);
    return {
      ok: false,
      reason: 'audit_insert_failed',
      detail: 'Window created and plans updated, but audit row failed to save.',
    };
  }

  fireAndForgetReconcile(sb, userId, now);

  return {
    ok: true,
    proposal_id: proposalId,
    window_id: windowRow.id,
    intent: 'create',
    diff,
    ...counts,
  };
}

// =====================================================================
// applyCancelWindow
// =====================================================================

export async function applyCancelWindow(args: {
  sb: SupabaseClient;
  userId: string;
  windowId: string;
  now?: Date;
  rollbackOf?: string | null;
  triggeredBy?: string;
}): Promise<ApplyAvailabilityResult> {
  const { sb, userId, windowId } = args;
  const now = args.now ?? new Date();

  // -------- 1. Load + validate the window row ---------------------------
  const { data: row, error: loadErr } = await sb
    .from('availability_windows')
    .select('id, starts_on, ends_on, kind, strategy, note, status')
    .eq('user_id', userId)
    .eq('id', windowId)
    .maybeSingle();

  if (loadErr) {
    return { ok: false, reason: 'window_write_failed', detail: loadErr.message };
  }
  if (!row) {
    return { ok: false, reason: 'window_not_found' };
  }
  if (row.status !== 'active') {
    return { ok: false, reason: 'window_not_active', detail: `status=${row.status}` };
  }

  const windowRow = rowToActiveWindow(row);

  // -------- 2. Load context, compute diff ------------------------------
  const ctx = await loadContext({
    sb, userId, now,
    rangeStart: windowRow.starts_on,
    rangeEnd: windowRow.ends_on,
    excludeWindowId: windowRow.id,
  });

  const diff = buildCancelWindowDiff({
    userId,
    todayIso: ctx.todayIso,
    window: windowRow,
    plansByDate: ctx.plansByDate,
    phases: ctx.phases,
    weeklyPattern: ctx.weeklyPattern,
    eventsByPhaseDay: ctx.eventsByPhaseDay,
  });

  // -------- 3. Flip window status to 'cancelled' ------------------------
  // Done BEFORE plan ops so that if someone reads the UI between our
  // writes, they see the window as cancelled (accurate) rather than
  // active-with-gaps (confusing).
  const { error: cancelErr } = await sb
    .from('availability_windows')
    .update({ status: 'cancelled', cancelled_at: now.toISOString() })
    .eq('id', windowRow.id)
    .eq('user_id', userId)
    .eq('status', 'active'); // CAS-style: if another caller cancelled concurrently, don't double-write
  if (cancelErr) {
    return { ok: false, reason: 'window_write_failed', detail: cancelErr.message };
  }

  // -------- 4. Apply plan ops --------------------------------------------
  const ops = await executePlanOps({
    sb, userId,
    updates: diff.updates,
    creates: diff.creates,
    deletes: diff.deletes,
  });
  const counts = buildCounts(diff, ops);

  // -------- 5. Audit + reconcile -----------------------------------------
  const proposalId = await writeAudit({
    sb, userId,
    intent: 'cancel',
    diff,
    windowBefore: windowRow,
    windowAfter: null,
    counts,
    rollbackOf: args.rollbackOf ?? null,
    triggeredBy: args.triggeredBy ?? 'user_availability_cancel',
    now,
  });

  if (!proposalId) {
    fireAndForgetReconcile(sb, userId, now);
    return {
      ok: false,
      reason: 'audit_insert_failed',
      detail: 'Window cancelled and plans restored, but audit row failed to save.',
    };
  }

  fireAndForgetReconcile(sb, userId, now);

  return {
    ok: true,
    proposal_id: proposalId,
    window_id: windowRow.id,
    intent: 'cancel',
    diff,
    ...counts,
  };
}

// =====================================================================
// applyModifyWindow
// =====================================================================

export async function applyModifyWindow(args: {
  sb: SupabaseClient;
  userId: string;
  windowId: string;
  patch: ModifyWindowPatch;
  now?: Date;
  rollbackOf?: string | null;
  triggeredBy?: string;
}): Promise<ApplyAvailabilityResult> {
  const { sb, userId, windowId, patch } = args;
  const now = args.now ?? new Date();

  // -------- 1. Validate patch --------------------------------------------
  const validated = validateModifyPatch(patch);
  if (!validated.ok) {
    return { ok: false, reason: 'invalid_input', detail: validated.detail };
  }

  // -------- 2. Load current window row -----------------------------------
  const { data: row, error: loadErr } = await sb
    .from('availability_windows')
    .select('id, starts_on, ends_on, kind, strategy, note, metadata, status')
    .eq('user_id', userId)
    .eq('id', windowId)
    .maybeSingle();

  if (loadErr) {
    return { ok: false, reason: 'window_write_failed', detail: loadErr.message };
  }
  if (!row) {
    return { ok: false, reason: 'window_not_found' };
  }
  if (row.status !== 'active') {
    return { ok: false, reason: 'window_not_active', detail: `status=${row.status}` };
  }

  const oldWindow = rowToActiveWindow(row);
  const newWindow: ActiveWindow = {
    id: oldWindow.id,
    starts_on: patch.starts_on ?? oldWindow.starts_on,
    ends_on: patch.ends_on ?? oldWindow.ends_on,
    kind: oldWindow.kind, // immutable
    strategy: patch.strategy ?? oldWindow.strategy,
    note: patch.note !== undefined ? patch.note : oldWindow.note,
  };

  if (newWindow.starts_on > newWindow.ends_on) {
    return { ok: false, reason: 'invalid_input', detail: 'starts_on must be <= ends_on' };
  }
  // Final cap check against the resolved range — patch may only touch
  // one bound, so we re-validate after merging with the old row.
  const resolvedDays = inclusiveDayCount(newWindow.starts_on, newWindow.ends_on);
  if (resolvedDays > MAX_WINDOW_LENGTH_DAYS) {
    return {
      ok: false,
      reason: 'invalid_input',
      detail: `window length ${resolvedDays} days exceeds max ${MAX_WINDOW_LENGTH_DAYS}`,
    };
  }

  // -------- 3. Load context covering both old and new ranges ------------
  const rangeStart = oldWindow.starts_on < newWindow.starts_on ? oldWindow.starts_on : newWindow.starts_on;
  const rangeEnd = oldWindow.ends_on > newWindow.ends_on ? oldWindow.ends_on : newWindow.ends_on;

  const ctx = await loadContext({
    sb, userId, now,
    rangeStart,
    rangeEnd,
    excludeWindowId: windowId,
  });

  // -------- 4. Compute diff ---------------------------------------------
  const diff: AvailabilityDiff = buildModifyWindowDiff({
    userId,
    todayIso: ctx.todayIso,
    oldWindow,
    newWindow,
    otherActiveWindows: ctx.otherActiveWindows,
    plansByDate: ctx.plansByDate,
    phases: ctx.phases,
    weeklyPattern: ctx.weeklyPattern,
    eventsByPhaseDay: ctx.eventsByPhaseDay,
  });

  if (diff.kind === 'error') {
    return { ok: false, reason: 'overlaps_existing', conflicts: diff.conflicts };
  }

  // -------- 5. Update window row FIRST ----------------------------------
  // Reasoning: if we wrote plan ops first and the window update failed,
  // the plan rows would reference either stale old-range shape or
  // new-range shape that the window itself hasn't been updated to match.
  // Writing the row first means any partial failure below leaves the
  // window as the source of truth (reconciler will heal).
  const metadata = patch.metadata ?? (row.metadata as Record<string, unknown>);
  const { error: updErr } = await sb
    .from('availability_windows')
    .update({
      starts_on: newWindow.starts_on,
      ends_on: newWindow.ends_on,
      strategy: newWindow.strategy,
      note: newWindow.note,
      metadata,
    })
    .eq('id', windowId)
    .eq('user_id', userId)
    .eq('status', 'active');
  if (updErr) {
    return { ok: false, reason: 'window_write_failed', detail: updErr.message };
  }

  // -------- 6. Apply plan ops --------------------------------------------
  const ops = await executePlanOps({
    sb, userId,
    updates: diff.updates,
    creates: diff.creates,
    deletes: diff.deletes,
  });
  const counts = buildCounts(diff, ops);

  // -------- 7. No-op shortcut: skip audit row for zero-op modifies -----
  // If the patch was a no-op (e.g. user saved without changes or same
  // range / same strategy), we still wrote the window row (idempotent
  // update) but there's no user-visible history entry worth keeping.
  const isZeroOp =
    diff.creates.length === 0 &&
    diff.updates.length === 0 &&
    diff.deletes.length === 0 &&
    oldWindow.starts_on === newWindow.starts_on &&
    oldWindow.ends_on === newWindow.ends_on &&
    oldWindow.strategy === newWindow.strategy &&
    (oldWindow.note ?? null) === (newWindow.note ?? null);
  if (isZeroOp) {
    fireAndForgetReconcile(sb, userId, now);
    return {
      ok: true,
      proposal_id: null,
      window_id: windowId,
      intent: 'modify',
      diff,
      ...counts,
    };
  }

  // -------- 8. Audit + reconcile -----------------------------------------
  const proposalId = await writeAudit({
    sb, userId,
    intent: 'modify',
    diff,
    windowBefore: oldWindow,
    windowAfter: newWindow,
    counts,
    rollbackOf: args.rollbackOf ?? null,
    triggeredBy: args.triggeredBy ?? 'user_availability_modify',
    now,
  });

  if (!proposalId) {
    fireAndForgetReconcile(sb, userId, now);
    return {
      ok: false,
      reason: 'audit_insert_failed',
      detail: 'Window updated and plans reshaped, but audit row failed to save.',
    };
  }

  fireAndForgetReconcile(sb, userId, now);

  return {
    ok: true,
    proposal_id: proposalId,
    window_id: windowId,
    intent: 'modify',
    diff,
    ...counts,
  };
}

// =====================================================================
// applyRollbackAvailability
// =====================================================================

/**
 * Reverse a prior `kind='availability_change'` audit proposal.
 *
 * Rollback semantics by original intent:
 *   - create   → cancel the window (set status='cancelled', realign plans)
 *   - cancel   → recreate the window with the original parameters
 *                (generates a NEW window id — the old row is left
 *                'cancelled' for the audit trail)
 *   - modify   → apply a reverse modify (swap before/after)
 *
 * Rollback audits chain back to the original via `rollback_of` on the
 * new proposal's diff and via the original proposal's `diff.rollback_of`
 * field (we also mark the original's status as 'rolled_back' so the UI
 * can dim / disable the rollback button).
 */
export async function applyRollbackAvailability(args: {
  sb: SupabaseClient;
  userId: string;
  proposalId: string;
  now?: Date;
}): Promise<ApplyAvailabilityResult> {
  const { sb, userId, proposalId } = args;
  const now = args.now ?? new Date();

  // -------- 1. Load the original proposal --------------------------------
  const { data: orig } = await sb
    .from('ai_proposals')
    .select('id, user_id, kind, status, diff')
    .eq('user_id', userId)
    .eq('id', proposalId)
    .maybeSingle();
  if (!orig) return { ok: false, reason: 'window_not_found', detail: 'proposal not found' };
  if (orig.kind !== 'availability_change') {
    return { ok: false, reason: 'rollback_target_not_availability' };
  }
  if (orig.status !== 'applied') {
    return {
      ok: false,
      reason: 'rollback_already_rolled_back',
      detail: `status=${orig.status}`,
    };
  }

  type StoredDiff = {
    intent: AuditIntent;
    window_id: string;
    window_before: ActiveWindow | null;
    window_after: ActiveWindow | null;
  };
  const stored = orig.diff as StoredDiff | null;
  if (!stored || !stored.intent) {
    return { ok: false, reason: 'invalid_input', detail: 'proposal diff missing intent' };
  }

  // -------- 2. Dispatch on original intent -------------------------------
  let result: ApplyAvailabilityResult;

  if (stored.intent === 'create') {
    // Original inserted `window_after` — cancel it.
    if (!stored.window_after) {
      return { ok: false, reason: 'invalid_input', detail: 'create audit missing window_after' };
    }
    result = await applyCancelWindow({
      sb, userId,
      windowId: stored.window_after.id,
      now,
      rollbackOf: proposalId,
      triggeredBy: 'user_availability_rollback_create',
    });
  } else if (stored.intent === 'cancel') {
    // Original cancelled `window_before` — re-create it. This generates
    // a NEW row + new id; the old cancelled row stays for history.
    const before = stored.window_before;
    if (!before) {
      return { ok: false, reason: 'invalid_input', detail: 'cancel audit missing window_before' };
    }
    result = await applyCreateWindow({
      sb, userId,
      input: {
        starts_on: before.starts_on,
        ends_on: before.ends_on,
        kind: before.kind,
        strategy: before.strategy,
        note: before.note,
      },
      now,
      rollbackOf: proposalId,
      triggeredBy: 'user_availability_rollback_cancel',
    });
  } else if (stored.intent === 'modify') {
    // Swap: new state becomes old, old becomes new.
    if (!stored.window_before || !stored.window_after) {
      return { ok: false, reason: 'invalid_input', detail: 'modify audit missing before/after' };
    }
    const target = stored.window_before;
    result = await applyModifyWindow({
      sb, userId,
      windowId: target.id,
      patch: {
        starts_on: target.starts_on,
        ends_on: target.ends_on,
        strategy: target.strategy,
        note: target.note,
      },
      now,
      rollbackOf: proposalId,
      triggeredBy: 'user_availability_rollback_modify',
    });
  } else if (stored.intent === 'rollback') {
    // Rolling back a rollback — legal but discouraged; the UI should
    // dim this. We surface as `rollback_already_rolled_back` to avoid
    // infinite chains.
    return { ok: false, reason: 'rollback_already_rolled_back' };
  } else {
    return { ok: false, reason: 'invalid_input', detail: `unknown intent ${String(stored.intent)}` };
  }

  if (!result.ok) return result;

  // -------- 3. Mark the original as rolled_back --------------------------
  // Best-effort: if this fails, the rollback did apply — the UI just
  // won't disable the rollback button. We log and move on.
  const { error: markErr } = await sb
    .from('ai_proposals')
    .update({ status: 'rolled_back' })
    .eq('id', proposalId)
    .eq('user_id', userId)
    .eq('status', 'applied');
  if (markErr) {
    console.error('[availability/apply] mark rolled_back failed', markErr);
  }

  // Return the rollback result but re-label the intent for the caller.
  return { ...result, intent: 'rollback' };
}
