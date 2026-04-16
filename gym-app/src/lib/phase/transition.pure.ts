/**
 * Phase-transition diff engine (P1.2 / PR-I).
 *
 * Pure logic that inspects the user's current phase against `today` and
 * — when the phase is ending soon, ending today, or already overdue —
 * produces an option-based proposal the UI can present: transition to
 * the next phase, extend the current phase, end the current phase, or
 * reassess with Claude.
 *
 * Contract
 * --------
 *   - Window we touch: (today, today + 21] (today is NEVER rewritten —
 *     the user is presumably about to log or has already planned today).
 *   - Preservation rules — a plan row is untouched when ANY of:
 *       * status !== 'planned'              (history: done / missed / skipped / moved)
 *       * source === 'manual'               (user-placed)
 *       * source === 'ai_proposed'          (user already accepted this one)
 *       * source === 'availability_window'  (P1.3 — travel/injury/pause window,
 *                                            user-declared, never silently
 *                                            overwritten by a phase switch)
 *       * phase_id !== old_phase.id         (already claimed by another phase)
 *     Otherwise the row is a template-generated placeholder and is
 *     replaceable.
 *   - Tier: 'hard' if `today >= phase.target_ends_on`, 'soft' if the
 *     target is in [today+1, today+7]. Phases ending further out don't
 *     get a proposal yet — the next reconcile pass will pick them up
 *     when they slide into range.
 *   - Default option:
 *       * `transition` — when a next phase exists AND has a non-empty
 *                        weekly pattern AND at least one day_code binds
 *                        to a calendar_event (otherwise the diff would
 *                        be all orphans, which is a worse UX than
 *                        extending for a week).
 *       * `extend_2w`  — fallback when no usable next phase.
 *   - Orphans: slots whose day_code has no calendar_event for the next
 *     phase still create placeholder plans (mirroring the template-diff
 *     behavior) but are surfaced in `summary.orphan_day_codes` so the
 *     review UI can warn the user.
 *   - Idempotent: running the same diff twice produces the same ops,
 *     provided the underlying data hasn't changed.
 *
 * I/O wrapper lives in transition.ts. This file must not import the
 * Supabase client, `Date.now()`, or any module-level state.
 */

import {
  addDaysIso,
  dowCodeOf,
  type CalendarEventRow,
  type PhaseRow,
  type WeeklyPattern,
  type WeeklySlot,
} from '@/lib/reconcile/rollForward.pure';
import { daysBetweenIso } from '@/lib/reconcile/dropOff.pure';

// -------- thresholds --------------------------------------------------

/** How many future days the transition diff spans. */
export const PHASE_TRANSITION_WINDOW_DAYS = 21;

/**
 * Proposals fire when target_ends_on is within [today+1, today+7]
 * (soft) or <= today (hard). Beyond 7 days, we wait — the user doesn't
 * need to see a transition card weeks in advance.
 */
export const SOFT_TIER_WINDOW_DAYS = 7;

/** Extend presets the UI exposes as three discrete options. */
export const EXTEND_1W_DAYS = 7;
export const EXTEND_2W_DAYS = 14;
export const EXTEND_4W_DAYS = 28;

// -------- shared shapes ----------------------------------------------

export type PhaseTransitionTier = 'soft' | 'hard';

export type PhaseTransitionOptionId =
  | 'transition'
  | 'extend_1w'
  | 'extend_2w'
  | 'extend_4w'
  | 'reassess'
  | 'end_phase';

/**
 * Plan row as the transition engine sees it. A narrower view of the DB
 * schema — just what the preservation / delete decision needs.
 */
export type ExistingPlan = {
  id: string;
  date: string;
  type: string;
  day_code: string | null;
  phase_id: string | null;
  status: string;      // 'planned' | 'done' | 'missed' | 'skipped' | 'moved' | ...
  source: string;      // 'template' | 'seed' | 'calendar' | 'manual' | 'ai_proposed' | ...
};

/** A new plan row to insert on the new phase. */
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
  /** True when the slot references a day_code that has no calendar_event yet. */
  is_orphan: boolean;
};

