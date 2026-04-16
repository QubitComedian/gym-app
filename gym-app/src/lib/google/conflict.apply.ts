/**
 * Conflict resolution apply logic — I/O wrapper (P1.5 / PR-Y).
 *
 * Handles applying user-chosen options for two proposal kinds:
 *
 *   - `kind='conflict'`         — etag conflicts from the sync worker.
 *   - `kind='meeting_conflict'` — meeting overlaps from the nightly scan.
 *
 * Each function takes the Supabase client, user context, and the
 * proposal's diff + chosen option, then:
 *   1. Computes the resolution via pure helpers.
 *   2. Writes plan/calendar_link/sync_job changes.
 *   3. Returns a result the route handler can serialize.
 *
 * Called by the proposal route handler (/api/proposals/[id]).
 *
 * Design rule from calendar-system.md §1: "the app is the source of
 * truth." All resolutions either re-assert the app's projection
 * (force_push, recreate) or explicitly accept the external change
 * into the plan (accept_remote, skip, reschedule).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { enqueuePlanSync } from '@/lib/plans/write';
import {
  resolveConflictAction,
  resolveMeetingConflictAction,
  type ConflictOptionAction,
  type MeetingConflictOptionId,
  type OverlappingMeeting,
} from './conflict.apply.pure';

// =====================================================================
// Types
// =====================================================================

export type ApplyConflictResult = {
  ok: true;
  resolution: string;
} | {
  ok: false;
  reason: string;
};

/** Shape of the diff for kind='conflict' proposals. */
export type ConflictDiff = {
  conflict_kind: string;
  plan_id: string;
  plan_date: string;
  plan_type: string;
  plan_day_code: string | null;
  calendar_link_id: string;
  google_event_id: string;
  google_calendar_id: string;
  projected: {
    summary: string;
    start: { dateTime: string; timeZone: string };
    end: { dateTime: string; timeZone: string };
  };
  remote: {
    summary: string;
    start: { dateTime?: string; date?: string; timeZone?: string };
    end: { dateTime?: string; date?: string; timeZone?: string };
  } | null;
  options: Array<{
    id: string;
    label: string;
    action: ConflictOptionAction;
  }>;
};

/** Shape of the diff for kind='meeting_conflict' proposals. */
export type MeetingConflictDiff = {
  plan_id: string;
  plan_date: string;
  plan_type: string;
  plan_day_code: string | null;
  session_start: string;
  session_duration: number;
  overlapping_meetings: OverlappingMeeting[];
  options: Array<{
    id: MeetingConflictOptionId;
    label: string;
    action: string;
  }>;
};

// =====================================================================
// kind='conflict' apply
// =====================================================================

/**
 * Apply the user's chosen option for an etag-conflict proposal.
 */
export async function applyConflictOption(
  sb: SupabaseClient,
  userId: string,
  diff: ConflictDiff,
  optionId: string,
): Promise<ApplyConflictResult> {
  // Find the chosen option.
  const option = diff.options?.find((o) => o.id === optionId);
  if (!option) {
    return { ok: false, reason: `unknown option_id: ${optionId}` };
  }

  // Verify plan still exists.
  const { data: plan } = await sb
    .from('plans')
    .select('id, date, status, version')
    .eq('id', diff.plan_id)
    .eq('user_id', userId)
    .maybeSingle();

  // Compute the resolution.
  const remoteStart = diff.remote?.start?.dateTime ?? null;
  const resolution = resolveConflictAction(option.action, diff.plan_date, remoteStart);

  switch (resolution.type) {
    case 'force_push': {
      // Re-assert app's projection — enqueue a new plan_upsert.
      if (plan) {
        await enqueuePlanSync(sb, userId, { upsertIds: [diff.plan_id] });
      }
      await clearConflictState(sb, diff.calendar_link_id);
      return { ok: true, resolution: 'force_push' };
    }

    case 'accept_remote_date': {
      // User moved event to a different date in Google — accept it.
      if (plan && plan.status === 'planned') {
        await sb
          .from('plans')
          .update({
            date: resolution.newDate,
            version: plan.version ? plan.version + 1 : 2,
          })
          .eq('id', diff.plan_id)
          .eq('user_id', userId);
        // Re-sync to push the updated plan (which now has the accepted
        // date) back to Google with the correct projection.
        await enqueuePlanSync(sb, userId, { upsertIds: [diff.plan_id] });
      }
      await clearConflictState(sb, diff.calendar_link_id);
      return { ok: true, resolution: 'accept_remote_date' };
    }

    case 'accept_remote_noop': {
      // Time-only change — no plan field to update. Just mark synced
      // so we stop re-flagging this link.
      await markLinkSynced(sb, diff.calendar_link_id);
      return { ok: true, resolution: 'accept_remote_noop' };
    }

    case 'cancel_plan': {
      // User doesn't want this session anymore.
      if (plan && plan.status === 'planned') {
        // Snapshot for delete before changing plan status.
        await enqueuePlanSync(sb, userId, { deleteIds: [diff.plan_id] });
        await sb
          .from('plans')
          .update({ status: 'skipped' })
          .eq('id', diff.plan_id)
          .eq('user_id', userId);
      }
      await clearConflictState(sb, diff.calendar_link_id);
      return { ok: true, resolution: 'cancel_plan' };
    }

    case 'recreate': {
      // Event was deleted on Google — recreate it by re-syncing.
      if (plan) {
        await enqueuePlanSync(sb, userId, { upsertIds: [diff.plan_id] });
      }
      await clearConflictState(sb, diff.calendar_link_id);
      return { ok: true, resolution: 'recreate' };
    }

    case 'dismiss': {
      // User doesn't care. For etag conflicts, this means "stop
      // bugging me" — force-push so the calendar re-aligns with the
      // app (we are truth) and won't trigger again.
      if (plan) {
        await enqueuePlanSync(sb, userId, { upsertIds: [diff.plan_id] });
      }
      await clearConflictState(sb, diff.calendar_link_id);
      return { ok: true, resolution: 'dismiss' };
    }

    default:
      return { ok: false, reason: `unhandled resolution: ${(resolution as any).type}` };
  }
}

