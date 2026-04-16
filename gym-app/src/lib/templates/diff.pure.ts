/**
 * Template diff engine (P1.1 / PR-F).
 *
 * Pure logic that compares a user's current weekly pattern with a new
 * one they're proposing, then produces the plan-row changes needed to
 * bring the future window into alignment with the new shape.
 *
 * Contract (from docs/p1-0-implementation.md + P1.1 plan):
 *   - Window: [today+1, today+28] ∩ [phase.starts_on, phase.target_ends_on]
 *   - Today's plan is never touched.
 *   - Only `status='planned'` rows are updated/deleted. Done/missed/
 *     skipped/moved rows are preserved as history.
 *   - `source='ai_proposed'` rows are skipped AND counted — the user
 *     accepted those explicitly, and a template edit shouldn't quietly
 *     throw them away.
 *   - `source='availability_window'` rows are skipped AND counted (P1.3).
 *     Travel / injury / pause windows are user-declared; a weekly
 *     template edit must never overwrite them. They roll back out the
 *     way they came in — via rollback of the availability_change
 *     proposal, not a template change.
 *   - `source='manual'` rows are skipped AND counted — the user placed
 *     them deliberately; a template edit shouldn't wipe a manual
 *     override. (Pre-P1.3 this case was unreachable because the editor
 *     only runs against template rows; adding the branch preemptively
 *     now keeps the engine safe as manual placement grows.)
 *   - Same (type, day_code) on both sides → no-op (prescription refresh
 *     only if the calendar_event prescription actually changed).
 *   - Null / missing slot for a given DOW → any future planned row on
 *     that DOW becomes a delete. (With the P1.1 editor UX this is only
 *     reachable via API; the editor itself uses `rest` for off days.)
 *   - Orphan day_code (new slot references a day_code with no matching
 *     calendar_event): emit a placeholder row with empty prescription
 *     and flag it in `summary.orphan_day_codes` for the review UI.
 *   - Idempotent: running the same diff twice produces the same ops.
 *
 * Output shape matches what the apply path + review UI both need.
 */
import {
  activePhaseFor,
  addDaysIso,
  dowCodeOf,
  type CalendarEventRow,
  type PhaseRow,
  type WeeklyPattern,
  type WeeklySlot,
} from '@/lib/reconcile/rollForward.pure';

// The window we touch: tomorrow through today+28.
export const TEMPLATE_APPLY_WINDOW_DAYS = 28;

/** A plan row as we see it at diff time. Narrower than the DB schema. */
export type ExistingPlan = {
  id: string;
  date: string;
  type: string;
  day_code: string | null;
  status: string;            // 'planned' | 'done' | 'missed' | 'skipped' | 'moved' | ...
  source: string;            // 'calendar' | 'template' | 'ai_proposed' | 'manual'
  prescription: unknown;
  calendar_event_id: string | null;
};

/** A single update to an existing plan row. */
export type PlanUpdate = {
  plan_id: string;
  /** Keep the original date — useful for review UI row labels. */
  date: string;
  /** Prior (type, day_code) for review display. */
  before: { type: string; day_code: string | null };
  /** New state. */
  after: { type: string; day_code: string | null };
  patch: {
    type: string;
    day_code: string | null;
    prescription: unknown;
    calendar_event_id: string | null;
    source: 'template';
    ai_rationale: string;
  };
};

/** A new plan row to insert for a date that had nothing planned. */
export type PlanCreate = {
  date: string;
  phase_id: string;
  type: string;
  day_code: string | null;
  prescription: unknown;
  calendar_event_id: string | null;
  source: 'template';
  status: 'planned';
  ai_rationale: string;
  /** True when the new slot has a day_code with no calendar_event row. */
  is_orphan: boolean;
};

/** A plan row to delete (only `status='planned'` rows end up here). */
export type PlanDelete = {
  plan_id: string;
  date: string;
  /** Prior (type, day_code) for review display. */
  before: { type: string; day_code: string | null };
};

export type TemplateDiffSummary = {
  /** New plan rows being inserted. */
  added: number;
  /** Existing rows being deleted (DOW dropped from pattern). */
  removed: number;
  /** Existing rows whose shape changes. */
  changed: number;
  /** AI-proposed rows the diff left alone. */
  skipped_ai_proposed: number;
  /** P1.3 — rows inside a travel/injury/pause window. */
  skipped_availability_window: number;
  /** P1.3 — user-placed manual rows (preserved preemptively). */
  skipped_manual: number;
  /** Dates where the new pattern references a day_code with no template yet. */
  orphan_day_codes: Array<{ date: string; day_code: string }>;
};

