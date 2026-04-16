/**
 * Reconciler entry point.
 *
 *   reconcile(userId, now, cause)
 *
 * Pipeline (implementations stubbed in PR-A; filled in PR-B/PR-C):
 *   1. Read profile (timezone, last_reconciled_at).
 *   2. Freshness gate — 30-min debounce on page-load causes.
 *   3. Claim — optimistic update of last_reconciled_at to "lock" this
 *      run against concurrent callers (cron vs. page-load race).
 *   4. ageOut  → UPDATE past plans without activities → status='missed'
 *   5. rollForward → INSERT plans extending the 21-day window
 *   6. dropOff → create 'return_from_gap' proposal when gap ≥ 3d
 *   7. phaseTransition → create 'phase_transition' proposal when the
 *      active phase is ending within 7 days or already overdue
 *
 * Pure on its own inputs other than the Supabase client. Safe to call
 * from server components, API routes, and cron handlers.
 *
 * See docs/p1-0-implementation.md for full design.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { formatInTimeZone } from './tz';
import { checkFreshness } from './freshness';
import { ageOut } from './ageOut';
import { rollForward } from './rollForward';
import { detectDropOff } from './dropOff';
import { detectPhaseTransition } from '@/lib/phase/transition';
import type { ReconcileCause, ReconcileResult } from './types';
import { ZERO_RESULT } from './types';

export type { ReconcileCause, ReconcileResult } from './types';

export async function reconcile(
  sb: SupabaseClient,
  userId: string,
  now: Date,
  cause: ReconcileCause
): Promise<ReconcileResult> {
  const startedAt = Date.now();

  // 1. Load profile (timezone + last_reconciled_at).
  const { data: profile, error: profErr } = await sb
    .from('profiles')
    .select('user_id, timezone, last_reconciled_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (profErr || !profile) {
    return {
      ...ZERO_RESULT,
      duration_ms: Date.now() - startedAt,
      skipped: true,
      skip_reason: 'no_profile',
    };
  }

  const tz = profile.timezone || 'UTC';
  const lastReconciledAt = profile.last_reconciled_at
    ? new Date(profile.last_reconciled_at)
    : null;

  // 2. Freshness gate.
  const fresh = checkFreshness({ cause, lastReconciledAt, now });
  if (!fresh.shouldRun) {
    return {
      ...ZERO_RESULT,
      duration_ms: Date.now() - startedAt,
      skipped: true,
      skip_reason: fresh.reason,
    };
  }

  // 3. Optimistic claim — bump last_reconciled_at atomically, scoped to
  //    the value we just read. If another process wrote first, our
  //    update matches 0 rows and we bail out as 'locked'.
  const claim = await claimReconcile(sb, userId, lastReconciledAt, now);
  if (!claim.claimed) {
    return {
      ...ZERO_RESULT,
      duration_ms: Date.now() - startedAt,
      skipped: true,
      skip_reason: 'locked',
    };
  }

  // 4-6. Pipeline (all stubbed in PR-A; return zeros).
  const todayIso = formatInTimeZone(now, tz, 'yyyy-MM-dd');

  const a = await ageOut({ sb, userId, todayIso });
  const r = await rollForward({ sb, userId, todayIso });
  const d = await detectDropOff({ sb, userId, todayIso });
  const pt = await detectPhaseTransition({ sb, userId, todayIso });

  return {
    aged_out: a.aged_out,
    rolled_forward: r.rolled_forward,
    drop_off_detected: d.drop_off_detected,
    phase_transition_detected: pt.phase_transition_detected,
    duration_ms: Date.now() - startedAt,
    skipped: false,
  };
}

/**
 * Optimistic claim. Succeeds iff nobody else has written
 * profiles.last_reconciled_at between our read and this write.
 *
 * This is our "advisory lock" for PR-A — classic compare-and-swap
 * using the row value itself. No server-side lock needed; works with
 * Supabase's transaction-pooled connections.
 *
 * Trade-off: if a reconcile run crashes mid-pipeline, the next caller
 * will see "fresh" for 30 min and skip. In PR-A everything is a no-op
 * so this is harmless. PR-B can add an in_progress marker if the
 * pipeline starts doing meaningful partial work.
 */
async function claimReconcile(
  sb: SupabaseClient,
  userId: string,
  lastReconciledAt: Date | null,
  now: Date
): Promise<{ claimed: boolean }> {
  const q = sb
    .from('profiles')
    .update({ last_reconciled_at: now.toISOString() })
    .eq('user_id', userId);

  const scoped = lastReconciledAt === null
    ? q.is('last_reconciled_at', null)
    : q.eq('last_reconciled_at', lastReconciledAt.toISOString());

  const { data, error } = await scoped.select('user_id');
  if (error) return { claimed: false };
  return { claimed: Array.isArray(data) && data.length > 0 };
}