// =====================================================================
// kind='meeting_conflict' apply
// =====================================================================

/**
 * Apply the user's chosen option for a meeting-conflict proposal.
 */
export async function applyMeetingConflictOption(
  sb: SupabaseClient,
  userId: string,
  diff: MeetingConflictDiff,
  optionId: string,
): Promise<ApplyConflictResult> {
  const option = diff.options?.find((o) => o.id === optionId);
  if (!option) {
    return { ok: false, reason: `unknown option_id: ${optionId}` };
  }

  // Verify plan still exists.
  const { data: plan } = await sb
    .from('plans')
    .select('id, date, status, type, day_code, prescription')
    .eq('id', diff.plan_id)
    .eq('user_id', userId)
    .maybeSingle();

  if (!plan || plan.status !== 'planned') {
    return { ok: true, resolution: 'noop_plan_gone' };
  }

  // Load occupied dates (for move_day).
  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
  const { data: nearbyPlans } = await sb
    .from('plans')
    .select('date')
    .eq('user_id', userId)
    .eq('status', 'planned')
    .neq('type', 'rest')
    .gte('date', today)
    .lte('date', horizon);
  const occupiedDates = (nearbyPlans ?? []).map((p: { date: string }) => p.date);

  const resolution = resolveMeetingConflictAction(
    optionId as MeetingConflictOptionId,
    diff.plan_date,
    diff.session_duration,
    diff.overlapping_meetings,
    occupiedDates,
    today,
  );

  switch (resolution.type) {
    case 'reschedule_time': {
      // Set a per-plan time override so the projection uses the new
      // start time instead of the global preference.
      await sb
        .from('plans')
        .update({ time_override: resolution.newTimeOverride })
        .eq('id', diff.plan_id)
        .eq('user_id', userId);
      // Re-sync to push the new event time.
      await enqueuePlanSync(sb, userId, { upsertIds: [diff.plan_id] });
      return { ok: true, resolution: `reschedule_time:${resolution.newTimeOverride}` };
    }

    case 'reschedule_day': {
      // Move the plan to a different date. We update the existing
      // row rather than delete+create so the plan_id is stable and
      // the calendar_link mapping continues to work.
      await sb
        .from('plans')
        .update({
          date: resolution.newDate,
          time_override: null, // Clear any prior override for the old date.
        })
        .eq('id', diff.plan_id)
        .eq('user_id', userId);
      // Re-sync — the worker will update the Google event's date.
      await enqueuePlanSync(sb, userId, { upsertIds: [diff.plan_id] });
      return { ok: true, resolution: `reschedule_day:${resolution.newDate}` };
    }

    case 'skip': {
      // User gives up this session. Snapshot calendar link for delete
      // BEFORE changing status, then mark plan skipped.
      await enqueuePlanSync(sb, userId, { deleteIds: [diff.plan_id] });
      await sb
        .from('plans')
        .update({ status: 'skipped' })
        .eq('id', diff.plan_id)
        .eq('user_id', userId);
      return { ok: true, resolution: 'skip' };
    }

    case 'dismiss': {
      // Keep as planned — the user will deal with the overlap.
      return { ok: true, resolution: 'dismiss' };
    }

    default:
      return { ok: false, reason: `unhandled resolution: ${(resolution as any).type}` };
  }
}

// =====================================================================
// Calendar link helpers
// =====================================================================

/**
 * Clear conflict state on a calendar_link — reset to 'pending' so
 * the next worker drain picks it up for re-sync. Also clears the
 * remote_snapshot since the conflict is resolved.
 */
async function clearConflictState(
  sb: SupabaseClient,
  linkId: string,
): Promise<void> {
  await sb
    .from('calendar_links')
    .update({
      sync_status: 'pending',
      remote_snapshot: null,
      last_error: null,
    })
    .eq('id', linkId);
}

/**
 * Mark a calendar_link as synced — the user accepted the remote state
 * so there's no conflict to resolve and no re-sync needed.
 */
async function markLinkSynced(
  sb: SupabaseClient,
  linkId: string,
): Promise<void> {
  await sb
    .from('calendar_links')
    .update({
      sync_status: 'synced',
      remote_snapshot: null,
      last_error: null,
      attempt_count: 0,
    })
    .eq('id', linkId);
}

// =====================================================================
// Exports for tests
// =====================================================================

export { clearConflictState, markLinkSynced };
