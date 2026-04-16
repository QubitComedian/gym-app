/**
 * Availability-window diff engine (P1.3 / PR-N).
 *
 * Pure logic that takes a user's existing plan rows plus an availability
 * window (travel / injury / pause) and produces the plan-row changes
 * needed to either APPLY the window at creation time, ROLL IT BACK on
 * cancellation, or MODIFY an existing window (change strategy, extend /
 * shorten the date range).
 *
 * Unlike the phase-transition and weekly-template engines — which produce
 * a proposal the user reviews and accepts before any rows change — the
 * availability-window diff is applied immediately at creation time. The
 * review step happens BEFORE the DB write (caller shows the diff; user
 * confirms; caller runs the apply). That's why this file returns the
 * concrete `{ creates, updates, deletes }` tuple rather than an
 * option-based proposal.
 *
 * Contract
 * --------
 *   - Range: creation diffs touch dates in [max(todayIso, starts_on), ends_on].
 *     Past dates are never rewritten. If the whole window is in the past,
 *     the diff is a no-op (returns ok with no ops + a clear rationale).
 *   - Preservation — a plan row is NEVER overwritten when ANY of:
 *       * status !== 'planned'           (history: done / missed / skipped / moved)
 *       * source === 'manual'            (user-placed)
 *       * source === 'ai_proposed'       (user accepted this one explicitly)
 *       * source === 'availability_window' AND window_id !== this.window
 *         (from a DIFFERENT window — shouldn't happen once we reject
 *         overlaps at create, but a defensive branch keeps rollback honest
 *         if the dataset ever drifts).
 *   - Today can be rewritten: status='planned' on today is just a
 *     template placeholder the reconciler put there; a travel/injury
 *     window the user declares today should absolutely apply to today.
 *   - Overlap: `buildCreateWindowDiff` and `buildModifyWindowDiff` reject
 *     when their effective range overlaps any OTHER active window. v1
 *     keeps the model simple — no stacked windows. Returned as
 *     `{ kind: 'error', error: 'overlaps_existing', conflicts }` so the
 *     UI can render the blockers.
 *   - Resolved 'suppress' strategy → the date holds NO row. Replaceable
 *     template rows are deleted; non-replaceable rows are preserved.
 *   - Cancellation rolls back by realigning each covered date to the
 *     template (weekly pattern + calendar events + phase context). If
 *     the template has no slot on a DOW → delete the window row. Rows
 *     whose source isn't the cancelled window's id are left alone.
 *   - Idempotent: running the same diff twice produces the same ops. If
 *     the world already matches the target state, the ops list is empty.
 *   - Updates are preferred over delete+create when a row exists on the
 *     date and needs to shift shape — keeps `plans.id` stable so the
 *     reconciler's parent_plan_id chain (if any) survives the transition.
 *
 * I/O wrapper lives in `diff.ts` (PR-O). This file must not import the
 * Supabase client, `Date.now()`, or any module-level state.
 */

import {
  activePhaseFor,
  addDaysIso,
  dowCodeOf,
  resolveWindowStrategy,
  type ActiveWindow,
  type AvailabilityWindowKind,
  type AvailabilityWindowStrategy,
  type CalendarEventRow,
  type PatternResolver,
  type PhaseRow,
  type ResolvedWindowStrategy,
  type WeeklyPattern,
  type WeeklySlot,
} from '@/lib/reconcile/rollForward.pure';

// -------- shapes -----------------------------------------------------

/**
 * Plan row as the availability diff sees it. Narrower than the DB row:
 * just what preservation + realignment need. `window_id` is surfaced so
 * we can tell "this window's row" from "some other window's row".
 */
export type ExistingPlan = {
  id: string;
  date: string;
  type: string;
  day_code: string | null;
  status: string;
  source: string;             // 'template' | 'availability_window' | 'manual' | 'ai_proposed' | ...
  phase_id: string | null;
  window_id: string | null;
  prescription: unknown;
  calendar_event_id: string | null;
};

/** A new plan row to insert on a date that had nothing planned. */
export type PlanCreate = {
  date: string;
  phase_id: string | null;
  type: string;
  day_code: string | null;
  prescription: unknown;
  calendar_event_id: string | null;
  status: 'planned';
  source: 'availability_window' | 'template';
  window_id: string | null;
  ai_rationale: string;
};