/** A plan row to delete (only replaceable rows end up here). */
export type PlanDelete = {
  plan_id: string;
  date: string;
  before: { type: string; day_code: string | null };
};

/**
 * A patch applied to a phase row as part of a transition option.
 * Every field is optional so extend vs. transition vs. end can share
 * the same shape. The apply path translates this into a Supabase
 * `update(...)` on the `phases` table.
 */
export type PhasePatch = {
  status?: 'upcoming' | 'active' | 'completed' | 'abandoned';
  starts_on?: string;
  target_ends_on?: string;
  actual_ends_on?: string | null;
};

export type PhaseUpdate = {
  phase_id: string;
  patch: PhasePatch;
};

export type PhaseTransitionSummary = {
  /** New plan rows inserted in the forward window. */
  added: number;
  /** Planned placeholders from the old phase that get deleted. */
  removed: number;
  /** Currently always 0 — transition replaces rather than edits. */
  changed: number;
  /** Logged / manual / ai_proposed / availability_window rows left alone. */
  skipped_logged: number;
  skipped_manual: number;
  skipped_ai_proposed: number;
  /** P1.3 — rows tagged source='availability_window' (travel/injury/pause). */
  skipped_availability_window: number;
  /** Slots in the new phase referencing day_codes with no calendar_event yet. */
  orphan_day_codes: Array<{ date: string; day_code: string }>;
  /** New target_ends_on after the option applies, if different. */
  new_target_ends_on?: string;
};

/**
 * A single option within a phase_transition proposal. The apply path
 * picks one by id, then replays `phase_updates` + `plan_diff` atomically.
 */
export type PhaseTransitionOption = {
  id: PhaseTransitionOptionId;
  label: string;
  description: string;
  cta_label: string;
  recommended: boolean;
  phase_updates: PhaseUpdate[];
  plan_diff: {
    creates: PlanCreate[];
    deletes: PlanDelete[];
    updates: []; // reserved — transition always replaces, never edits
  };
  summary: PhaseTransitionSummary;
  /** UI hint: for 'reassess' we redirect to /check-in instead of applying a diff. */
  action?: 'reassess' | 'end';
  rationale: string;
};

export type PhaseTransitionProposal = {
  kind: 'phase_transition';
  phase_id: string;
  phase_code: string | null;
  phase_name: string | null;
  next_phase_id: string | null;
  next_phase_code: string | null;
  next_phase_name: string | null;
  /** The tripwire — copied verbatim for display. */
  target_ends_on: string;
  /** Positive when today is past target_ends_on, else 0. */
  days_overdue: number;
  /** Positive when target_ends_on is still in the future, else 0. */
  days_until: number;
  tier: PhaseTransitionTier;
  today: string;
  window: { start: string; end: string };
  default_option_id: PhaseTransitionOptionId;
  options: PhaseTransitionOption[];
  rationale: string;
};

export type BuildPhaseTransitionArgs = {
  userId: string;
  todayIso: string;
  phase: PhaseRow & { name?: string | null };
  nextPhase: (PhaseRow & { name?: string | null }) | null;
  oldPattern: WeeklyPattern | null;
  nextPattern: WeeklyPattern | null;
  nextEventsByPhaseDay: ReadonlyMap<string, CalendarEventRow>;
  oldEventsByPhaseDay: ReadonlyMap<string, CalendarEventRow>;
  /** Plans in the (today, today+windowDays] window, keyed by date. */
  plansByDate: ReadonlyMap<string, ExistingPlan>;
  /** Optional window override (testing). */
  windowDays?: number;
};

// -------- gate --------------------------------------------------------

/**
 * Decide whether `phase` is within the proposal window. Returns the
 * tier, or null when the phase is fine as-is (target further out, or
 * open-ended, or phase not active).
 *
 * Exposed for unit tests and for the reconciler's cheap pre-check.
 */
