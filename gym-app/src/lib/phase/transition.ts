/**
 * Phase-transition detection (P1.2 / PR-J).
 *
 * Runs after drop-off in the reconciler pipeline. When the active phase
 * is about to end (≤ 7 days out) or already overdue, we materialize a
 * `phase_transition` proposal via `ai_proposals` so the Today UI can
 * offer the user a transition / extend / reassess / end choice.
 *
 * Mirrors the structure of `dropOff.ts`:
 *   - cheap gate first (active phase exists, target_ends_on within window)
 *   - idempotency check (pending proposal already live → skip)
 *   - load the per-phase patterns, calendar events, and relevant plans
 *   - call the pure builder (`transition.pure.ts`) and insert the row
 *
 * Idempotency contract: never stack pending proposals for the same
 * phase. Once the user accepts/rejects/dismisses (proposal leaves
 * 'pending'), future reconciler passes may fire a fresh proposal — the
 * phase target might have been extended, the next phase might have been
 * configured, etc. This matches return_from_gap's one-at-a-time policy
 * while staying responsive to phase edits.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  addDaysIso,
  type CalendarEventRow,
  type PhaseRow,
} from '@/lib/reconcile/rollForward.pure';
import {
  buildPhaseTransitionProposal,
  classifyPhaseTransition,
  PHASE_TRANSITION_WINDOW_DAYS,
  type ExistingPlan,
} from './transition.pure';
import { getAllWeeklyPatternsForUser } from '@/lib/templates/loader';

/** Phase row shape we read from Supabase. Superset of PhaseRow. */
type PhaseDbRow = {
  id: string;
  ordinal: number;
  code: string | null;
  name: string | null;
  starts_on: string | null;
  target_ends_on: string | null;
  actual_ends_on: string | null;
  status: string | null;
};