export type TemplateDiff = {
  phase_id: string;
  before: WeeklyPattern;
  after: WeeklyPattern;
  /** ISO window actually affected (clipped to phase bounds). */
  window: { start: string; end: string };
  updates: PlanUpdate[];
  creates: PlanCreate[];
  deletes: PlanDelete[];
  summary: TemplateDiffSummary;
  rationale: string;
};

// -------- slot utilities ---------------------------------------------

/**
 * Slot equality. Missing + `type='rest'` with null day_code are both
 * treated as "no training", but we still differentiate them: a `rest`
 * slot creates a rest plan row; a missing slot deletes the plan row.
 */
export function slotsEqual(
  a: WeeklySlot | undefined,
  b: WeeklySlot | undefined
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.type === b.type && (a.day_code ?? null) === (b.day_code ?? null);
}

// -------- window construction ----------------------------------------

/**
 * Clip [today+1, today+28] to [phase.starts_on, phase.target_ends_on].
 * Returns null when the intersection is empty (phase already ended, or
 * phase starts far in the future).
 */
export function templateApplyWindow(opts: {
  todayIso: string;
  phase: PhaseRow;
  days?: number;
}): { start: string; end: string } | null {
  const days = opts.days ?? TEMPLATE_APPLY_WINDOW_DAYS;
  const desiredStart = addDaysIso(opts.todayIso, 1);
  const desiredEnd = addDaysIso(opts.todayIso, days);

  if (!opts.phase.starts_on) return null;

  const start = desiredStart > opts.phase.starts_on ? desiredStart : opts.phase.starts_on;
  const end =
    opts.phase.target_ends_on && opts.phase.target_ends_on < desiredEnd
      ? opts.phase.target_ends_on
      : desiredEnd;

  if (start > end) return null;
  return { start, end };
}

/** Enumerate ISO dates in [start, end] inclusive. */
export function datesInRange(start: string, end: string): string[] {
  const out: string[] = [];
  let cur = start;
  // Guard against runaway loops — phases never exceed 6 months; cap at
  // ~400 days.
  for (let i = 0; i < 400 && cur <= end; i += 1) {
    out.push(cur);
    cur = addDaysIso(cur, 1);
  }
  return out;
}

// -------- main diff --------------------------------------------------

export type BuildTemplateDiffArgs = {
  todayIso: string;
  phase: PhaseRow;
  /** All phases — used so we can double-check each date still lands in `phase`. */
  allPhases?: readonly PhaseRow[];
  before: WeeklyPattern;
  after: WeeklyPattern;
  /** Plans in the affected window, keyed by date. Caller dedupes versioning. */
  plansByDate: ReadonlyMap<string, ExistingPlan>;
  /** Calendar events keyed `phase_id:day_code` for prescription binding. */
  eventsByPhaseDay: ReadonlyMap<string, CalendarEventRow>;
  /** Optional window override (testing). */
  windowDays?: number;
};

/**
 * Compute the diff between `before` and `after` for the given phase.
 */
