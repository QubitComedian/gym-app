/**
 * Conflict resolver I/O wrapper (P1.4 / PR-U).
 *
 * Discovers calendar_links rows with `sync_status='conflict'`,
 * fetches the current Google event, classifies the conflict via
 * the pure module, and either:
 *
 *   - **Trivial** — force-pushes our projection (re-update with the
 *     fresh etag), marks the link 'synced'.
 *   - **Meaningful** (time_moved, content_edited, deleted_remotely) —
 *     creates a `kind='conflict'` proposal in `ai_proposals` so the
 *     user can choose.
 *
 * Called by the calendar-sync cron after the worker drain. Runs with
 * the same service-role Supabase client.
 *
 * Architecture:
 *   - Groups conflicted links by user_id so we amortize the OAuth2
 *     client build and preferences lookup per user.
 *   - Processes conflicts serially per user (no batching on Google
 *     API calls — rate-limit friendly, simpler error handling).
 *   - A Google 401/403 during resolution sets the token to 'error'
 *     and skips remaining conflicts for that user (same pattern as
 *     the worker).
 *   - Idempotent: if a pending `kind='conflict'` proposal already
 *     exists for this plan, we skip creating a duplicate.
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
import {
  classifyConflict,
  type RemoteEvent,
  type ConflictClassification,
} from './conflict.pure';

// =====================================================================
// Types
// =====================================================================

export type ResolveConflictsResult = {
  discovered: number;
  auto_resolved: number;
  proposals_created: number;
  skipped_no_plan: number;
  skipped_existing_proposal: number;
  errors: number;
};

type ConflictedLink = {
  id: string;
  user_id: string;
  plan_id: string | null;
  google_event_id: string;
  google_calendar_id: string;
  google_etag: string | null;
  checksum: string | null;
};

type UserCtx = {
  cal: calendar_v3.Calendar;
  calendarId: string;
  prefs: TrainingPreferences;
  timezone: string;
};

// =====================================================================
// Public API
// =====================================================================

/**
 * Resolve all calendar_links rows with `sync_status='conflict'`.
 *
 * Called by the cron endpoint after draining sync_jobs. Never throws.
 */
export async function resolveConflicts(
  sb: SupabaseClient,
): Promise<ResolveConflictsResult> {
  const result: ResolveConflictsResult = {
    discovered: 0,
    auto_resolved: 0,
    proposals_created: 0,
    skipped_no_plan: 0,
    skipped_existing_proposal: 0,
    errors: 0,
  };

  try {
    // ---- 1. Discover conflicted links ---------------------------------
    const { data: links, error: loadErr } = await sb
      .from('calendar_links')
      .select('id, user_id, plan_id, google_event_id, google_calendar_id, google_etag, checksum')
      .eq('sync_status', 'conflict')
      .limit(50); // Cap per cron cycle to bound execution time.

    if (loadErr) {
      console.error('[conflict] discovery query failed', loadErr);
      return result;
    }
    if (!links?.length) return result;

    result.discovered = links.length;

    // ---- 2. Group by user ---------------------------------------------
    const byUser = new Map<string, ConflictedLink[]>();
    for (const l of links as ConflictedLink[]) {
      const arr = byUser.get(l.user_id) ?? [];
      arr.push(l);
      byUser.set(l.user_id, arr);
    }

    // ---- 3. Process per user ------------------------------------------
    for (const [userId, userLinks] of byUser) {
      let ctx: UserCtx | null = null;
      try {
        ctx = await buildResolverContext(sb, userId);
      } catch (e: any) {
        console.error('[conflict] context build failed', userId, e?.message);
        result.errors += userLinks.length;
        continue;
      }

      for (const link of userLinks) {
        try {
          const outcome = await resolveOneConflict(sb, ctx, link);
          if (outcome === 'auto_resolved') result.auto_resolved += 1;
          else if (outcome === 'proposal_created') result.proposals_created += 1;
          else if (outcome === 'skipped_no_plan') result.skipped_no_plan += 1;
          else if (outcome === 'skipped_existing_proposal') result.skipped_existing_proposal += 1;
        } catch (e: any) {
          const status = e?.code ?? e?.response?.status;
          if (status === 401 || status === 403) {
            // Token died — mark as error and skip remaining.
            await sb
              .from('google_tokens')
              .update({ status: 'error', updated_at: new Date().toISOString() })
              .eq('user_id', userId)
              .eq('status', 'active');
            result.errors += userLinks.length - userLinks.indexOf(link);
            break;
          }
          console.error('[conflict] resolution failed', link.id, e?.message);
          result.errors += 1;
        }
      }
    }
  } catch (e: any) {
    console.error('[conflict] resolve catastrophic failure', e);
  }

  return result;
}

