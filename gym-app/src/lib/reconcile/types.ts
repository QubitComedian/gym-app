/**
 * Reconciler types — shared across the reconcile/ module.
 *
 * See docs/calendar-system.md and docs/p1-0-implementation.md for design.
 */

/**
 * What caused this reconcile pass. Drives the freshness gate:
 *   - 'today_page_load' honors the 30-min debounce
 *   - 'activity_logged' / 'proposal_applied' / 'nightly_cron' always run
 */
export type ReconcileCause =
  | 'today_page_load'
  | 'activity_logged'
  | 'proposal_applied'
  | 'nightly_cron';

export type ReconcileResult = {
  /** Plans moved from 'planned' → 'missed' this pass. */
  aged_out: number;
  /** New plan rows inserted to extend the 21-day rolling window. */
  rolled_forward: number;
  /** True if a return_from_gap proposal was created (or already pending). */
  drop_off_detected: boolean;
  /** Wall-clock duration of the whole pass. */
  duration_ms: number;
  /** True if the pass short-circuited (freshness gate or advisory lock). */
  skipped: boolean;
  /** Human-readable skip reason, if any. */
  skip_reason?: 'fresh' | 'locked' | 'no_profile';
};

/**
 * Zero-work result. Used by stubs and by short-circuits.
 */
export const ZERO_RESULT: Omit<ReconcileResult, 'duration_ms' | 'skipped'> = {
  aged_out: 0,
  rolled_forward: 0,
  drop_off_detected: false,
};
