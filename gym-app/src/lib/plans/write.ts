/**
 * Plan-sync enqueue hook (P1.4 / PR-S).
 *
 * Centralizes the "a plan row changed — the worker needs to know" side
 * effect so that every plan-write site (template apply, phase
 * transition apply, availability apply, proposal apply, reconciler
 * roll-forward, activity logging) can emit calendar-sync jobs via a
 * single code path.
 *
 * This file adds NO worker logic — it just enqueues rows into
 * `sync_jobs` with `kind='plan_upsert'` or `'plan_delete'`. The worker
 * that drains the queue, calls Google, and handles etag/backoff lands
 * in PR-T. Today the jobs accumulate harmlessly; an unshipped worker
 * means an empty queue drain.
 *
 * Contract — ordering matters:
 *
 *   - `enqueuePlanSync` with `upsertIds` should be called AFTER the
 *     underlying INSERT/UPDATE commits. The worker re-reads the plan
 *     row at sync time (it projects Google-event fields from the
 *     latest plan state), so an uncommitted or missing row would make
 *     the job immediately fail on pickup.
 *
 *   - `enqueuePlanSync` with `deleteIds` MUST be called BEFORE the
 *     plan-row DELETE runs. The helper snapshots the live
 *     `calendar_links` row (google_event_id + google_calendar_id +
 *     google_etag) into the job payload. After migration 0008,
 *     `calendar_links.plan_id` is SET NULL on plan deletion rather
 *     than cascaded, so the link row survives — but a post-delete
 *     lookup by plan_id returns zero rows. Snapshot-before-delete is
 *     the only reliable path.
 *
 * Gating — the hook is a no-op when:
 *
 *   - The user has no `google_tokens` row (never connected Google).
 *   - The user's `google_tokens.status` is not 'active' (refresh
 *     failed, explicitly disconnected, etc.). Queueing during an
 *     error state would just pile up jobs; the UI shows a reconnect
 *     banner and the user can recover.
 *   - The user has connected Google but hasn't completed the
 *     dedicated-calendar setup (`training_calendar_id is null`).
 *     The worker needs a destination calendar to write to.
 *
 * Dedup — within a single drain cycle we don't need multiple queued
 * `plan_upsert`s for the same plan (the worker always reads the
 * latest state). The helper skips enqueueing if an identical
 * (user_id, plan_id, kind, status='queued') row already exists.
 *
 * Conflict between opposing kinds (upsert + delete for the same plan
 * both queued) is left to the worker in PR-T: it drains by
 * `run_after` / insertion order, so the later intent wins. That's
 * correct — a user who creates, deletes, re-creates a plan in quick
 * succession should end up with the re-created state on Google.
 *
 * Failure isolation — plan writes have already committed by the time
 * this helper runs (for upserts) or are about to commit (for
 * deletes). A failure to enqueue sync jobs must NOT propagate; the
 * plan rows remain the source of truth and the reconciler's nightly
 * full-scan (PR-W) can rebuild the queue from scratch if needed. All
 * DB errors inside this helper are logged and swallowed.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// =====================================================================
// Types
// =====================================================================

export type PlanSyncOps = {
  /** Plan ids that were just INSERTed or UPDATEd. Call after commit. */
  upsertIds?: string[];
  /** Plan ids about to be DELETEd. Call BEFORE the delete runs. */
  deleteIds?: string[];
};

export type EnqueueResult = {
  /** Number of sync_jobs rows inserted. */
  enqueued: number;
  /**
   * Number of (plan_id, kind) intents we chose NOT to enqueue —
   * either because the user isn't set up for calendar sync, an
   * identical job is already queued, or (for deletes) no
   * calendar_link exists to sync. Surfaced so tests can assert
   * dedup/gating behavior without inspecting rows directly.
   */
  skipped: number;
};

// =====================================================================
// Public API
// =====================================================================

/**
 * Enqueue Google Calendar sync jobs for a set of plan changes.
 *
 * - `upsertIds` must reference plans that exist in the DB at call time
 *   (worker will re-read them).
 * - `deleteIds` must reference plans that still exist at call time —
 *   call this BEFORE running the delete so we can snapshot the
 *   linked Google event.
 *
 * Returns { enqueued, skipped }. Never throws; DB errors are logged
 * and counted as skipped so the caller's plan-write flow is never
 * tripped by a sync-queue hiccup.
 */