export function classifyPhaseTransition(opts: {
  todayIso: string;
  phase: Pick<PhaseRow, 'target_ends_on'> & { status?: string | null };
}): { tier: PhaseTransitionTier; days_overdue: number; days_until: number } | null {
  const { todayIso, phase } = opts;
  if (!phase.target_ends_on) return null;               // open-ended → never fires
  if (phase.status && phase.status !== 'active') return null;

  const delta = daysBetweenIso(todayIso, phase.target_ends_on);
  // delta > 0  → target is in the future
  // delta === 0 → target is today
  // delta < 0  → target is in the past (overdue)

  if (delta > SOFT_TIER_WINDOW_DAYS) return null;       // not yet in range

  if (delta > 0) {
    return { tier: 'soft', days_overdue: 0, days_until: delta };
  }
  // Normalize -0 → 0 when delta is exactly 0.
  return { tier: 'hard', days_overdue: delta === 0 ? 0 : -delta, days_until: 0 };
}

// -------- diff builders ----------------------------------------------

type DiffBuildArgs = {
  todayIso: string;
  phase: PhaseRow;
  nextPhase: PhaseRow | null;
  nextPattern: WeeklyPattern | null;
  nextEventsByPhaseDay: ReadonlyMap<string, CalendarEventRow>;
  plansByDate: ReadonlyMap<string, ExistingPlan>;
  windowDays: number;
};

/**
 * Preservation decision: should this existing plan row be left alone?
 *
 * A row is *replaceable* only if it's a template-generated placeholder
 * belonging to the outgoing phase. Anything else — logged activity,
 * manual placements, previously-accepted AI proposals, plans already
 * claimed by a different phase — is off-limits.
 */
export function shouldPreserveExistingPlan(
  plan: ExistingPlan,
  oldPhaseId: string
): {
  preserve: boolean;
  reason?: 'logged' | 'manual' | 'ai_proposed' | 'availability_window' | 'other_phase';
} {
  if (plan.status !== 'planned') return { preserve: true, reason: 'logged' };
  if (plan.source === 'manual') return { preserve: true, reason: 'manual' };
  if (plan.source === 'ai_proposed') return { preserve: true, reason: 'ai_proposed' };
  // P1.3 — availability windows (travel/injury/pause) are user-declared.
  // A phase switch must never silently overwrite a rest/bodyweight row
  // the user put there deliberately.
  if (plan.source === 'availability_window') {
    return { preserve: true, reason: 'availability_window' };
  }
  if (plan.phase_id && plan.phase_id !== oldPhaseId) {
    return { preserve: true, reason: 'other_phase' };
  }
  return { preserve: false };
}

/** Binding resolver — mirrors diff.pure.ts semantics. */
function resolveBinding(opts: {
  phaseId: string;
  slot: WeeklySlot | undefined;
  eventsByPhaseDay: ReadonlyMap<string, CalendarEventRow>;
}): CalendarEventRow | null {
  const { phaseId, slot, eventsByPhaseDay } = opts;
  if (!slot || !slot.day_code || slot.type === 'rest') return null;
  return eventsByPhaseDay.get(`${phaseId}:${slot.day_code}`) ?? null;
}

/** Does the new pattern produce at least one *bound* training day? */
function nextPatternHasBoundTrainingDay(
  pattern: WeeklyPattern | null,
  nextPhaseId: string | null,
  events: ReadonlyMap<string, CalendarEventRow>
): boolean {
  if (!pattern || !nextPhaseId) return false;
  for (const slot of Object.values(pattern)) {
    if (!slot) continue;
    if (slot.type === 'rest') continue;
    if (!slot.day_code) continue;
    if (events.has(`${nextPhaseId}:${slot.day_code}`)) return true;
  }
  return false;
}

/**
 * Enumerate ISO dates in (today, today + windowDays].
 * Exclusive of today, inclusive of today + windowDays.
 */
function transitionWindowDates(todayIso: string, windowDays: number): string[] {
  const out: string[] = [];
  for (let i = 1; i <= windowDays; i += 1) {
    out.push(addDaysIso(todayIso, i));
  }
  return out;
}

