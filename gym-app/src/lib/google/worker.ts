/**
 * Google Calendar sync worker (P1.4 / PR-T).
 *
 * Drains the `sync_jobs` queue for `plan_upsert` and `plan_delete`
 * kinds, calling the Google Calendar v3 API to create, update, or
 * delete events and maintaining `calendar_links` as the mapping table.
 *
 * Architecture:
 *
 *   1. **Claim** — select a batch of `status='queued'` jobs where
 *      `run_after <= now()`, sorted by `run_after, id`. Update them to
 *      `status='running'` atomically (CAS on status). The batch is
 *      grouped by user_id so we can amortize the token + preferences
 *      lookup per user.
 *
 *   2. **Process per user** — for each user in the batch:
 *      a. Load `google_tokens` row (with freshness check).
 *      b. Build an OAuth2 client with token-refresh listener.
 *      c. Load `training_preferences` + `profiles.timezone`.
 *      d. Process each job:
 *         - plan_upsert: load plan → project → insert/update event →
 *           upsert calendar_links.
 *         - plan_delete: use snapshotted payload → delete event →
 *           clean up calendar_links.
 *
 *   3. **Error taxonomy:**
 *      - 401/403 from Google → mark `google_tokens.status='error'`,
 *        skip remaining jobs for that user (they all need a valid
 *        token). Re-queue those jobs for retry after token recovery.
 *      - 404 on delete → treat as already-deleted remotely, mark done.
 *      - 412 Precondition Failed → etag conflict; mark
 *        `calendar_links.sync_status='conflict'`, mark job done
 *        (PR-U's conflict resolver will handle).
 *      - 429 / 5xx / network → exponential backoff via `run_after`.
 *      - Max attempts (MAX_ATTEMPTS) → mark 'failed'.
 *
 *   4. **Backoff** — `baseDelay × 2^(attempt-1)`, capped at 1 hour.
 *      Attempt count lives on the `sync_jobs.attempt` column.
 *
 * Invariants:
 *   - The worker NEVER throws. All errors are caught, logged, and
 *     surfaced in the returned `DrainResult`. The cron endpoint can
 *     return the aggregate to Vercel for observability.
 *   - Plan rows are the source of truth. A missed sync job means the
 *     Google event is stale until the nightly full-scan (PR-W) or the
 *     user's next plan mutation re-enqueues.
 *   - The worker runs with a service-role Supabase client (RLS bypass)
 *     but scopes every query by `user_id` for defense in depth.
 */

import { google, type calendar_v3 } from 'googleapis';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  projectPlanToEvent,
  checksumEvent,
  DEFAULT_PREFERENCES,
  type PlanRow,
  type TrainingPreferences,
} from './project';

// =====================================================================
// Configuration
// =====================================================================

export const BATCH_SIZE = 20;
export const MAX_ATTEMPTS = 5;
/** Base delay in seconds. Actual delay = BASE_DELAY_S × 2^(attempt-1). */
export const BASE_DELAY_S = 15;
/** Maximum delay in seconds (1 hour). */
export const MAX_DELAY_S = 3600;

// =====================================================================
// Types
// =====================================================================

export type DrainResult = {
  claimed: number;
  processed: number;
  succeeded: number;
  retried: number;
  failed_permanent: number;
  skipped_token_error: number;
};

type SyncJob = {
  id: number;
  user_id: string;
  kind: 'plan_upsert' | 'plan_delete';
  payload: Record<string, any>;
  status: string;
  attempt: number;
};

type UserContext = {
  cal: calendar_v3.Calendar;
  calendarId: string;
  prefs: TrainingPreferences;
  timezone: string;
  /** Set to true when a 401/403 is hit; remaining jobs for this user
   *  are re-queued without calling Google. */
  tokenRevoked: boolean;
};

// =====================================================================
// Public API
// =====================================================================

/**
 * Drain one batch of plan-sync jobs. Called by the cron endpoint.
 *
 * Returns aggregate stats. Never throws.
 */