/** An update to an existing plan row. */
export type PlanUpdate = {
  plan_id: string;
  date: string;
  before: { type: string; day_code: string | null; source: string; window_id: string | null };
  after: { type: string; day_code: string | null; source: 'availability_window' | 'template' };
  patch: {
    type: string;
    day_code: string | null;
    prescription: unknown;
    calendar_event_id: string | null;
    phase_id: string | null;
    source: 'availability_window' | 'template';
    window_id: string | null;
    ai_rationale: string;
  };
};

/** A plan row to delete (only `status='planned'` rows end up here). */
export type PlanDelete = {
  plan_id: string;
  date: string;
  before: { type: string; day_code: string | null; source: string; window_id: string | null };
};

export type AvailabilityDiffSummary = {
  /** New rows inserted on previously-empty dates. */
  added: number;
  /** Template rows deleted ('suppress' strategy). */
  removed: number;
  /** Template rows reshaped into window rows (or window rows back into template rows). */
  changed: number;
  /** status !== 'planned' rows (logged activity, missed, skipped, moved). */
  skipped_logged: number;
  /** source='manual' rows. */
  skipped_manual: number;
  /** source='ai_proposed' rows. */
  skipped_ai_proposed: number;
  /** source='availability_window' from a DIFFERENT window. */
  skipped_other_window: number;
};

export type AvailabilityDiffOk = {
  kind: 'ok';
  intent: 'create' | 'cancel' | 'modify';
  window_id: string;
  /** The effective range this diff acts on (clipped to today for creates). */
  range: { start: string; end: string } | null;
  creates: PlanCreate[];
  updates: PlanUpdate[];
  deletes: PlanDelete[];
  summary: AvailabilityDiffSummary;
  rationale: string;
};

export type AvailabilityDiffError = {
  kind: 'error';
  error: 'overlaps_existing';
  /** The other active windows whose ranges intersect the proposed one. */
  conflicts: Array<{
    id: string;
    starts_on: string;
    ends_on: string;
    kind: AvailabilityWindowKind;
  }>;
};

export type AvailabilityDiff = AvailabilityDiffOk | AvailabilityDiffError;

// -------- overlap detection ------------------------------------------

/**
 * Do two inclusive date ranges [aStart, aEnd] and [bStart, bEnd]
 * overlap at all? Dates compare lexicographically in ISO form.
 */
export function rangesOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string
): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

/**
 * Find every OTHER active window whose range intersects [start, end].
 * `excludeId` is the window under consideration (for modify flows).
 */
export function findOverlappingWindows(args: {
  start: string;
  end: string;
  activeWindows: readonly ActiveWindow[];
  excludeId?: string;
}): ActiveWindow[] {
  const { start, end, activeWindows, excludeId } = args;
  const out: ActiveWindow[] = [];
  for (const w of activeWindows) {
    if (excludeId && w.id === excludeId) continue;
    if (rangesOverlap(start, end, w.starts_on, w.ends_on)) out.push(w);
  }
  return out;
}

// -------- preservation ------------------------------------------------

type PreserveReason =
  | 'logged'
  | 'manual'
  | 'ai_proposed'
  | 'other_window';

/**
 * Is this row off-limits for the availability diff?
 *
 * `thisWindowId` is the window the diff is operating on. Rows tagged
 * with a different window id are preserved — those belong to another
 * active window and this diff has no business touching them.
 */
export function preserveReasonFor(
  plan: ExistingPlan,
  thisWindowId: string
): PreserveReason | null {
  if (plan.status !== 'planned') return 'logged';
  if (plan.source === 'manual') return 'manual';
  if (plan.source === 'ai_proposed') return 'ai_proposed';
  if (plan.source === 'availability_window' && plan.window_id && plan.window_id !== thisWindowId) {
    return 'other_window';
  }
  return null;
}

function bumpSkipped(summary: AvailabilityDiffSummary, reason: PreserveReason): void {
  switch (reason) {
    case 'logged': summary.skipped_logged += 1; break;
    case 'manual': summary.skipped_manual += 1; break;
    case 'ai_proposed': summary.skipped_ai_proposed += 1; break;
    case 'other_window': summary.skipped_other_window += 1; break;
  }
}

// -------- builders for window-shaped + template-shaped targets --------

/**
 * The "shape" a date should have when the window applies to it.
 * Resolved strategy drives the shape:
 *   - 'rest'       → a rest row
 *   - 'bodyweight' → a bodyweight row
 *   - 'suppress'   → NO row (represented here by returning null)
 */