/**
 * Build the transition option's phase updates + plan diff.
 *
 * Old phase: status='completed', target_ends_on=today, actual_ends_on=today
 *            (this is what makes `activePhaseFor` stop before the new phase).
 * New phase: status='active', starts_on=today+1.
 *
 * Plan rows in (today, min(today+windowDays, newPhase.target_ends_on ?? ∞)]:
 *   - preserved per shouldPreserveExistingPlan
 *   - else: delete if exists, then create from newPattern (including rest slots)
 *   - if slot has no DOW entry → do nothing (neither delete nor create;
 *     a pre-existing planned row with no new slot would be deleted, as
 *     that's the "slot removed" case)
 */
function buildTransitionDiff(args: DiffBuildArgs): {
  phase_updates: PhaseUpdate[];
  creates: PlanCreate[];
  deletes: PlanDelete[];
  summary: PhaseTransitionSummary;
  rationale: string;
} {
  const {
    todayIso,
    phase,
    nextPhase,
    nextPattern,
    nextEventsByPhaseDay,
    plansByDate,
    windowDays,
  } = args;

  if (!nextPhase || !nextPattern) {
    // Shouldn't be called without a next phase — the composer guards.
    // Defensive no-op.
    return {
      phase_updates: [],
      creates: [],
      deletes: [],
      summary: zeroSummary(),
      rationale: 'No next phase available — transition not possible.',
    };
  }

  const startIso = addDaysIso(todayIso, 1);
  const endIso = addDaysIso(todayIso, windowDays);
  // Clip forward window by new phase's own end, if set.
  const clippedEnd =
    nextPhase.target_ends_on && nextPhase.target_ends_on < endIso
      ? nextPhase.target_ends_on
      : endIso;

  const phase_updates: PhaseUpdate[] = [
    {
      phase_id: phase.id,
      patch: {
        status: 'completed',
        target_ends_on: todayIso,
        actual_ends_on: todayIso,
      },
    },
    {
      phase_id: nextPhase.id,
      patch: {
        status: 'active',
        starts_on: startIso,
      },
    },
  ];

  const creates: PlanCreate[] = [];
  const deletes: PlanDelete[] = [];
  const summary = zeroSummary();
  summary.new_target_ends_on = nextPhase.target_ends_on ?? undefined;

  for (const iso of transitionWindowDates(todayIso, windowDays)) {
    if (iso > clippedEnd) break;

    const existing = plansByDate.get(iso) ?? null;
    if (existing) {
      const decision = shouldPreserveExistingPlan(existing, phase.id);
      if (decision.preserve) {
        if (decision.reason === 'logged') summary.skipped_logged += 1;
        else if (decision.reason === 'manual') summary.skipped_manual += 1;
        else if (decision.reason === 'ai_proposed') summary.skipped_ai_proposed += 1;
        else if (decision.reason === 'availability_window') summary.skipped_availability_window += 1;
        continue; // never touch, never replace
      }
    }

    const dow = dowCodeOf(iso);
    const slot = nextPattern[dow];

    if (!slot) {
      // New phase has no slot on this DOW → delete the old placeholder
      // (if any) and don't create anything.
      if (existing) {
        deletes.push({
          plan_id: existing.id,
          date: iso,
          before: { type: existing.type, day_code: existing.day_code },
        });
        summary.removed += 1;
      }
      continue;
    }

    // We have a slot in the new pattern. If there's an old replaceable
    // row, delete it; then create the replacement.
    if (existing) {
      deletes.push({
        plan_id: existing.id,
        date: iso,
        before: { type: existing.type, day_code: existing.day_code },
      });
      summary.removed += 1;
    }

    const binding = resolveBinding({
      phaseId: nextPhase.id,
      slot,
      eventsByPhaseDay: nextEventsByPhaseDay,
    });

    creates.push(
      buildCreate({
        iso,
        phase: nextPhase,
        slot,
        binding,
        note: `Rolled forward from phase transition into ${nextPhase.code ?? '?'} (${slot.day_code ?? slot.type}).`,
      })
    );
    summary.added += 1;

    if (slot.type !== 'rest' && slot.day_code && !binding) {
      summary.orphan_day_codes.push({ date: iso, day_code: slot.day_code });
    }
  }

  const rationale = buildTransitionRationale({
    fromCode: phase.code ?? null,
    toCode: nextPhase.code ?? null,
    summary,
  });

  return { phase_updates, creates, deletes, summary, rationale };
}