export async function detectPhaseTransition(opts: {
  sb: SupabaseClient;
  userId: string;
  todayIso: string;
}): Promise<{ phase_transition_detected: boolean }> {
  const { sb, userId, todayIso } = opts;

  // 1. Load the user's phases, ordered. We need both the current (active)
  //    phase and the next (upcoming) phase, if any.
  const { data: phasesData, error: phaseErr } = await sb
    .from('phases')
    .select('id, ordinal, code, name, starts_on, target_ends_on, actual_ends_on, status')
    .eq('user_id', userId)
    .order('ordinal', { ascending: true });

  if (phaseErr) {
    console.error('[reconcile/phaseTransition] load phases failed', phaseErr);
    return { phase_transition_detected: false };
  }
  const phases = (phasesData ?? []) as PhaseDbRow[];
  if (phases.length === 0) return { phase_transition_detected: false };

  // Find the active phase. Prefer explicit status='active'; fall back to
  // "the phase whose date range contains today" so we still fire for
  // users whose status flags drifted.
  const active =
    phases.find(p => p.status === 'active') ??
    phases.find(
      p =>
        p.starts_on &&
        p.starts_on <= todayIso &&
        (!p.target_ends_on || todayIso <= p.target_ends_on) &&
        (!p.actual_ends_on || todayIso <= p.actual_ends_on)
    );
  if (!active) return { phase_transition_detected: false };

  // 2. Cheap classification — bail before any further I/O if the target
  //    is comfortably in the future or the phase is open-ended.
  const classify = classifyPhaseTransition({
    todayIso,
    phase: { target_ends_on: active.target_ends_on, status: active.status ?? null },
  });
  if (!classify) return { phase_transition_detected: false };

  // 3. Idempotency gate: is there already a pending phase_transition
  //    proposal for this phase? The target_ends_on check scopes it to
  //    the current phase instance — if the user extended the phase and
  //    we fire again later, we don't mistake an old pending row for a
  //    fresh one.
  const { data: existing, error: existErr } = await sb
    .from('ai_proposals')
    .select('id, diff')
    .eq('user_id', userId)
    .eq('kind', 'phase_transition')
    .eq('status', 'pending')
    .limit(5); // tiny in practice

  if (existErr) {
    console.error('[reconcile/phaseTransition] load existing proposals failed', existErr);
    return { phase_transition_detected: false };
  }

  if (existing && existing.length > 0) {
    const stillValid = existing.some(row => {
      const d = (row.diff ?? {}) as { phase_id?: string; target_ends_on?: string };
      return d.phase_id === active.id && d.target_ends_on === active.target_ends_on;
    });
    if (stillValid) {
      return { phase_transition_detected: true };
    }
    // Otherwise the phase moved under us — reject the stale proposals
    // before writing a fresh one so the UI has a single pending row to
    // reason about.
    const staleIds = existing
      .filter(row => {
        const d = (row.diff ?? {}) as { phase_id?: string; target_ends_on?: string };
        return d.phase_id !== active.id || d.target_ends_on !== active.target_ends_on;
      })
      .map(row => row.id as string);
    if (staleIds.length > 0) {
      await sb
        .from('ai_proposals')
        .update({
          status: 'rejected',
          rationale: 'Phase-transition proposal superseded — phase target changed.',
        })
        .in('id', staleIds)
        .eq('user_id', userId)
        .eq('status', 'pending');
    }
  }

  // 4. Determine the next phase. Prefer the adjacent ordinal; ignore
  //    phases already marked completed/abandoned.
  const nextPhase =
    phases
      .filter(p => p.ordinal > active.ordinal)
      .find(p => p.status !== 'completed' && p.status !== 'abandoned') ?? null;

  // 5. Load weekly patterns (old + new), calendar events for both phases,
  //    and the plan rows in the transition window.
  const patternByPhase = await getAllWeeklyPatternsForUser(sb, userId);
  const oldPattern = patternByPhase.get(active.id) ?? null;
  const nextPattern = nextPhase ? patternByPhase.get(nextPhase.id) ?? null : null;

  // Event lookup. One query covers both phases.
  const phaseIdsForEvents = nextPhase ? [active.id, nextPhase.id] : [active.id];
  const { data: events, error: evErr } = await sb
    .from('calendar_events')
    .select('id, phase_id, day_code, prescription, summary')
    .eq('user_id', userId)
    .in('phase_id', phaseIdsForEvents);

  if (evErr) {
    console.error('[reconcile/phaseTransition] load events failed', evErr);
    return { phase_transition_detected: false };
  }

  const oldEventsByPhaseDay = new Map<string, CalendarEventRow>();
  const nextEventsByPhaseDay = new Map<string, CalendarEventRow>();
  for (const e of (events ?? []) as CalendarEventRow[]) {
    if (!e.phase_id || !e.day_code) continue;
    const key = `${e.phase_id}:${e.day_code}`;
    if (e.phase_id === active.id) oldEventsByPhaseDay.set(key, e);
    else if (nextPhase && e.phase_id === nextPhase.id) nextEventsByPhaseDay.set(key, e);
  }

  // 6. Plans in (today, today+28] — slightly wider than the engine's
  //    window so the extend_4w option can see rows it might replace.
  //    (Extend_4w fills 28 days forward.)
  const loadEnd = addDaysIso(todayIso, 28);
  const { data: plans, error: plansErr } = await sb
    .from('plans')
    .select('id, date, type, day_code, phase_id, status, source')
    .eq('user_id', userId)
    .gt('date', todayIso)
    .lte('date', loadEnd);

  if (plansErr) {
    console.error('[reconcile/phaseTransition] load plans failed', plansErr);
    return { phase_transition_detected: false };
  }

  const plansByDate = new Map<string, ExistingPlan>();
  for (const p of (plans ?? []) as Array<{
    id: string;
    date: string;
    type: string;
    day_code: string | null;
    phase_id: string | null;
    status: string;
    source: string | null;
  }>) {
    // On rare multi-version collisions, prefer a 'planned' row — it's
    // the one that'll drive replacement decisions.
    const prior = plansByDate.get(p.date);
    if (!prior || p.status === 'planned') {
      plansByDate.set(p.date, {
        id: p.id,
        date: p.date,
        type: p.type,
        day_code: p.day_code,
        phase_id: p.phase_id,
        status: p.status,
        source: p.source ?? 'template',
      });
    }
  }

  // 7. Narrow the phase rows to `PhaseRow` (engine-facing shape).
  const activePhaseRow: PhaseRow & { name?: string | null } = {
    id: active.id,
    code: active.code,
    starts_on: active.starts_on,
    target_ends_on: active.target_ends_on,
    name: active.name,
  };
  const nextPhaseRow: (PhaseRow & { name?: string | null }) | null = nextPhase
    ? {
        id: nextPhase.id,
        code: nextPhase.code,
        starts_on: nextPhase.starts_on,
        target_ends_on: nextPhase.target_ends_on,
        name: nextPhase.name,
      }
    : null;

  // 8. Build the proposal (pure).
  const proposal = buildPhaseTransitionProposal({
    userId,
    todayIso,
    phase: activePhaseRow,
    nextPhase: nextPhaseRow,
    oldPattern,
    nextPattern,
    oldEventsByPhaseDay,
    nextEventsByPhaseDay,
    plansByDate,
    windowDays: PHASE_TRANSITION_WINDOW_DAYS,
  });

  if (!proposal) return { phase_transition_detected: false };

  // 9. Insert.
  const { error: insErr } = await sb.from('ai_proposals').insert({
    user_id: userId,
    kind: 'phase_transition',
    triggered_by: classify.tier === 'hard' ? 'phase_ended' : 'phase_ending_soon',
    diff: proposal,
    rationale: proposal.rationale,
    status: 'pending',
  });

  if (insErr) {
    console.error('[reconcile/phaseTransition] insert proposal failed', insErr);
    return { phase_transition_detected: false };
  }

  return { phase_transition_detected: true };
}