export function buildTemplateDiff(args: BuildTemplateDiffArgs): TemplateDiff {
  const { todayIso, phase, before, after, plansByDate, eventsByPhaseDay, allPhases } = args;
  const phases = allPhases ?? [phase];

  const window = templateApplyWindow({ todayIso, phase, days: args.windowDays });
  const updates: PlanUpdate[] = [];
  const creates: PlanCreate[] = [];
  const deletes: PlanDelete[] = [];
  const summary: TemplateDiffSummary = {
    added: 0,
    removed: 0,
    changed: 0,
    skipped_ai_proposed: 0,
    skipped_availability_window: 0,
    skipped_manual: 0,
    orphan_day_codes: [],
  };

  if (!window) {
    return {
      phase_id: phase.id,
      before,
      after,
      window: { start: todayIso, end: todayIso },
      updates,
      creates,
      deletes,
      summary,
      rationale: 'Phase already complete — no future dates to update.',
    };
  }

  const dates = datesInRange(window.start, window.end);

  for (const iso of dates) {
    // Guard: make sure the date still resolves to this phase. If the
    // user has a gap between phases, we can run past this phase's end
    // even within the 28-day window — `templateApplyWindow` already
    // clips to phase.target_ends_on, but a defensive check keeps us
    // honest if phase ranges are edited concurrently.
    const active = activePhaseFor(iso, phases);
    if (!active || active.id !== phase.id) continue;

    const dow = dowCodeOf(iso);
    const oldSlot = before[dow];
    const newSlot = after[dow];
    const existing = plansByDate.get(iso) ?? null;

    // Guard: AI-proposed rows are preserved regardless of what the
    // template says. The user accepted them explicitly.
    if (existing && existing.source === 'ai_proposed') {
      summary.skipped_ai_proposed += 1;
      continue;
    }

    // Guard (P1.3): availability-window rows (travel/injury/pause) are
    // user-declared. A template edit never overwrites them — they roll
    // back out via availability-change proposal rollback instead.
    if (existing && existing.source === 'availability_window') {
      summary.skipped_availability_window += 1;
      continue;
    }

    // Guard: manually-placed rows are user commits. Preemptive today;
    // manual placement is a recognized source and will grow with later
    // PRs (drag-drop reschedule, inline add).
    if (existing && existing.source === 'manual' && existing.status === 'planned') {
      summary.skipped_manual += 1;
      continue;
    }

    // Only `planned` rows are candidates for mutation. Past activity
    // states (done/missed/skipped/moved) are history and never touched.
    const existingIsPlanned = existing && existing.status === 'planned';

    // Resolve calendar_event for the new slot (if any).
    const newBinding = resolveBinding({
      phaseId: phase.id,
      slot: newSlot,
      eventsByPhaseDay,
    });

    // ---- Case 1: no slot on either side → nothing to do.
    if (!oldSlot && !newSlot) continue;

    // ---- Case 2: slot removed.
    if (oldSlot && !newSlot) {
      if (existingIsPlanned) {
        deletes.push({
          plan_id: existing!.id,
          date: iso,
          before: { type: existing!.type, day_code: existing!.day_code },
        });
        summary.removed += 1;
      }
      continue;
    }

    // ---- Case 3: slot added.
    if (!oldSlot && newSlot) {
      if (existingIsPlanned) {
        // Weird edge: the template said this DOW had no session before,
        // but a plan row exists anyway (maybe left over from a seed).
        // Replace it rather than stack two plans on the same day.
        updates.push({
          plan_id: existing!.id,
          date: iso,
          before: { type: existing!.type, day_code: existing!.day_code },
          after: { type: newSlot.type, day_code: newSlot.day_code ?? null },
          patch: buildPatch({ slot: newSlot, binding: newBinding, phaseCode: phase.code }),
        });
        summary.changed += 1;
      } else if (!existing) {
        creates.push(
          buildCreate({ iso, phase, slot: newSlot, binding: newBinding })
        );
        summary.added += 1;
      }
      // else: existing is done/missed/etc — preserve. No new row.
      if (newSlot.day_code && !newBinding) {
        summary.orphan_day_codes.push({ date: iso, day_code: newSlot.day_code });
      }
      continue;
    }

    // ---- Case 4: slot present on both sides.
    //     Same shape → skip. Different → update (if planned) or create.
    if (oldSlot && newSlot) {
      if (slotsEqual(oldSlot, newSlot)) continue;

      if (existingIsPlanned) {
        updates.push({
          plan_id: existing!.id,
          date: iso,
          before: { type: existing!.type, day_code: existing!.day_code },
          after: { type: newSlot.type, day_code: newSlot.day_code ?? null },
          patch: buildPatch({ slot: newSlot, binding: newBinding, phaseCode: phase.code }),
        });
        summary.changed += 1;
      } else if (!existing) {
        creates.push(
          buildCreate({ iso, phase, slot: newSlot, binding: newBinding })
        );
        summary.added += 1;
      }
      if (newSlot.day_code && !newBinding) {
        summary.orphan_day_codes.push({ date: iso, day_code: newSlot.day_code });
      }
    }
  }

  return {
    phase_id: phase.id,
    before,
    after,
    window,
    updates,
    creates,
    deletes,
    summary,
    rationale: buildRationale(summary, phase.code ?? null),
  };
}