/**
 * Build an extend option. No pattern change — we simply stretch the old
 * phase's target_ends_on by N days and fill any missing plan rows in
 * the stretched window from the OLD pattern.
 *
 * Why fill? The roll-forward pass stopped at the old target_ends_on.
 * Extending the phase without filling would leave the stretched window
 * empty until the next reconcile pass. Filling up-front makes the extend
 * diff visible to the review UI and keeps everything idempotent.
 */
function buildExtendDiff(args: {
  todayIso: string;
  phase: PhaseRow;
  oldPattern: WeeklyPattern | null;
  oldEventsByPhaseDay: ReadonlyMap<string, CalendarEventRow>;
  plansByDate: ReadonlyMap<string, ExistingPlan>;
  weeks: 1 | 2 | 4;
}): {
  phase_updates: PhaseUpdate[];
  creates: PlanCreate[];
  deletes: PlanDelete[];
  summary: PhaseTransitionSummary;
  rationale: string;
  new_target: string;
} {
  const { todayIso, phase, oldPattern, oldEventsByPhaseDay, plansByDate, weeks } = args;
  const days = weeks * 7;
  const newTarget = addDaysIso(todayIso, days);

  const phase_updates: PhaseUpdate[] = [
    {
      phase_id: phase.id,
      patch: { target_ends_on: newTarget },
    },
  ];

  const creates: PlanCreate[] = [];
  const summary = zeroSummary();
  summary.new_target_ends_on = newTarget;

  if (!oldPattern) {
    // No pattern to replay — still valid; the phase gets extended but
    // roll-forward will no-op. Rare (shouldn't happen in practice since
    // this phase is currently 'active') but we defend against it.
    return {
      phase_updates,
      creates,
      deletes: [],
      summary,
      rationale: buildExtendRationale({ phaseCode: phase.code ?? null, weeks, summary }),
      new_target: newTarget,
    };
  }

  // Fill (today, newTarget], skipping dates that already have any plan.
  const startIso = addDaysIso(todayIso, 1);
  let cur = startIso;
  // Safety: cap iterations.
  for (let i = 0; i < 400 && cur <= newTarget; i += 1) {
    const existing = plansByDate.get(cur);
    if (!existing) {
      const dow = dowCodeOf(cur);
      const slot = oldPattern[dow];
      if (slot) {
        const binding = resolveBinding({
          phaseId: phase.id,
          slot,
          eventsByPhaseDay: oldEventsByPhaseDay,
        });
        creates.push(
          buildCreate({
            iso: cur,
            phase,
            slot,
            binding,
            note: `Extended phase ${phase.code ?? '?'} by ${weeks} week${weeks === 1 ? '' : 's'}.`,
          })
        );
        summary.added += 1;
        if (slot.type !== 'rest' && slot.day_code && !binding) {
          summary.orphan_day_codes.push({ date: cur, day_code: slot.day_code });
        }
      }
    } else if (existing.status !== 'planned') {
      summary.skipped_logged += 1;
    }
    // Existing planned rows are left alone — already in shape.
    cur = addDaysIso(cur, 1);
  }

  return {
    phase_updates,
    creates,
    deletes: [],
    summary,
    rationale: buildExtendRationale({ phaseCode: phase.code ?? null, weeks, summary }),
    new_target: newTarget,
  };
}

/**
 * Build an end-phase option. Closes the phase with today as the
 * actual/target end, then deletes replaceable planned rows strictly
 * after today. No creates.
 */