export async function enqueuePlanSync(
  sb: SupabaseClient,
  userId: string,
  ops: PlanSyncOps,
): Promise<EnqueueResult> {
  const upsertIds = dedupAndFilter(ops.upsertIds);
  const deleteIds = dedupAndFilter(ops.deleteIds);

  if (upsertIds.length === 0 && deleteIds.length === 0) {
    return { enqueued: 0, skipped: 0 };
  }

  // -------- Gate: user must be set up for calendar sync -------------
  // A single row lookup keeps this cheap; callers often hit the hook
  // for every write, so we avoid multi-row joins here.
  const gateOk = await isCalendarSyncActive(sb, userId);
  if (!gateOk) {
    return { enqueued: 0, skipped: upsertIds.length + deleteIds.length };
  }

  let enqueued = 0;
  let skipped = 0;

  // -------- Dedup against already-queued jobs -----------------------
  // The queue is small per user (drained frequently by the worker),
  // so load once and filter in memory rather than firing one
  // `select` per id.
  const existing = await loadQueuedPlanJobs(sb, userId);

  // -------- plan_upsert jobs ----------------------------------------
  const upsertRows: SyncJobInsert[] = [];
  for (const planId of upsertIds) {
    if (existing.upsert.has(planId)) {
      skipped += 1;
      continue;
    }
    upsertRows.push({
      user_id: userId,
      kind: 'plan_upsert',
      payload: { plan_id: planId },
    });
  }

  // -------- plan_delete jobs (snapshot calendar_links first) --------
  // For each delete, look up the live link row and capture the
  // google_event_id + google_calendar_id + google_etag into the
  // payload. The worker (PR-T) uses these directly — no further
  // calendar_link lookup needed, so the SET NULL cascade doesn't
  // matter after this point.
  //
  // If a plan has no calendar_link (never synced in the first
  // place), there's nothing to delete remotely — skip it.
  const deleteRows: SyncJobInsert[] = [];
  if (deleteIds.length > 0) {
    const snapshots = await snapshotDeleteLinks(sb, userId, deleteIds);
    for (const planId of deleteIds) {
      if (existing.del.has(planId)) {
        skipped += 1;
        continue;
      }
      const snap = snapshots.get(planId);
      if (!snap) {
        // Plan was never synced to Google — nothing to delete.
        skipped += 1;
        continue;
      }
      deleteRows.push({
        user_id: userId,
        kind: 'plan_delete',
        payload: {
          plan_id: planId,
          google_calendar_id: snap.google_calendar_id,
          google_event_id: snap.google_event_id,
          google_etag: snap.google_etag ?? null,
        },
      });
    }
  }

  // -------- Batch insert both kinds in one round-trip ---------------
  const allRows = [...upsertRows, ...deleteRows];
  if (allRows.length > 0) {
    const { error } = await sb.from('sync_jobs').insert(allRows);
    if (error) {
      // Plan writes already succeeded (upserts) or are about to
      // (deletes). A failure here should NOT bubble up. Log and
      // count everything as skipped so the caller sees the exact
      // drop-through count.
      console.error('[plans/write] sync_jobs insert failed', error, {
        userId,
        upserts: upsertRows.length,
        deletes: deleteRows.length,
      });
      skipped += allRows.length;
    } else {
      enqueued += allRows.length;
    }
  }

  return { enqueued, skipped };
}

// =====================================================================
// Internal helpers (exported for tests)
// =====================================================================

type SyncJobInsert = {
  user_id: string;
  kind: 'plan_upsert' | 'plan_delete';
  payload: Record<string, unknown>;
};

type ExistingJobMap = {
  upsert: Set<string>;
  del: Set<string>;
};

/** Strip duplicates + falsy entries. Exported for tests. */
export function dedupAndFilter(ids: string[] | undefined): string[] {
  if (!ids || ids.length === 0) return [];
  const out = new Set<string>();
  for (const id of ids) {
    if (id && typeof id === 'string') out.add(id);
  }
  return Array.from(out);
}

/**
 * True if the user has connected Google AND has an active token AND
 * has picked a training calendar. Any of those missing → gate closed.
 */
async function isCalendarSyncActive(
  sb: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const { data, error } = await sb
    .from('google_tokens')
    .select('status, training_calendar_id')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    console.error('[plans/write] google_tokens lookup failed', error, { userId });
    return false;
  }
  if (!data) return false;
  if (data.status !== 'active') return false;
  if (!data.training_calendar_id) return false;
  return true;
}

/**
 * Load the set of plan_ids that already have a queued plan_upsert /
 * plan_delete job for this user. Returned as two Sets so dedup is
 * O(1) per candidate.
 */
async function loadQueuedPlanJobs(
  sb: SupabaseClient,
  userId: string,
): Promise<ExistingJobMap> {
  const out: ExistingJobMap = { upsert: new Set(), del: new Set() };

  const { data, error } = await sb
    .from('sync_jobs')
    .select('kind, payload')
    .eq('user_id', userId)
    .eq('status', 'queued')
    .in('kind', ['plan_upsert', 'plan_delete']);

  if (error) {
    console.error('[plans/write] sync_jobs queued lookup failed', error, { userId });
    return out;
  }

  for (const row of (data ?? []) as Array<{ kind: string; payload: { plan_id?: string } }>) {
    const planId = row.payload?.plan_id;
    if (!planId) continue;
    if (row.kind === 'plan_upsert') out.upsert.add(planId);
    else if (row.kind === 'plan_delete') out.del.add(planId);
  }
  return out;
}

/**
 * For each plan id in `ids`, find its `calendar_links` row (if any)
 * and return the pieces the worker needs to delete the remote event.
 *
 * A Map keyed by plan_id — missing keys mean "no link, skip".
 */
async function snapshotDeleteLinks(
  sb: SupabaseClient,
  userId: string,
  ids: string[],
): Promise<Map<string, { google_event_id: string; google_calendar_id: string; google_etag: string | null }>> {
  const out = new Map<string, { google_event_id: string; google_calendar_id: string; google_etag: string | null }>();
  if (ids.length === 0) return out;

  const { data, error } = await sb
    .from('calendar_links')
    .select('plan_id, google_event_id, google_calendar_id, google_etag')
    .eq('user_id', userId)
    .in('plan_id', ids);

  if (error) {
    console.error('[plans/write] calendar_links snapshot failed', error, { userId, count: ids.length });
    return out;
  }

  for (const row of (data ?? []) as Array<{
    plan_id: string;
    google_event_id: string;
    google_calendar_id: string;
    google_etag: string | null;
  }>) {
    if (!row.plan_id) continue;
    out.set(row.plan_id, {
      google_event_id: row.google_event_id,
      google_calendar_id: row.google_calendar_id,
      google_etag: row.google_etag ?? null,
    });
  }
  return out;
}