type WindowShape = {
  type: 'rest' | 'bodyweight';
  day_code: null;
  prescription: {};
  calendar_event_id: null;
  source: 'availability_window';
  window_id: string;
  phase_id: string | null;
  ai_rationale: string;
};

function windowShapeFor(args: {
  iso: string;
  window: ActiveWindow;
  resolved: ResolvedWindowStrategy;
  phase: PhaseRow | null;
}): WindowShape | null {
  const { window, resolved, phase } = args;
  if (resolved === 'suppress') return null;
  const noteTag = window.note ? ` (${window.note})` : '';
  const kindLabel =
    window.kind === 'travel' ? 'travel window'
    : window.kind === 'injury' ? 'injury window'
    : 'pause window';

  if (resolved === 'rest') {
    return {
      type: 'rest',
      day_code: null,
      prescription: {},
      calendar_event_id: null,
      source: 'availability_window',
      window_id: window.id,
      phase_id: phase?.id ?? null,
      ai_rationale: `Rest day — inside ${kindLabel}${noteTag}.`,
    };
  }
  // bodyweight
  return {
    type: 'bodyweight',
    day_code: null,
    prescription: {},
    calendar_event_id: null,
    source: 'availability_window',
    window_id: window.id,
    phase_id: phase?.id ?? null,
    ai_rationale: `Bodyweight session — inside ${kindLabel}${noteTag}.`,
  };
}

/**
 * The "shape" a date should have when NO window applies to it — i.e.
 * the template would put something here. Returns null when the template
 * says nothing should exist (no phase / no slot).
 */
type TemplateShape = {
  type: string;
  day_code: string | null;
  prescription: unknown;
  calendar_event_id: string | null;
  source: 'template';
  phase_id: string;
  ai_rationale: string;
};

function templateShapeFor(args: {
  iso: string;
  phase: PhaseRow | null;
  slot: WeeklySlot | undefined;
  binding: CalendarEventRow | null;
  rationaleNote: string;
}): TemplateShape | null {
  const { phase, slot, binding, rationaleNote } = args;
  if (!phase || !slot) return null;

  if (slot.type === 'rest') {
    return {
      type: 'rest',
      day_code: slot.day_code ?? null,
      prescription: {},
      calendar_event_id: null,
      source: 'template',
      phase_id: phase.id,
      ai_rationale: `${rationaleNote} Rest day per ${phase.code ?? '?'} weekly pattern.`,
    };
  }

  return {
    type: slot.type,
    day_code: slot.day_code ?? null,
    prescription: binding?.prescription ?? {},
    calendar_event_id: binding?.id ?? null,
    source: 'template',
    phase_id: phase.id,
    ai_rationale: binding
      ? `${rationaleNote} Bound to "${binding.summary ?? slot.day_code}" (phase ${phase.code ?? '?'}).`
      : `${rationaleNote} No calendar template yet for ${slot.day_code ?? slot.type} (phase ${phase.code ?? '?'}).`,
  };
}

function resolveBinding(opts: {
  phaseId: string;
  slot: WeeklySlot | undefined;
  eventsByPhaseDay: ReadonlyMap<string, CalendarEventRow>;
}): CalendarEventRow | null {
  const { phaseId, slot, eventsByPhaseDay } = opts;
  if (!slot || !slot.day_code || slot.type === 'rest') return null;
  return eventsByPhaseDay.get(`${phaseId}:${slot.day_code}`) ?? null;
}

function resolveTemplateForDate(args: {
  iso: string;
  phases: readonly PhaseRow[];
  weeklyPattern: PatternResolver;
  eventsByPhaseDay: ReadonlyMap<string, CalendarEventRow>;
}): { phase: PhaseRow | null; slot: WeeklySlot | undefined; binding: CalendarEventRow | null } {
  const { iso, phases, weeklyPattern, eventsByPhaseDay } = args;
  const phase = activePhaseFor(iso, phases);
  if (!phase) return { phase: null, slot: undefined, binding: null };
  const pattern = weeklyPattern instanceof Map
    ? weeklyPattern.get(phase.id) ?? null
    : (weeklyPattern as WeeklyPattern | null);
  if (!pattern) return { phase, slot: undefined, binding: null };
  const slot = pattern[dowCodeOf(iso)];
  const binding = resolveBinding({ phaseId: phase.id, slot, eventsByPhaseDay });
  return { phase, slot, binding };
}

// -------- enumeration + empty ---------------------------------------