function buildEndPhaseDiff(args: {
  todayIso: string;
  phase: PhaseRow;
  plansByDate: ReadonlyMap<string, ExistingPlan>;
  windowDays: number;
}): {
  phase_updates: PhaseUpdate[];
  creates: PlanCreate[];
  deletes: PlanDelete[];
  summary: PhaseTransitionSummary;
  rationale: string;
} {
  const { todayIso, phase, plansByDate, windowDays } = args;

  const phase_updates: PhaseUpdate[] = [
    {
      phase_id: phase.id,
      patch: {
        status: 'completed',
        target_ends_on: todayIso,
        actual_ends_on: todayIso,
      },
    },
  ];

  const deletes: PlanDelete[] = [];
  const summary = zeroSummary();
  summary.new_target_ends_on = todayIso;

  for (const iso of transitionWindowDates(todayIso, windowDays)) {
    const existing = plansByDate.get(iso);
    if (!existing) continue;
    const decision = shouldPreserveExistingPlan(existing, phase.id);
    if (decision.preserve) {
      if (decision.reason === 'logged') summary.skipped_logged += 1;
      else if (decision.reason === 'manual') summary.skipped_manual += 1;
      else if (decision.reason === 'ai_proposed') summary.skipped_ai_proposed += 1;
      else if (decision.reason === 'availability_window') summary.skipped_availability_window += 1;
      continue;
    }
    deletes.push({
      plan_id: existing.id,
      date: iso,
      before: { type: existing.type, day_code: existing.day_code },
    });
    summary.removed += 1;
  }

  return {
    phase_updates,
    creates: [],
    deletes,
    summary,
    rationale: `Marking phase ${phase.code ?? '?'} complete as of today — no successor queued, and upcoming placeholders will be cleared.`,
  };
}

/**
 * Reassess option — UI-only. No diff, no phase changes. The apply path
 * sees `action === 'reassess'` and redirects to the check-in flow.
 */
function buildReassessOption(): PhaseTransitionOption {
  return {
    id: 'reassess',
    label: 'Reassess with Claude',
    description: "Open a short check-in so Claude can propose what's next given how the phase actually went.",
    cta_label: 'Open check-in',
    recommended: false,
    phase_updates: [],
    plan_diff: { creates: [], deletes: [], updates: [] },
    summary: zeroSummary(),
    action: 'reassess',
    rationale: 'Talk it through before committing — best when a few things shifted during this phase.',
  };
}

// -------- the main composer ------------------------------------------

/**
 * Build the full PhaseTransitionProposal for the current phase, or
 * return null when no proposal is warranted.
 */