// =====================================================================
// Per-conflict resolver
// =====================================================================

type ConflictOutcome =
  | 'auto_resolved'
  | 'proposal_created'
  | 'skipped_no_plan'
  | 'skipped_existing_proposal';

async function resolveOneConflict(
  sb: SupabaseClient,
  ctx: UserCtx,
  link: ConflictedLink,
): Promise<ConflictOutcome> {
  // If the plan was deleted (plan_id set to null by FK cascade), we
  // can't project — just clear the conflict state.
  if (!link.plan_id) {
    await sb
      .from('calendar_links')
      .update({ sync_status: 'synced', last_error: null })
      .eq('id', link.id);
    return 'skipped_no_plan';
  }

  // ---- Load plan row --------------------------------------------------
  const { data: plan } = await sb
    .from('plans')
    .select('id, date, type, day_code, status, prescription')
    .eq('id', link.plan_id)
    .eq('user_id', link.user_id)
    .maybeSingle();

  if (!plan) {
    // Plan was deleted between enqueue and now. Clean up the link.
    await sb
      .from('calendar_links')
      .update({ sync_status: 'synced', last_error: null })
      .eq('id', link.id);
    return 'skipped_no_plan';
  }

  // ---- Project what we want on Google ---------------------------------
  const projected = projectPlanToEvent(plan as PlanRow, ctx.prefs, ctx.timezone);

  // ---- Fetch what Google currently has --------------------------------
  const remote = await fetchRemoteEvent(ctx.cal, link);

  // ---- Classify -------------------------------------------------------
  const classification = classifyConflict(projected, remote);

  // ---- Act on classification ------------------------------------------
  if (classification.kind === 'trivial') {
    return await autoResolve(sb, ctx, link, projected, remote);
  }

  // Meaningful conflict — create a proposal (idempotent: skip if one
  // already exists for this plan).
  return await createConflictProposal(sb, link, plan as PlanRow, projected, remote, classification);
}

// =====================================================================
// Auto-resolve (force-push)
// =====================================================================

async function autoResolve(
  sb: SupabaseClient,
  ctx: UserCtx,
  link: ConflictedLink,
  projected: ReturnType<typeof projectPlanToEvent>,
  remote: RemoteEvent,
): Promise<ConflictOutcome> {
  const freshEtag = remote.exists ? remote.etag : null;

  // Re-update the Google event with our projection and the fresh etag.
  const res = await ctx.cal.events.update({
    calendarId: link.google_calendar_id,
    eventId: link.google_event_id,
    requestBody: projected,
    ...(freshEtag ? { headers: { 'If-Match': freshEtag } } : {}),
  });

  const newEtag = res.headers?.etag ?? res.data.etag ?? null;
  const newChecksum = checksumEvent(projected);

  await sb
    .from('calendar_links')
    .update({
      checksum: newChecksum,
      google_etag: newEtag,
      sync_status: 'synced',
      last_error: null,
      last_attempt_at: new Date().toISOString(),
      attempt_count: 0,
      remote_snapshot: null,
    })
    .eq('id', link.id);

  return 'auto_resolved';
}

// =====================================================================
// Proposal creation (meaningful conflicts)
// =====================================================================