/** Enumerate ISO dates in [start, end] inclusive. Capped at 400. */
export function enumerateDates(start: string, end: string): string[] {
  if (start > end) return [];
  const out: string[] = [];
  let cur = start;
  for (let i = 0; i < 400 && cur <= end; i += 1) {
    out.push(cur);
    cur = addDaysIso(cur, 1);
  }
  return out;
}

function zeroSummary(): AvailabilityDiffSummary {
  return {
    added: 0,
    removed: 0,
    changed: 0,
    skipped_logged: 0,
    skipped_manual: 0,
    skipped_ai_proposed: 0,
    skipped_other_window: 0,
  };
}

function emptyOk(args: {
  intent: 'create' | 'cancel' | 'modify';
  window_id: string;
  rationale: string;
}): AvailabilityDiffOk {
  return {
    kind: 'ok',
    intent: args.intent,
    window_id: args.window_id,
    range: null,
    creates: [],
    updates: [],
    deletes: [],
    summary: zeroSummary(),
    rationale: args.rationale,
  };
}

// -------- per-date op composition ------------------------------------

/**
 * Given a date's current plan row (if any) and the target shape, emit
 * zero or one op. Handles:
 *   - target null + no existing → no-op
 *   - target null + replaceable existing → delete
 *   - target shape + no existing → create
 *   - target shape + matching existing → no-op (idempotent)
 *   - target shape + differing existing → update (stable plan_id)
 */
function composeWindowOp(args: {
  iso: string;
  existing: ExistingPlan | null;
  target: WindowShape | null;
  ops: { creates: PlanCreate[]; updates: PlanUpdate[]; deletes: PlanDelete[] };
  summary: AvailabilityDiffSummary;
}): void {
  const { iso, existing, target, ops, summary } = args;

  // suppress → want no row
  if (!target) {
    if (!existing) return;
    // Replaceable template row on a suppressed date → delete.
    ops.deletes.push({
      plan_id: existing.id,
      date: iso,
      before: {
        type: existing.type,
        day_code: existing.day_code,
        source: existing.source,
        window_id: existing.window_id,
      },
    });
    summary.removed += 1;
    return;
  }

  // want a window-shaped row
  if (!existing) {
    ops.creates.push({
      date: iso,
      phase_id: target.phase_id,
      type: target.type,
      day_code: null,
      prescription: target.prescription,
      calendar_event_id: null,
      status: 'planned',
      source: 'availability_window',
      window_id: target.window_id,
      ai_rationale: target.ai_rationale,
    });
    summary.added += 1;
    return;
  }

  // Check idempotency: if the existing row already matches the target,
  // no op. Prescription equality is by reference / shallow — that's fine
  // because we always emit `{}` for window rows, so a second diff against
  // the same world will naturally match.
  const alreadyMatches =
    existing.source === 'availability_window'
    && existing.window_id === target.window_id
    && existing.type === target.type
    && existing.day_code === null
    && existing.status === 'planned';
  if (alreadyMatches) return;

  // Differing → update in place (keeps plan_id stable).
  ops.updates.push({
    plan_id: existing.id,
    date: iso,
    before: {
      type: existing.type,
      day_code: existing.day_code,
      source: existing.source,
      window_id: existing.window_id,
    },
    after: {
      type: target.type,
      day_code: null,
      source: 'availability_window',
    },
    patch: {
      type: target.type,
      day_code: null,
      prescription: target.prescription,
      calendar_event_id: null,
      phase_id: target.phase_id,
      source: 'availability_window',
      window_id: target.window_id,
      ai_rationale: target.ai_rationale,
    },
  });
  summary.changed += 1;
}