// -------- helpers -----------------------------------------------------

function resolveBinding(opts: {
  phaseId: string;
  slot: WeeklySlot | undefined;
  eventsByPhaseDay: ReadonlyMap<string, CalendarEventRow>;
}): CalendarEventRow | null {
  const { phaseId, slot, eventsByPhaseDay } = opts;
  if (!slot || !slot.day_code || slot.type === 'rest') return null;
  return eventsByPhaseDay.get(`${phaseId}:${slot.day_code}`) ?? null;
}

function buildPatch(opts: {
  slot: WeeklySlot;
  binding: CalendarEventRow | null;
  phaseCode: string | null;
}): PlanUpdate['patch'] {
  const { slot, binding, phaseCode } = opts;
  const phaseTag = phaseCode ?? '?';
  // Rest slots always carry empty prescription.
  if (slot.type === 'rest') {
    return {
      type: 'rest',
      day_code: slot.day_code ?? null,
      prescription: {},
      calendar_event_id: null,
      source: 'template',
      ai_rationale: `Updated by weekly-template edit — now a rest day (phase ${phaseTag}).`,
    };
  }

  return {
    type: slot.type,
    day_code: slot.day_code ?? null,
    prescription: binding?.prescription ?? {},
    calendar_event_id: binding?.id ?? null,
    source: 'template',
    ai_rationale: binding
      ? `Updated by weekly-template edit — bound to "${binding.summary ?? slot.day_code}" (phase ${phaseTag}).`
      : `Updated by weekly-template edit — ${slot.day_code ?? slot.type} has no calendar template yet (phase ${phaseTag}).`,
  };
}

function buildCreate(opts: {
  iso: string;
  phase: PhaseRow;
  slot: WeeklySlot;
  binding: CalendarEventRow | null;
}): PlanCreate {
  const { iso, phase, slot, binding } = opts;
  const phaseTag = phase.code ?? '?';

  if (slot.type === 'rest') {
    return {
      date: iso,
      phase_id: phase.id,
      type: 'rest',
      day_code: slot.day_code ?? null,
      prescription: {},
      calendar_event_id: null,
      source: 'template',
      status: 'planned',
      ai_rationale: `Added by weekly-template edit — rest day (phase ${phaseTag}).`,
      is_orphan: false,
    };
  }

  return {
    date: iso,
    phase_id: phase.id,
    type: slot.type,
    day_code: slot.day_code ?? null,
    prescription: binding?.prescription ?? {},
    calendar_event_id: binding?.id ?? null,
    source: 'template',
    status: 'planned',
    ai_rationale: binding
      ? `Added by weekly-template edit — bound to "${binding.summary ?? slot.day_code}" (phase ${phaseTag}).`
      : `Added by weekly-template edit — ${slot.day_code ?? slot.type} has no calendar template yet (phase ${phaseTag}).`,
    is_orphan: Boolean(slot.day_code) && !binding,
  };
}

function buildRationale(
  summary: TemplateDiffSummary,
  phaseCode: string | null
): string {
  const phaseTag = phaseCode ? `phase ${phaseCode}` : 'current phase';
  const parts: string[] = [];
  if (summary.changed) parts.push(`${summary.changed} changed`);
  if (summary.added) parts.push(`${summary.added} added`);
  if (summary.removed) parts.push(`${summary.removed} removed`);
  const scope = parts.length > 0 ? parts.join(' · ') : 'no future sessions affected';
  const preserved: string[] = [];
  if (summary.skipped_ai_proposed) {
    preserved.push(`${summary.skipped_ai_proposed} AI-proposed session${summary.skipped_ai_proposed === 1 ? '' : 's'} preserved`);
  }
  if (summary.skipped_availability_window) {
    preserved.push(`${summary.skipped_availability_window} availability-window day${summary.skipped_availability_window === 1 ? '' : 's'} preserved`);
  }
  if (summary.skipped_manual) {
    preserved.push(`${summary.skipped_manual} manual session${summary.skipped_manual === 1 ? '' : 's'} preserved`);
  }
  const preservedTxt = preserved.length > 0 ? ` — ${preserved.join('; ')}` : '';
  return `Weekly shape updated for ${phaseTag}: ${scope}${preservedTxt}.`;
}
