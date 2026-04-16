/**
 * Phase-transition apply wrapper (P1.2 / PR-J).
 *
 * Replays the `phase_updates` + `plan_diff` captured in a selected
 * `PhaseTransitionOption` against the DB. Called by the proposal apply
 * route (`/api/proposals/[id]/route.ts`) after the user picks an option.
 *
 * Ordering matters — the moves below are designed so partial failure
 * leaves the DB in a self-healing state:
 *
 *   1. Phase updates FIRST.
 *      Completing the old phase and/or activating the new phase before
 *      touching plans means that, if a plan write later fails, the next
 *      reconcile pass will resume the work from the correct phase
 *      lineage. (If we wrote plans first and then the phase update
 *      failed, roll-forward would see old-phase rows clashing with the
 *      new pattern.)
 *
 *   2. Plan deletes (only `status='planned'`).
 *      Soft-guarded: anything that drifted to done/missed/skipped under
 *      us is left alone. Count any skips so the UI can surface them.
 *
 *   3. Plan creates.
 *      Bulk insert. `source='template'` rows — these are
 *      reconciler-owned placeholders, not AI-proposed. The `is_orphan`
 *      flag is advisory (not a DB column today); callers can expose it
 *      via the audit row's summary.
 *
 * There's no multi-table transaction available from a pooled Supabase
 * connection; we compensate with the self-healing ordering above plus
 * idempotent reconciler behavior. If a user retries an apply after a
 * partial failure, the second attempt's diff will reflect only what's
 * still left to do.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { enqueuePlanSync } from '@/lib/plans/write';
import type {
  PhaseTransitionOption,
  PhaseTransitionProposal,
} from './transition.pure';

export type ApplyPhaseTransitionArgs = {
  sb: SupabaseClient;
  userId: string;
  proposal: PhaseTransitionProposal;
  optionId: string;
};

export type ApplyPhaseTransitionResult =
  | {
      ok: true;
      option_id: PhaseTransitionOption['id'];
      applied: {
        phase_updates: number;
        plan_creates: number;
        plan_deletes: number;
      };
      skipped: {
        plan_deletes_not_planned: number;
      };
      /** Present when the selected option requested a UI redirect (reassess). */
      redirect?: '/check-in';
    }
  | {
      ok: false;
      reason: 'unknown_option' | 'phase_update_failed' | 'apply_failed';
      detail?: string;
    };

export async function applyPhaseTransition(
  args: ApplyPhaseTransitionArgs
): Promise<ApplyPhaseTransitionResult> {
  const { sb, userId, proposal, optionId } = args;

  const option = proposal.options.find(o => o.id === optionId);
  if (!option) {
    return { ok: false, reason: 'unknown_option' };
  }

  // ---- Reassess is a pure UI redirect — no diff to apply. --------------
  if (option.action === 'reassess') {
    return {
      ok: true,
      option_id: option.id,
      applied: { phase_updates: 0, plan_creates: 0, plan_deletes: 0 },
      skipped: { plan_deletes_not_planned: 0 },
      redirect: '/check-in',
    };
  }

  // ---- 1. Phase updates ------------------------------------------------
  let appliedPhaseUpdates = 0;
  for (const pu of option.phase_updates) {
    const patch: Record<string, unknown> = {};
    if (pu.patch.status !== undefined) patch.status = pu.patch.status;
    if (pu.patch.starts_on !== undefined) patch.starts_on = pu.patch.starts_on;
    if (pu.patch.target_ends_on !== undefined) patch.target_ends_on = pu.patch.target_ends_on;
    if (pu.patch.actual_ends_on !== undefined) patch.actual_ends_on = pu.patch.actual_ends_on;
    if (Object.keys(patch).length === 0) continue;

    const { error } = await sb
      .from('phases')
      .update(patch)
      .eq('id', pu.phase_id)
      .eq('user_id', userId);
    if (error) {
      console.error('[phase/apply] phase update failed', error, { phase_id: pu.phase_id });
      return { ok: false, reason: 'phase_update_failed', detail: error.message };
    }
    appliedPhaseUpdates += 1;
  }

  // ---- 2. Plan deletes -------------------------------------------------
  // Pre-snapshot the calendar_link rows before the delete runs so the
  // Google Calendar worker (PR-T) has google_event_id/_calendar_id in
  // its payload. After migration 0008, `calendar_links.plan_id` is
  // SET NULL on plan deletion, so a post-delete lookup returns nothing.
  // enqueuePlanSync skips plans that were never synced — safe to call
  // for every delete candidate.
  if (option.plan_diff.deletes.length > 0) {
    await enqueuePlanSync(sb, userId, {
      deleteIds: option.plan_diff.deletes.map(d => d.plan_id),
    });
  }

  let appliedDeletes = 0;
  let skippedDeletesNotPlanned = 0;
  for (const d of option.plan_diff.deletes) {
    const { error, count } = await sb
      .from('plans')
      .delete({ count: 'exact' })
      .eq('id', d.plan_id)
      .eq('user_id', userId)
      .eq('status', 'planned');
    if (error) {
      console.error('[phase/apply] plan delete failed', error, { plan_id: d.plan_id });
      skippedDeletesNotPlanned += 1;
      continue;
    }
    if ((count ?? 0) === 0) {
      skippedDeletesNotPlanned += 1;
      continue;
    }
    appliedDeletes += 1;
  }

  // ---- 3. Plan creates -------------------------------------------------
  let appliedCreates = 0;
  const insertedPlanIds: string[] = [];
  if (option.plan_diff.creates.length > 0) {
    const rows = option.plan_diff.creates.map(c => ({
      user_id: userId,
      phase_id: c.phase_id,
      date: c.date,
      type: c.type,
      day_code: c.day_code,
      prescription: c.prescription,
      calendar_event_id: c.calendar_event_id,
      status: c.status,
      source: c.source,
      ai_rationale: c.ai_rationale,
    }));
    const { data: insertedRows, error } = await sb
      .from('plans')
      .insert(rows)
      .select('id');
    if (error) {
      console.error('[phase/apply] plan creates failed', error);
      // Don't return a hard failure here — phase updates already
      // landed, and the next reconcile pass will heal missing rows via
      // roll-forward. Surface the miss so callers can log.
      return { ok: false, reason: 'apply_failed', detail: error.message };
    }
    appliedCreates = insertedRows?.length ?? 0;
    for (const r of (insertedRows ?? []) as Array<{ id: string }>) {
      insertedPlanIds.push(r.id);
    }
  }

  // ---- 4. Enqueue calendar sync for the newly-inserted plans ---------
  // Phase transitions don't UPDATE plans in place (only delete + create),
  // so upserts here are purely the new phase's plan rows. Called AFTER
  // insert commits; worker re-reads on pickup.
  if (insertedPlanIds.length > 0) {
    await enqueuePlanSync(sb, userId, { upsertIds: insertedPlanIds });
  }

  return {
    ok: true,
    option_id: option.id,
    applied: {
      phase_updates: appliedPhaseUpdates,
      plan_creates: appliedCreates,
      plan_deletes: appliedDeletes,
    },
    skipped: {
      plan_deletes_not_planned: skippedDeletesNotPlanned,
    },
  };
}