function composeTemplateOp(args: {
  iso: string;
  existing: ExistingPlan | null;
  target: TemplateShape | null;
  ops: { creates: PlanCreate[]; updates: PlanUpdate[]; deletes: PlanDelete[] };
  summary: AvailabilityDiffSummary;
}): void {
  const { iso, existing, target, ops, summary } = args;

  // target null → want no row (no phase / no slot on that DOW)
  if (!target) {
    if (!existing) return;
    // Replaceable window row on a date the template doesn't cover → delete.
    ops.deletes.push({
      plan_id: existing.id,
      date: iso,
      before: {
        type: existing.type,
        day_code: existing.day_code,
        source: existing.source,
        window_id: existing.window_id,
      },
    });
    summary.removed += 1;
    return;
  }

  // want a template-shaped row
  if (!existing) {
    ops.creates.push({
      date: iso,
      phase_id: target.phase_id,
      type: target.type,
      day_code: target.day_code,
      prescription: target.prescription,
      calendar_event_id: target.calendar_event_id,
      status: 'planned',
      source: 'template',
      window_id: null,
      ai_rationale: target.ai_rationale,
    });
    summary.added += 1;
    return;
  }

  const alreadyMatches =
    existing.source === 'template'
    && existing.type === target.type
    && (existing.day_code ?? null) === (target.day_code ?? null)
    && existing.calendar_event_id === target.calendar_event_id
    && existing.status === 'planned'
    && !existing.window_id;
  if (alreadyMatches) return;

  ops.updates.push({
    plan_id: existing.id,
    date: iso,
    before: {
      type: existing.type,
      day_code: existing.day_code,
      source: existing.source,
      window_id: existing.window_id,
    },
    after: {
      type: target.type,
      day_code: target.day_code,
      source: 'template',
    },
    patch: {
      type: target.type,
      day_code: target.day_code,
      prescription: target.prescription,
      calendar_event_id: target.calendar_event_id,
      phase_id: target.phase_id,
      source: 'template',
      window_id: null,
      ai_rationale: target.ai_rationale,
    },
  });
  summary.changed += 1;
}

// -------- entry point: create ---------------------------------------

export type BuildCreateWindowDiffArgs = {
  userId: string;
  todayIso: string;
  /** The window being created (assumed persisted or about-to-be; needs a real id). */
  window: ActiveWindow;
  /** OTHER active windows (excluding the one being created). */
  otherActiveWindows: readonly ActiveWindow[];
  plansByDate: ReadonlyMap<string, ExistingPlan>;
  phases: readonly PhaseRow[];
  weeklyPattern: PatternResolver;
  eventsByPhaseDay: ReadonlyMap<string, CalendarEventRow>;
};

/**
 * Apply the window at creation time. The effective range is clipped to
 * [max(today, starts_on), ends_on] — past dates are left untouched.
 *
 * Rejects (returns `{ kind: 'error', error: 'overlaps_existing' }`) when
 * the effective range intersects any other active window.
 */
export function buildCreateWindowDiff(
  args: BuildCreateWindowDiffArgs
): AvailabilityDiff {
  const { userId: _userId, todayIso, window, otherActiveWindows, plansByDate, phases, weeklyPattern, eventsByPhaseDay } = args;

  const effectiveStart = window.starts_on > todayIso ? window.starts_on : todayIso;
  const effectiveEnd = window.ends_on;

  if (effectiveStart > effectiveEnd) {
    return emptyOk({
      intent: 'create',
      window_id: window.id,
      rationale: 'Window is entirely in the past — nothing to apply.',
    });
  }

  // Reject overlaps in v1.
  const conflicts = findOverlappingWindows({
    start: effectiveStart,
    end: effectiveEnd,
    activeWindows: otherActiveWindows,
  });
  if (conflicts.length > 0) {
    return {
      kind: 'error',
      error: 'overlaps_existing',
      conflicts: conflicts.map(c => ({
        id: c.id,
        starts_on: c.starts_on,
        ends_on: c.ends_on,
        kind: c.kind,
      })),
    };
  }

  const resolved = resolveWindowStrategy(window.kind, window.strategy);
  const ops = { creates: [] as PlanCreate[], updates: [] as PlanUpdate[], deletes: [] as PlanDelete[] };
  const summary = zeroSummary();

  for (const iso of enumerateDates(effectiveStart, effectiveEnd)) {
    const existing = plansByDate.get(iso) ?? null;

    if (existing) {
      const reason = preserveReasonFor(existing, window.id);
      if (reason) {
        bumpSkipped(summary, reason);
        continue;
      }
    }

    const phase = activePhaseFor(iso, phases);
    const target = windowShapeFor({ iso, window, resolved, phase });
    composeWindowOp({ iso, existing, target, ops, summary });
  }

  return {
    kind: 'ok',
    intent: 'create',
    window_id: window.id,
    range: { start: effectiveStart, end: effectiveEnd },
    creates: ops.creates,
    updates: ops.updates,
    deletes: ops.deletes,
    summary,
    rationale: buildApplyRationale({ window, resolved, range: { start: effectiveStart, end: effectiveEnd }, summary }),
  };
}

// -------- entry point: cancel ---------------------------------------