export function buildPhaseTransitionProposal(
  args: BuildPhaseTransitionArgs
): PhaseTransitionProposal | null {
  const {
    todayIso,
    phase,
    nextPhase,
    oldPattern,
    nextPattern,
    nextEventsByPhaseDay,
    oldEventsByPhaseDay,
    plansByDate,
  } = args;

  const classify = classifyPhaseTransition({
    todayIso,
    phase: { target_ends_on: phase.target_ends_on },
  });
  if (!classify) return null;
  if (!phase.target_ends_on) return null; // belt-and-braces; classify already checks

  const windowDays = args.windowDays ?? PHASE_TRANSITION_WINDOW_DAYS;
  const window = {
    start: addDaysIso(todayIso, 1),
    end: addDaysIso(todayIso, windowDays),
  };

  const transitionAvailable = nextPatternHasBoundTrainingDay(
    nextPattern,
    nextPhase?.id ?? null,
    nextEventsByPhaseDay
  );

  const options: PhaseTransitionOption[] = [];

  // ---- transition (when viable) ----
  if (transitionAvailable && nextPhase && nextPattern) {
    const t = buildTransitionDiff({
      todayIso,
      phase,
      nextPhase,
      nextPattern,
      nextEventsByPhaseDay,
      plansByDate,
      windowDays,
    });
    options.push({
      id: 'transition',
      label: `Start ${nextPhase.code ?? 'the next phase'}${nextPhase.name ? ` — ${nextPhase.name}` : ''}`,
      description: `Switch to the next phase starting tomorrow. Future planned placeholders get rebuilt from the ${nextPhase.code ?? 'next'} weekly shape.`,
      cta_label: `Start ${nextPhase.code ?? 'next phase'}`,
      recommended: true,
      phase_updates: t.phase_updates,
      plan_diff: { creates: t.creates, deletes: t.deletes, updates: [] },
      summary: t.summary,
      rationale: t.rationale,
    });
  }

  // ---- extend 1w / 2w / 4w ----
  const extend1 = buildExtendDiff({
    todayIso,
    phase,
    oldPattern,
    oldEventsByPhaseDay,
    plansByDate,
    weeks: 1,
  });
  const extend2 = buildExtendDiff({
    todayIso,
    phase,
    oldPattern,
    oldEventsByPhaseDay,
    plansByDate,
    weeks: 2,
  });
  const extend4 = buildExtendDiff({
    todayIso,
    phase,
    oldPattern,
    oldEventsByPhaseDay,
    plansByDate,
    weeks: 4,
  });

  // When no transition is viable, one of the extends becomes the
  // recommended option. Two weeks is the sweet spot: long enough to
  // move the needle, short enough that it's easy to reassess after.
  const extendIsRecommended = !transitionAvailable;

  options.push(extendOption('extend_1w', extend1, 1, extendIsRecommended === false ? false : false));
  options.push(extendOption('extend_2w', extend2, 2, extendIsRecommended));
  options.push(extendOption('extend_4w', extend4, 4, false));

  // ---- reassess ----
  options.push(buildReassessOption());

  // ---- end_phase (only when no next phase is queued) ----
  if (!nextPhase) {
    const e = buildEndPhaseDiff({ todayIso, phase, plansByDate, windowDays });
    options.push({
      id: 'end_phase',
      label: 'End phase here',
      description: 'Close out this phase with today as the end date. Upcoming placeholders get cleared.',
      cta_label: 'End phase',
      recommended: false,
      phase_updates: e.phase_updates,
      plan_diff: { creates: e.creates, deletes: e.deletes, updates: [] },
      summary: e.summary,
      action: 'end',
      rationale: e.rationale,
    });
  }

  const defaultOptionId: PhaseTransitionOptionId = transitionAvailable ? 'transition' : 'extend_2w';

  return {
    kind: 'phase_transition',
    phase_id: phase.id,
    phase_code: phase.code ?? null,
    phase_name: phase.name ?? null,
    next_phase_id: nextPhase?.id ?? null,
    next_phase_code: nextPhase?.code ?? null,
    next_phase_name: nextPhase?.name ?? null,
    target_ends_on: phase.target_ends_on,
    days_overdue: classify.days_overdue,
    days_until: classify.days_until,
    tier: classify.tier,
    today: todayIso,
    window,
    default_option_id: defaultOptionId,
    options,
    rationale: buildHeaderRationale({
      tier: classify.tier,
      days_until: classify.days_until,
      days_overdue: classify.days_overdue,
      phaseCode: phase.code ?? null,
      nextPhaseCode: nextPhase?.code ?? null,
      transitionAvailable,
    }),
  };
}

// -------- helpers -----------------------------------------------------

function zeroSummary(): PhaseTransitionSummary {
  return {
    added: 0,
    removed: 0,
    changed: 0,
    skipped_logged: 0,
    skipped_manual: 0,
    skipped_ai_proposed: 0,
    skipped_availability_window: 0,
    orphan_day_codes: [],
  };
}

function extendOption(
  id: 'extend_1w' | 'extend_2w' | 'extend_4w',
  built: ReturnType<typeof buildExtendDiff>,
  weeks: 1 | 2 | 4,
  recommended: boolean
): PhaseTransitionOption {
  const wordByWeeks: Record<1 | 2 | 4, string> = {
    1: 'one more week',
    2: 'two more weeks',
    4: 'four more weeks',
  };
  return {
    id,
    label: `Extend ${weeks} week${weeks === 1 ? '' : 's'}`,
    description: `Keep the current shape for ${wordByWeeks[weeks]}. New target: ${built.new_target}.`,
    cta_label: `Extend ${weeks}w`,
    recommended,
    phase_updates: built.phase_updates,
    plan_diff: { creates: built.creates, deletes: [], updates: [] },
    summary: built.summary,
    rationale: built.rationale,
  };
}

