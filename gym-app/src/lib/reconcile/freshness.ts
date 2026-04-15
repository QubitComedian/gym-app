/**
 * Freshness gate for the reconciler.
 *
 * Policy (from docs/p1-0-implementation.md §3):
 *   - 'today_page_load' honors a 30-minute debounce against
 *     profiles.last_reconciled_at. If we ran within the last 30min, skip.
 *   - 'activity_logged' and 'proposal_applied' always run — they fire
 *     because state just changed, so freshness is definitionally stale.
 *   - 'nightly_cron' always runs.
 *
 * Pure function; takes `lastReconciledAt` (or null) and `now`, returns
 * `{ shouldRun, reason }`.
 */

import type { ReconcileCause } from './types';

export const FRESHNESS_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

export type FreshnessDecision =
  | { shouldRun: true }
  | { shouldRun: false; reason: 'fresh' };

export function checkFreshness(opts: {
  cause: ReconcileCause;
  lastReconciledAt: Date | null;
  now: Date;
  windowMs?: number;
}): FreshnessDecision {
  const { cause, lastReconciledAt, now } = opts;
  const windowMs = opts.windowMs ?? FRESHNESS_WINDOW_MS;

  // Non-page-load causes bypass the gate entirely.
  if (cause !== 'today_page_load') return { shouldRun: true };

  // No prior reconcile → always run.
  if (!lastReconciledAt) return { shouldRun: true };

  const ageMs = now.getTime() - lastReconciledAt.getTime();
  // Clock skew guard: if lastReconciledAt is in the future by > 1min,
  // treat it as stale (someone's clock is off; do the work).
  if (ageMs < -60_000) return { shouldRun: true };

  if (ageMs < windowMs) return { shouldRun: false, reason: 'fresh' };
  return { shouldRun: true };
}