export type BuildCancelWindowDiffArgs = {
  userId: string;
  todayIso: string;
  /** The window being cancelled. */
  window: ActiveWindow;
  plansByDate: ReadonlyMap<string, ExistingPlan>;
  phases: readonly PhaseRow[];
  weeklyPattern: PatternResolver;
  eventsByPhaseDay: ReadonlyMap<string, CalendarEventRow>;
};

/**
 * Roll a window back by realigning every covered date to the template.
 *
 * We only touch dates from [max(today, starts_on), ends_on] — dates in
 * the past stay put (a window day in the past is history; rewriting it
 * would confuse the user's log).
 *
 * Only rows with source='availability_window' AND window_id=this.window
 * are candidates. Everything else is preserved with a counted skip.
 */
export function buildCancelWindowDiff(
  args: BuildCancelWindowDiffArgs
): AvailabilityDiffOk {
  const { todayIso, window, plansByDate, phases, weeklyPattern, eventsByPhaseDay } = args;

  const effectiveStart = window.starts_on > todayIso ? window.starts_on : todayIso;
  const effectiveEnd = window.ends_on;

  if (effectiveStart > effectiveEnd) {
    return emptyOk({
      intent: 'cancel',
      window_id: window.id,
      rationale: 'Window already ended — nothing to roll back.',
    });
  }

  const ops = { creates: [] as PlanCreate[], updates: [] as PlanUpdate[], deletes: [] as PlanDelete[] };
  const summary = zeroSummary();

  for (const iso of enumerateDates(effectiveStart, effectiveEnd)) {
    const existing = plansByDate.get(iso) ?? null;

    if (existing) {
      // Rollback-specific preservation: we only touch OUR window's rows.
      //   - status !== 'planned' → preserve (logged)
      //   - source === 'manual' | 'ai_proposed' → preserve
      //   - source === 'availability_window' && window_id !== our id → preserve
      //   - source === 'template' → preserve (template rows aren't ours
      //     to rewrite; the window didn't leave them here)
      const reason = preserveReasonFor(existing, window.id);
      if (reason) {
        bumpSkipped(summary, reason);
        continue;
      }
      // At this point: planned, source∈{availability_window with OUR id,
      // template, ...}. For rollback we only realign OUR window's rows
      // — a template row sitting here is surprising (we wouldn't have
      // overwritten templates into window rows without also deleting
      // them) but the safe thing is to leave it.
      if (existing.source !== 'availability_window' || existing.window_id !== window.id) {
        // Not ours — leave alone, no counter (it's neither "ours to skip"
        // nor "preservation-countable"; it's simply unrelated).
        continue;
      }
    }

    // Realign to template shape.
    const { phase, slot, binding } = resolveTemplateForDate({
      iso, phases, weeklyPattern, eventsByPhaseDay,
    });
    const target = templateShapeFor({
      iso, phase, slot, binding,
      rationaleNote: `Restored by cancelling ${labelFor(window.kind)} window.`,
    });
    composeTemplateOp({ iso, existing, target, ops, summary });
  }

  return {
    kind: 'ok',
    intent: 'cancel',
    window_id: window.id,
    range: { start: effectiveStart, end: effectiveEnd },
    creates: ops.creates,
    updates: ops.updates,
    deletes: ops.deletes,
    summary,
    rationale: buildRollbackRationale({ window, range: { start: effectiveStart, end: effectiveEnd }, summary }),
  };
}

// -------- entry point: modify ---------------------------------------

export type BuildModifyWindowDiffArgs = {
  userId: string;
  todayIso: string;
  /** The window in its CURRENT persisted state. */
  oldWindow: ActiveWindow;
  /** The window as it SHOULD be after the modification. Same id, possibly
   *  different starts_on / ends_on / strategy. Kind is immutable by
   *  contract (change-kind is really a cancel + create). */
  newWindow: ActiveWindow;
  /** OTHER active windows (excluding this one under its id). */
  otherActiveWindows: readonly ActiveWindow[];
  plansByDate: ReadonlyMap<string, ExistingPlan>;
  phases: readonly PhaseRow[];
  weeklyPattern: PatternResolver;
  eventsByPhaseDay: ReadonlyMap<string, CalendarEventRow>;
};