function buildCreate(opts: {
  iso: string;
  phase: PhaseRow;
  slot: WeeklySlot;
  binding: CalendarEventRow | null;
  note: string;
}): PlanCreate {
  const { iso, phase, slot, binding, note } = opts;
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
      ai_rationale: `${note} Rest day per ${phaseTag} weekly pattern.`,
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
      ? `${note} Bound to "${binding.summary ?? slot.day_code}".`
      : `${note} No calendar template yet for ${slot.day_code ?? slot.type} — placeholder only.`,
    is_orphan: Boolean(slot.day_code) && !binding,
  };
}

function buildTransitionRationale(opts: {
  fromCode: string | null;
  toCode: string | null;
  summary: PhaseTransitionSummary;
}): string {
  const { fromCode, toCode, summary } = opts;
  const from = fromCode ?? 'current phase';
  const to = toCode ?? 'next phase';
  const parts: string[] = [];
  if (summary.added) parts.push(`${summary.added} new`);
  if (summary.removed) parts.push(`${summary.removed} replaced`);
  const preserved: string[] = [];
  if (summary.skipped_logged) preserved.push(`${summary.skipped_logged} logged`);
  if (summary.skipped_manual) preserved.push(`${summary.skipped_manual} manual`);
  if (summary.skipped_ai_proposed) preserved.push(`${summary.skipped_ai_proposed} AI-proposed`);
  if (summary.skipped_availability_window) {
    preserved.push(`${summary.skipped_availability_window} availability-window`);
  }
  const scope = parts.length > 0 ? parts.join(' · ') : 'no future sessions affected';
  const preservedTxt = preserved.length > 0 ? ` — preserving ${preserved.join(', ')}` : '';
  return `Transition from ${from} to ${to}: ${scope}${preservedTxt}.`;
}

function buildExtendRationale(opts: {
  phaseCode: string | null;
  weeks: 1 | 2 | 4;
  summary: PhaseTransitionSummary;
}): string {
  const { phaseCode, weeks, summary } = opts;
  const phaseTag = phaseCode ? `phase ${phaseCode}` : 'this phase';
  const parts: string[] = [];
  if (summary.added) parts.push(`${summary.added} session${summary.added === 1 ? '' : 's'} added`);
  const scope = parts.length > 0 ? parts.join(' · ') : 'no new sessions needed';
  return `Extending ${phaseTag} by ${weeks} week${weeks === 1 ? '' : 's'}: ${scope}.`;
}

function buildHeaderRationale(opts: {
  tier: PhaseTransitionTier;
  days_until: number;
  days_overdue: number;
  phaseCode: string | null;
  nextPhaseCode: string | null;
  transitionAvailable: boolean;
}): string {
  const { tier, days_until, days_overdue, phaseCode, nextPhaseCode, transitionAvailable } = opts;
  const from = phaseCode ?? 'this phase';
  const nextTag = nextPhaseCode ? ` into ${nextPhaseCode}` : '';

  if (tier === 'soft') {
    if (days_until === 1) {
      return transitionAvailable
        ? `${from} ends tomorrow. Ready to move${nextTag}?`
        : `${from} ends tomorrow. No successor queued — extend or wrap up?`;
    }
    return transitionAvailable
      ? `${from} ends in ${days_until} days. Plan the handoff${nextTag}.`
      : `${from} ends in ${days_until} days. No successor queued — what's next?`;
  }

  // hard
  if (days_overdue === 0) {
    return transitionAvailable
      ? `${from} ends today. Pick how to roll forward${nextTag}.`
      : `${from} ends today. No successor queued — extend or close it out.`;
  }
  return transitionAvailable
    ? `${from} wrapped ${days_overdue} day${days_overdue === 1 ? '' : 's'} ago. Let's lock in what's next${nextTag}.`
    : `${from} wrapped ${days_overdue} day${days_overdue === 1 ? '' : 's'} ago. No successor queued — decide how to proceed.`;
}