export async function drainSyncJobs(sb: SupabaseClient): Promise<DrainResult> {
  const result: DrainResult = {
    claimed: 0,
    processed: 0,
    succeeded: 0,
    retried: 0,
    failed_permanent: 0,
    skipped_token_error: 0,
  };

  try {
    // ---- 1. Claim batch -----------------------------------------------
    const jobs = await claimBatch(sb);
    result.claimed = jobs.length;
    if (jobs.length === 0) return result;

    // ---- 2. Group by user ---------------------------------------------
    const byUser = new Map<string, SyncJob[]>();
    for (const j of jobs) {
      const arr = byUser.get(j.user_id) ?? [];
      arr.push(j);
      byUser.set(j.user_id, arr);
    }

    // ---- 3. Process per user ------------------------------------------
    for (const [userId, userJobs] of byUser) {
      let ctx: UserContext | null = null;
      try {
        ctx = await buildUserContext(sb, userId);
      } catch (e: any) {
        // If we can't build context (e.g. token missing/revoked),
        // re-queue all of this user's jobs with backoff.
        console.error('[google/worker] context build failed', userId, e?.message);
        for (const j of userJobs) {
          await requeueOrFail(sb, j, e?.message ?? 'context build failed');
          result.retried += 1;
        }
        result.processed += userJobs.length;
        continue;
      }

      for (const job of userJobs) {
        result.processed += 1;

        if (ctx.tokenRevoked) {
          // Token died mid-batch. Re-queue remaining jobs for this user.
          await requeueOrFail(sb, job, 'token revoked mid-batch');
          result.skipped_token_error += 1;
          continue;
        }

        try {
          if (job.kind === 'plan_upsert') {
            await processUpsert(sb, ctx, job);
          } else {
            await processDelete(sb, ctx, job);
          }
          await markDone(sb, job.id);
          result.succeeded += 1;
        } catch (e: any) {
          const handled = await handleJobError(sb, ctx, job, e);
          if (handled === 'retried') result.retried += 1;
          else if (handled === 'failed') result.failed_permanent += 1;
          else if (handled === 'token_error') result.skipped_token_error += 1;
          else result.succeeded += 1; // 'resolved' (e.g. 404 on delete)
        }
      }
    }
  } catch (e: any) {
    // Catastrophic — shouldn't happen but the worker must never throw.
    console.error('[google/worker] drain failed catastrophically', e);
  }

  return result;
}

// =====================================================================
// Claim
// =====================================================================

async function claimBatch(sb: SupabaseClient): Promise<SyncJob[]> {
  const now = new Date().toISOString();

  // Select candidates. The partial index (sync_jobs_claim_idx) on
  // `(status, run_after) WHERE status='queued'` makes this efficient.
  const { data: candidates, error: selErr } = await sb
    .from('sync_jobs')
    .select('id, user_id, kind, payload, status, attempt')
    .eq('status', 'queued')
    .lte('run_after', now)
    .in('kind', ['plan_upsert', 'plan_delete'])
    .order('run_after', { ascending: true })
    .order('id', { ascending: true })
    .limit(BATCH_SIZE);

  if (selErr || !candidates?.length) {
    if (selErr) console.error('[google/worker] claim select failed', selErr);
    return [];
  }

  const ids = (candidates as SyncJob[]).map((j) => j.id);

  // CAS: set status='running' only for rows still in 'queued'. This
  // guards against a concurrent drain (unlikely with a single cron,
  // but safe to have).
  const { error: updErr } = await sb
    .from('sync_jobs')
    .update({ status: 'running', updated_at: now })
    .in('id', ids)
    .eq('status', 'queued');

  if (updErr) {
    console.error('[google/worker] claim update failed', updErr);
    return [];
  }

  return candidates as SyncJob[];
}

// =====================================================================
// User context
// =====================================================================

async function buildUserContext(
  sb: SupabaseClient,
  userId: string,
): Promise<UserContext> {
  // Load token, prefs, and profile in parallel.
  const [tokResult, prefsResult, profileResult] = await Promise.all([
    sb.from('google_tokens').select('*').eq('user_id', userId).maybeSingle(),
    sb.from('training_preferences').select('*').eq('user_id', userId).maybeSingle(),
    sb.from('profiles').select('timezone').eq('user_id', userId).maybeSingle(),
  ]);

  const tok = tokResult.data;
  if (!tok) throw new Error('no google_tokens row');
  if (tok.status !== 'active') throw new Error(`token status=${tok.status}`);
  if (!tok.training_calendar_id) throw new Error('no training_calendar_id');

  // Build OAuth2 client with token refresh persistence.
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
  oauth2.setCredentials({
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || undefined,
    expiry_date: tok.expires_at ? new Date(tok.expires_at).getTime() : undefined,
  });

  // Persist refreshed tokens back to the DB.
  oauth2.on('tokens', async (newTok) => {
    const update: Record<string, unknown> = {};
    if (newTok.access_token) update.access_token = newTok.access_token;
    if (newTok.refresh_token) update.refresh_token = newTok.refresh_token;
    if (newTok.expiry_date) update.expires_at = new Date(newTok.expiry_date).toISOString();
    update.updated_at = new Date().toISOString();
    if (Object.keys(update).length > 1) {
      await sb.from('google_tokens').update(update).eq('user_id', userId);
    }
  });

  const cal = google.calendar({ version: 'v3', auth: oauth2 });

  const rawPrefs = prefsResult.data;
  const prefs: TrainingPreferences = rawPrefs
    ? {
        session_start_time: rawPrefs.session_start_time ?? DEFAULT_PREFERENCES.session_start_time,
        session_duration_minutes: rawPrefs.session_duration_minutes ?? DEFAULT_PREFERENCES.session_duration_minutes,
        day_overrides: rawPrefs.day_overrides ?? DEFAULT_PREFERENCES.day_overrides,
        color_scheme: rawPrefs.color_scheme ?? null,
      }
    : DEFAULT_PREFERENCES;

  const timezone = profileResult.data?.timezone ?? 'UTC';

  return { cal, calendarId: tok.training_calendar_id, prefs, timezone, tokenRevoked: false };
}