/**
 * Modify an existing window in place. Supports:
 *   - date range shrinking  (some covered dates roll back to template)
 *   - date range extending  (some new dates get window rows applied)
 *   - strategy change       (covered dates reshape rest↔bodyweight↔suppress)
 *   - any combination of the above
 *
 * Semantics: for every date in (oldRange ∪ newRange) clipped to today..∞,
 *   - if the date falls in newRange → target = newWindow shape
 *   - else (date is in oldRange only) → target = template shape
 *
 * Kind changes are NOT supported — callers should cancel the old window
 * and create a new one with a fresh id. Enforced by a runtime error if
 * old.kind !== new.kind.
 *
 * Rejects overlap with OTHER active windows (same rule as create).
 */
export function buildModifyWindowDiff(
  args: BuildModifyWindowDiffArgs
): AvailabilityDiff {
  const { todayIso, oldWindow, newWindow, otherActiveWindows, plansByDate, phases, weeklyPattern, eventsByPhaseDay } = args;

  if (oldWindow.id !== newWindow.id) {
    throw new Error('buildModifyWindowDiff: window ids must match (cancel+create to change id)');
  }
  if (oldWindow.kind !== newWindow.kind) {
    throw new Error('buildModifyWindowDiff: window kind is immutable (cancel+create to change kind)');
  }

  const newEffStart = newWindow.starts_on > todayIso ? newWindow.starts_on : todayIso;
  const newEffEnd = newWindow.ends_on;
  const oldEffStart = oldWindow.starts_on > todayIso ? oldWindow.starts_on : todayIso;
  const oldEffEnd = oldWindow.ends_on;

  // Reject overlaps between the NEW range and other active windows.
  if (newEffStart <= newEffEnd) {
    const conflicts = findOverlappingWindows({
      start: newEffStart,
      end: newEffEnd,
      activeWindows: otherActiveWindows,
      excludeId: newWindow.id,
    });
    if (conflicts.length > 0) {
      return {
        kind: 'error',
        error: 'overlaps_existing',
        conflicts: conflicts.map(c => ({
          id: c.id,
          starts_on: c.starts_on,
          ends_on: c.ends_on,
          kind: c.kind,
        })),
      };
    }
  }

  // Union the two effective ranges. If either range is entirely in the
  // past, treat it as empty (start > end).
  const ranges: Array<{ start: string; end: string }> = [];
  if (oldEffStart <= oldEffEnd) ranges.push({ start: oldEffStart, end: oldEffEnd });
  if (newEffStart <= newEffEnd) ranges.push({ start: newEffStart, end: newEffEnd });

  if (ranges.length === 0) {
    return emptyOk({
      intent: 'modify',
      window_id: newWindow.id,
      rationale: 'Window is entirely in the past — no future dates to update.',
    });
  }

  const unionStart = ranges.reduce((a, r) => (r.start < a ? r.start : a), ranges[0].start);
  const unionEnd = ranges.reduce((a, r) => (r.end > a ? r.end : a), ranges[0].end);

  const resolvedNew = resolveWindowStrategy(newWindow.kind, newWindow.strategy);
  const ops = { creates: [] as PlanCreate[], updates: [] as PlanUpdate[], deletes: [] as PlanDelete[] };
  const summary = zeroSummary();

  for (const iso of enumerateDates(unionStart, unionEnd)) {
    const inNew = newEffStart <= newEffEnd && iso >= newEffStart && iso <= newEffEnd;
    const inOld = oldEffStart <= oldEffEnd && iso >= oldEffStart && iso <= oldEffEnd;
    if (!inNew && !inOld) continue; // gap between two disjoint ranges — untouched

    const existing = plansByDate.get(iso) ?? null;

    if (existing) {
      // Preservation applies the same way whether we're applying or
      // rolling back on this date — logged / manual / ai_proposed /
      // other-window rows are all off-limits.
      const reason = preserveReasonFor(existing, newWindow.id);
      if (reason) {
        bumpSkipped(summary, reason);
        continue;
      }
    }

    if (inNew) {
      // Target: new window shape
      const phase = activePhaseFor(iso, phases);
      const target = windowShapeFor({ iso, window: newWindow, resolved: resolvedNew, phase });
      composeWindowOp({ iso, existing, target, ops, summary });
      continue;
    }

    // inOld but not inNew → this date is leaving coverage. Roll back
    // (but only if the row is ours — don't touch templates that somehow
    // survived).
    if (existing && (existing.source !== 'availability_window' || existing.window_id !== oldWindow.id)) {
      continue;
    }
    const { phase, slot, binding } = resolveTemplateForDate({
      iso, phases, weeklyPattern, eventsByPhaseDay,
    });
    const target = templateShapeFor({
      iso, phase, slot, binding,
      rationaleNote: `Restored after shortening ${labelFor(oldWindow.kind)} window.`,
    });
    composeTemplateOp({ iso, existing, target, ops, summary });
  }

  return {
    kind: 'ok',
    intent: 'modify',
    window_id: newWindow.id,
    range: { start: unionStart, end: unionEnd },
    creates: ops.creates,
    updates: ops.updates,
    deletes: ops.deletes,
    summary,
    rationale: buildModifyRationale({ oldWindow, newWindow, resolvedNew, summary }),
  };
}