async function createConflictProposal(
  sb: SupabaseClient,
  link: ConflictedLink,
  plan: PlanRow,
  projected: ReturnType<typeof projectPlanToEvent>,
  remote: RemoteEvent,
  classification: ConflictClassification,
): Promise<ConflictOutcome> {
  // Idempotency: don't create a duplicate if a pending conflict
  // proposal already exists for this plan.
  const { data: existing } = await sb
    .from('ai_proposals')
    .select('id')
    .eq('user_id', link.user_id)
    .eq('kind', 'conflict')
    .eq('status', 'pending')
    .eq('source_activity_id', link.plan_id) // Reuse this column for plan_id ref
    .maybeSingle();

  if (existing) {
    return 'skipped_existing_proposal';
  }

  // Save the remote snapshot on the link for the proposal UI to reference.
  if (remote.exists) {
    await sb
      .from('calendar_links')
      .update({
        remote_snapshot: {
          summary: remote.summary,
          description: remote.description,
          start: remote.start,
          end: remote.end,
          etag: remote.etag,
        },
      })
      .eq('id', link.id);
  }

  // Build the proposal diff.
  const diff = {
    conflict_kind: classification.kind,
    plan_id: plan.id,
    plan_date: plan.date,
    plan_type: plan.type,
    plan_day_code: plan.day_code,
    calendar_link_id: link.id,
    google_event_id: link.google_event_id,
    google_calendar_id: link.google_calendar_id,
    projected: {
      summary: projected.summary,
      start: projected.start,
      end: projected.end,
    },
    remote: remote.exists
      ? {
          summary: remote.summary,
          start: remote.start,
          end: remote.end,
        }
      : null,
    options: classification.options,
  };

  await sb.from('ai_proposals').insert({
    user_id: link.user_id,
    kind: 'conflict',
    triggered_by: 'conflict_resolver',
    source_activity_id: link.plan_id, // plan reference
    status: 'pending',
    diff,
    rationale: classification.reason,
  });

  // Mark the link as awaiting proposal resolution. Don't flip to
  // 'synced' — the proposal apply handler will do that.
  await sb
    .from('calendar_links')
    .update({
      last_error: `awaiting proposal: ${classification.kind}`,
      last_attempt_at: new Date().toISOString(),
    })
    .eq('id', link.id);

  return 'proposal_created';
}

// =====================================================================
// Google fetch helper
// =====================================================================

async function fetchRemoteEvent(
  cal: calendar_v3.Calendar,
  link: ConflictedLink,
): Promise<RemoteEvent> {
  try {
    const res = await cal.events.get({
      calendarId: link.google_calendar_id,
      eventId: link.google_event_id,
    });

    const ev = res.data;
    return {
      exists: true,
      summary: ev.summary ?? '',
      description: ev.description ?? '',
      start: {
        dateTime: ev.start?.dateTime ?? undefined,
        date: ev.start?.date ?? undefined,
        timeZone: ev.start?.timeZone ?? undefined,
      },
      end: {
        dateTime: ev.end?.dateTime ?? undefined,
        date: ev.end?.date ?? undefined,
        timeZone: ev.end?.timeZone ?? undefined,
      },
      etag: ev.etag ?? null,
    };
  } catch (e: any) {
    const status = e?.code ?? e?.response?.status;
    if (status === 404) {
      return { exists: false };
    }
    // Any other error (401, 403, 5xx) bubbles up to the caller.
    throw e;
  }
}

// =====================================================================
// User context builder
// =====================================================================

async function buildResolverContext(
  sb: SupabaseClient,
  userId: string,
): Promise<UserCtx> {
  const [tokResult, prefsResult, profileResult] = await Promise.all([
    sb.from('google_tokens').select('*').eq('user_id', userId).maybeSingle(),
    sb.from('training_preferences').select('*').eq('user_id', userId).maybeSingle(),
    sb.from('profiles').select('timezone').eq('user_id', userId).maybeSingle(),
  ]);

  const tok = tokResult.data;
  if (!tok) throw new Error('no google_tokens row');
  if (tok.status !== 'active') throw new Error(`token status=${tok.status}`);
  if (!tok.training_calendar_id) throw new Error('no training_calendar_id');

  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
  oauth2.setCredentials({
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || undefined,
    expiry_date: tok.expires_at ? new Date(tok.expires_at).getTime() : undefined,
  });

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

  return { cal, calendarId: tok.training_calendar_id, prefs, timezone };
}

// =====================================================================
// Exports for tests
// =====================================================================

export {
  resolveOneConflict,
  autoResolve,
  createConflictProposal,
  fetchRemoteEvent,
  buildResolverContext,
};
export type { ConflictedLink, ConflictOutcome, UserCtx };