// =====================================================================
// Job processors
// =====================================================================

async function processUpsert(
  sb: SupabaseClient,
  ctx: UserContext,
  job: SyncJob,
): Promise<void> {
  const planId: string = job.payload.plan_id;
  if (!planId) throw new Error('plan_upsert payload missing plan_id');

  // Load the plan row at its latest state. If the plan was deleted
  // between enqueue and drain, treat as a no-op (mark done).
  const { data: plan, error: planErr } = await sb
    .from('plans')
    .select('id, date, type, day_code, status, prescription')
    .eq('id', planId)
    .eq('user_id', job.user_id)
    .maybeSingle();

  if (planErr) throw new Error(`plan load failed: ${planErr.message}`);
  if (!plan) {
    // Plan vanished — nothing to sync. Will be marked done by caller.
    return;
  }

  // Rest days don't get Google events (same as the demo push route).
  if (plan.type === 'rest') return;

  const planRow: PlanRow = plan as PlanRow;
  const eventBody = projectPlanToEvent(planRow, ctx.prefs, ctx.timezone);
  const checksum = checksumEvent(eventBody);

  // Check if a calendar_link already exists for this plan.
  const { data: link } = await sb
    .from('calendar_links')
    .select('id, google_event_id, google_calendar_id, google_etag, checksum')
    .eq('user_id', job.user_id)
    .eq('plan_id', planId)
    .maybeSingle();

  if (link) {
    // Existing link — skip if checksum unchanged (nothing to sync).
    if (link.checksum === checksum) return;

    // Update the existing event.
    const res = await ctx.cal.events.update({
      calendarId: link.google_calendar_id,
      eventId: link.google_event_id,
      requestBody: eventBody,
      ...(link.google_etag ? { headers: { 'If-Match': link.google_etag } } : {}),
    });

    const newEtag = res.headers?.etag ?? res.data.etag ?? null;
    await sb
      .from('calendar_links')
      .update({
        checksum,
        google_etag: newEtag,
        sync_status: 'synced',
        last_error: null,
        last_attempt_at: new Date().toISOString(),
        attempt_count: 0,
        last_synced_at: new Date().toISOString(),
      })
      .eq('id', link.id);
  } else {
    // No link — insert a new event.
    const res = await ctx.cal.events.insert({
      calendarId: ctx.calendarId,
      requestBody: eventBody,
    });

    const googleEventId = res.data.id;
    if (!googleEventId) throw new Error('Google insert returned no event id');

    const newEtag = res.headers?.etag ?? res.data.etag ?? null;
    await sb.from('calendar_links').insert({
      user_id: job.user_id,
      plan_id: planId,
      google_event_id: googleEventId,
      google_calendar_id: ctx.calendarId,
      google_etag: newEtag,
      checksum,
      sync_status: 'synced',
      last_error: null,
      last_attempt_at: new Date().toISOString(),
      attempt_count: 0,
      last_synced_at: new Date().toISOString(),
    });
  }
}

async function processDelete(
  sb: SupabaseClient,
  ctx: UserContext,
  job: SyncJob,
): Promise<void> {
  const { plan_id, google_event_id, google_calendar_id, google_etag } =
    job.payload as {
      plan_id: string;
      google_event_id: string;
      google_calendar_id: string;
      google_etag: string | null;
    };

  if (!google_event_id || !google_calendar_id) {
    // Payload is incomplete — nothing to delete remotely. This can
    // happen if the snapshot missed (calendar_links error during
    // enqueuePlanSync). Just clean up the link if it exists.
    await cleanupLink(sb, job.user_id, plan_id);
    return;
  }

  await ctx.cal.events.delete({
    calendarId: google_calendar_id,
    eventId: google_event_id,
    ...(google_etag ? { headers: { 'If-Match': google_etag } } : {}),
  });

  // Clean up the calendar_links row. The plan_id FK was SET NULL on
  // plan deletion (migration 0008), so the link might still exist
  // with plan_id=null. Find it by google_event_id instead.
  await cleanupLink(sb, job.user_id, plan_id, google_event_id);
}