// -------- rationales -------------------------------------------------

function labelFor(kind: AvailabilityWindowKind): string {
  return kind === 'travel' ? 'travel' : kind === 'injury' ? 'injury' : 'pause';
}

function describeStrategy(resolved: ResolvedWindowStrategy): string {
  if (resolved === 'rest') return 'rest days';
  if (resolved === 'bodyweight') return 'bodyweight sessions';
  return 'blank days'; // suppress
}

function scopeFragment(summary: AvailabilityDiffSummary): string {
  const parts: string[] = [];
  if (summary.added) parts.push(`${summary.added} added`);
  if (summary.changed) parts.push(`${summary.changed} reshaped`);
  if (summary.removed) parts.push(`${summary.removed} cleared`);
  return parts.length > 0 ? parts.join(' · ') : 'no plan rows affected';
}

function preservedFragment(summary: AvailabilityDiffSummary): string {
  const parts: string[] = [];
  if (summary.skipped_logged) parts.push(`${summary.skipped_logged} logged`);
  if (summary.skipped_manual) parts.push(`${summary.skipped_manual} manual`);
  if (summary.skipped_ai_proposed) parts.push(`${summary.skipped_ai_proposed} AI-proposed`);
  if (summary.skipped_other_window) parts.push(`${summary.skipped_other_window} other-window`);
  return parts.length > 0 ? ` — preserving ${parts.join(', ')}` : '';
}

function buildApplyRationale(opts: {
  window: ActiveWindow;
  resolved: ResolvedWindowStrategy;
  range: { start: string; end: string };
  summary: AvailabilityDiffSummary;
}): string {
  const { window, resolved, range, summary } = opts;
  return (
    `Applying ${labelFor(window.kind)} window (${describeStrategy(resolved)}) from ${range.start} to ${range.end}: `
    + `${scopeFragment(summary)}${preservedFragment(summary)}.`
  );
}

function buildRollbackRationale(opts: {
  window: ActiveWindow;
  range: { start: string; end: string };
  summary: AvailabilityDiffSummary;
}): string {
  const { window, range, summary } = opts;
  return (
    `Cancelling ${labelFor(window.kind)} window and restoring the template from ${range.start} to ${range.end}: `
    + `${scopeFragment(summary)}${preservedFragment(summary)}.`
  );
}

function buildModifyRationale(opts: {
  oldWindow: ActiveWindow;
  newWindow: ActiveWindow;
  resolvedNew: ResolvedWindowStrategy;
  summary: AvailabilityDiffSummary;
}): string {
  const { oldWindow, newWindow, resolvedNew, summary } = opts;
  const rangeChanged =
    oldWindow.starts_on !== newWindow.starts_on || oldWindow.ends_on !== newWindow.ends_on;
  const stratChanged = oldWindow.strategy !== newWindow.strategy;
  const what =
    rangeChanged && stratChanged
      ? `Rescoping and reshaping ${labelFor(newWindow.kind)} window to ${describeStrategy(resolvedNew)}, ${newWindow.starts_on}–${newWindow.ends_on}`
      : rangeChanged
      ? `Rescoping ${labelFor(newWindow.kind)} window to ${newWindow.starts_on}–${newWindow.ends_on}`
      : stratChanged
      ? `Reshaping ${labelFor(newWindow.kind)} window to ${describeStrategy(resolvedNew)}`
      : `Reconciling ${labelFor(newWindow.kind)} window`;
  return `${what}: ${scopeFragment(summary)}${preservedFragment(summary)}.`;
}

// -------- re-exports for convenience ---------------------------------

export type {
  ActiveWindow,
  AvailabilityWindowKind,
  AvailabilityWindowStrategy,
  ResolvedWindowStrategy,
  PhaseRow,
  WeeklyPattern,
  CalendarEventRow,
};