async function cleanupLink(
  sb: SupabaseClient,
  userId: string,
  planId?: string,
  googleEventId?: string,
): Promise<void> {
  // Try by plan_id first (still set if plan deletion hasn't committed
  // yet), fall back to google_event_id.
  if (planId) {
    const { count } = await sb
      .from('calendar_links')
      .delete({ count: 'exact' })
      .eq('user_id', userId)
      .eq('plan_id', planId);
    if ((count ?? 0) > 0) return;
  }
  if (googleEventId) {
    await sb
      .from('calendar_links')
      .delete()
      .eq('user_id', userId)
      .eq('google_event_id', googleEventId);
  }
}

// =====================================================================
// Error handling
// =====================================================================

type ErrorOutcome = 'retried' | 'failed' | 'token_error' | 'resolved';

async function handleJobError(
  sb: SupabaseClient,
  ctx: UserContext,
  job: SyncJob,
  error: any,
): Promise<ErrorOutcome> {
  const status = error?.code ?? error?.response?.status ?? error?.status;
  const message =
    error?.message ??
    error?.response?.data?.error?.message ??
    String(error);

  console.error('[google/worker] job error', {
    jobId: job.id,
    kind: job.kind,
    userId: job.user_id,
    status,
    message,
  });

  // ---- Auth errors (401, 403) — token is dead for this user --------
  if (status === 401 || status === 403) {
    ctx.tokenRevoked = true;
    await sb
      .from('google_tokens')
      .update({ status: 'error', updated_at: new Date().toISOString() })
      .eq('user_id', job.user_id)
      .eq('status', 'active'); // CAS: only flip if still active

    // Re-queue this job — once the user reconnects, the token will
    // go back to 'active' and the queued jobs will drain.
    await requeueOrFail(sb, job, `auth error: ${message}`);
    return 'token_error';
  }

  // ---- 404 on delete — already gone remotely -----------------------
  if (status === 404 && job.kind === 'plan_delete') {
    // The event doesn't exist on Google anymore. Clean up the link
    // and count this as a success.
    await cleanupLink(
      sb,
      job.user_id,
      job.payload.plan_id,
      job.payload.google_event_id,
    );
    await markDone(sb, job.id);
    return 'resolved';
  }

  // ---- 412 Precondition Failed — etag conflict ---------------------
  if (status === 412) {
    // Someone (user or another app) modified the Google event since
    // our last sync. Mark the link as conflicted so the conflict
    // resolver (PR-U) can reconcile.
    const planId = job.payload.plan_id;
    if (planId) {
      await sb
        .from('calendar_links')
        .update({
          sync_status: 'conflict',
          last_error: `etag conflict: ${message}`,
          last_attempt_at: new Date().toISOString(),
        })
        .eq('user_id', job.user_id)
        .eq('plan_id', planId);
    }
    await markDone(sb, job.id);
    return 'resolved';
  }

  // ---- Transient errors (429, 5xx, network) — retry with backoff ---
  await requeueOrFail(sb, job, message);
  return 'retried';
}

// =====================================================================
// Job state transitions
// =====================================================================

async function markDone(sb: SupabaseClient, jobId: number): Promise<void> {
  await sb
    .from('sync_jobs')
    .update({
      status: 'done',
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId);
}

async function requeueOrFail(
  sb: SupabaseClient,
  job: SyncJob,
  errorMsg: string,
): Promise<void> {
  const nextAttempt = job.attempt + 1;

  if (nextAttempt >= MAX_ATTEMPTS) {
    await sb
      .from('sync_jobs')
      .update({
        status: 'failed',
        last_error: `max attempts reached: ${errorMsg}`,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);
    return;
  }

  const delaySec = Math.min(BASE_DELAY_S * Math.pow(2, nextAttempt - 1), MAX_DELAY_S);
  const runAfter = new Date(Date.now() + delaySec * 1000).toISOString();

  await sb
    .from('sync_jobs')
    .update({
      status: 'queued',
      attempt: nextAttempt,
      run_after: runAfter,
      last_error: errorMsg,
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id);
}

// =====================================================================
// Exported for tests
// =====================================================================

export { claimBatch, processUpsert, processDelete, handleJobError, requeueOrFail, markDone, buildUserContext };
export type { SyncJob, UserContext };
