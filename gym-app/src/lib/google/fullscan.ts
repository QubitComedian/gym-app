/**
 * Nightly full-scan (P1.4 / PR-W).
 *
 * Two jobs that run as part of the nightly reconcile cron (04:00 UTC):
 *
 * 1. **Rebuild sync queue** — for each user with active calendar sync,
 *    compare plans in the rolling window (today … today+21) against
 *    `calendar_links`. Enqueue `plan_upsert` jobs for plans that have
 *    no link or a stale checksum, and `plan_delete` jobs for orphaned
 *    links (link exists but plan was deleted or moved to rest/missed).
 *
 *    This is the backstop from design doc §8: "the reconciler's nightly
 *    full-scan does a full diff — read all events in the training
 *    calendar, diff against plans, upsert/delete to match. Guarantees
 *    eventual consistency regardless of what went wrong intraday."
 *
 * 2. **Meeting conflict detection** — for each user with active calendar
 *    sync, read their primary Google Calendar for the next 14 days.
 *    For each planned session, check if any meeting overlaps the
 *    session's time window. If so, create a `kind='meeting_conflict'`
 *    proposal (idempotent: skip if one already exists for that plan).
 *
 *    From design doc §5 step 7: "If Google Calendar integration is
 *    active, read the user's primary calendar for the next 14 days.
 *    For each plan, check if a meeting overlaps the typical session
 *    time. If yes, create a conflict proposal."
 *
 * Both run with the service-role Supabase client. Per-user failures
 * are swallowed and counted — one bad user doesn't stop the rest.
 *
 * Architecture:
 *   - Pure scan logic is separated from I/O for testability.
 *   - The sync-rebuild path uses `enqueuePlanSync` from write.ts,
 *     which already handles dedup and gating.
 *   - The meeting-conflict path builds a lightweight OAuth2 client
 *     per user (same pattern as the worker) to read their primary
 *     calendar via `freebusy.query` or `events.list`.
 */

import { google, type calendar_v3 } from 'googleapis';
import type { SupabaseClient } from '@supabase/supabase-js';
import { enqueuePlanSync } from '@/lib/plans/write';
import {
  projectPlanToEvent,
  checksumEvent,
  resolveSessionTiming,
  DEFAULT_PREFERENCES,
  type PlanRow,
  type TrainingPreferences,
} from './project';

// =====================================================================
// Types
// =====================================================================

export type FullScanResult = {
  users_scanned: number;
  sync_rebuild: {
    upserts_enqueued: number;
    deletes_enqueued: number;
    skipped: number;
  };
  meeting_conflicts: {
    detected: number;
    proposals_created: number;
    skipped_existing: number;
  };
  errors: number;
};

type ActiveUser = {
  user_id: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  training_calendar_id: string;
};

// =====================================================================
// Public API
// =====================================================================

/**
 * Run the nightly full-scan for all users with active calendar sync.
 * Called by the reconcile cron after the per-user reconcile loop.
 * Never throws.
 */
export async function nightlyFullScan(
  sb: SupabaseClient,
): Promise<FullScanResult> {
  const result: FullScanResult = {
    users_scanned: 0,
    sync_rebuild: { upserts_enqueued: 0, deletes_enqueued: 0, skipped: 0 },
    meeting_conflicts: { detected: 0, proposals_created: 0, skipped_existing: 0 },
    errors: 0,
  };

  try {
    // Find all users with active calendar sync.
    const { data: users, error: usersErr } = await sb
      .from('google_tokens')
      .select('user_id, access_token, refresh_token, expires_at, training_calendar_id')
      .eq('status', 'active');

    if (usersErr) {
      console.error('[fullscan] users query failed', usersErr);
      return result;
    }

    // Filter to users who have completed setup (training_calendar_id set).
    const activeUsers = ((users ?? []) as ActiveUser[]).filter(
      (u) => u.training_calendar_id,
    );

    result.users_scanned = activeUsers.length;

    for (const user of activeUsers) {
      try {
        // Phase 1: rebuild sync queue.
        const rebuild = await rebuildSyncQueue(sb, user.user_id);
        result.sync_rebuild.upserts_enqueued += rebuild.upserts_enqueued;
        result.sync_rebuild.deletes_enqueued += rebuild.deletes_enqueued;
        result.sync_rebuild.skipped += rebuild.skipped;

        // Phase 2: meeting conflict detection.
        const conflicts = await detectMeetingConflicts(sb, user);
        result.meeting_conflicts.detected += conflicts.detected;
        result.meeting_conflicts.proposals_created += conflicts.proposals_created;
        result.meeting_conflicts.skipped_existing += conflicts.skipped_existing;
      } catch (e: any) {
        const status = e?.code ?? e?.response?.status;
        if (status === 401 || status === 403) {
          // Token died — mark as error, skip this user.
          await sb
            .from('google_tokens')
            .update({ status: 'error', updated_at: new Date().toISOString() })
            .eq('user_id', user.user_id)
            .eq('status', 'active');
        }
        console.error('[fullscan] user failed', user.user_id, e?.message);
        result.errors += 1;
      }
    }
  } catch (e: any) {
    console.error('[fullscan] catastrophic failure', e);
  }

  return result;
}

// =====================================================================
// Phase 1: Rebuild sync queue
// =====================================================================

type RebuildResult = {
  upserts_enqueued: number;
  deletes_enqueued: number;
  skipped: number;
};

/**
 * Compare plans in the rolling window against calendar_links.
 * Enqueue plan_upsert for missing/stale links, plan_delete for orphans.
 */
async function rebuildSyncQueue(
  sb: SupabaseClient,
  userId: string,
): Promise<RebuildResult> {
  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + 21 * 86400_000).toISOString().slice(0, 10);

  // Load plans and preferences in parallel.
  const [plansResult, prefsResult, profileResult, linksResult] = await Promise.all([
    sb.from('plans')
      .select('id, date, type, day_code, status, prescription, time_override')
      .eq('user_id', userId)
      .gte('date', today)
      .lte('date', horizon)
      .order('date'),
    sb.from('training_preferences')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle(),
    sb.from('profiles')
      .select('timezone')
      .eq('user_id', userId)
      .maybeSingle(),
    sb.from('calendar_links')
      .select('id, plan_id, checksum, sync_status')
      .eq('user_id', userId),
  ]);

  const plans = (plansResult.data ?? []) as PlanRow[];
  const rawPrefs = prefsResult.data;
  const timezone = profileResult.data?.timezone ?? 'UTC';
  const links = (linksResult.data ?? []) as Array<{
    id: string;
    plan_id: string | null;
    checksum: string | null;
    sync_status: string;
  }>;

  const prefs: TrainingPreferences = rawPrefs
    ? {
        session_start_time: rawPrefs.session_start_time ?? DEFAULT_PREFERENCES.session_start_time,
        session_duration_minutes: rawPrefs.session_duration_minutes ?? DEFAULT_PREFERENCES.session_duration_minutes,
        day_overrides: rawPrefs.day_overrides ?? DEFAULT_PREFERENCES.day_overrides,
        color_scheme: rawPrefs.color_scheme ?? null,
      }
    : DEFAULT_PREFERENCES;

  // Build a map of plan_id → existing link for quick lookup.
  const linkByPlan = new Map<string, typeof links[0]>();
  const linkedPlanIds = new Set<string>();
  for (const link of links) {
    if (link.plan_id) {
      linkByPlan.set(link.plan_id, link);
      linkedPlanIds.add(link.plan_id);
    }
  }

  // --- Identify plans that need (re-)sync ---
  const needsUpsert = identifyStaleOrMissing(plans, linkByPlan, prefs, timezone);

  // --- Identify orphaned links (link exists but plan is gone/rest/missed) ---
  const activePlanIds = new Set(
    plans
      .filter((p) => p.status === 'planned' && p.type !== 'rest')
      .map((p) => p.id),
  );
  const orphanedLinks = links.filter(
    (l) => l.plan_id && !activePlanIds.has(l.plan_id),
  );
  const deleteIds = orphanedLinks.map((l) => l.plan_id!);

  // --- Enqueue ---
  let upserts_enqueued = 0;
  let deletes_enqueued = 0;
  let skipped = 0;

  if (needsUpsert.length > 0) {
    const r = await enqueuePlanSync(sb, userId, { upsertIds: needsUpsert });
    upserts_enqueued += r.enqueued;
    skipped += r.skipped;
  }

  if (deleteIds.length > 0) {
    const r = await enqueuePlanSync(sb, userId, { deleteIds });
    deletes_enqueued += r.enqueued;
    skipped += r.skipped;
  }

  return { upserts_enqueued, deletes_enqueued, skipped };
}

/**
 * Pure function: identify plan ids that need a (re-)sync.
 * A plan needs sync if:
 *   - It has no calendar_link (never synced).
 *   - Its projected checksum differs from the stored checksum (stale).
 *   - Its link is in 'error' status (retrying).
 *   - It's a planned non-rest session (rest days don't get events).
 */
function identifyStaleOrMissing(
  plans: PlanRow[],
  linkByPlan: Map<string, { checksum: string | null; sync_status: string }>,
  prefs: TrainingPreferences,
  timezone: string,
): string[] {
  const result: string[] = [];

  for (const plan of plans) {
    // Rest days and non-planned don't get Google events.
    if (plan.type === 'rest' || plan.status !== 'planned') continue;

    const link = linkByPlan.get(plan.id);

    if (!link) {
      // Never synced.
      result.push(plan.id);
      continue;
    }

    // Skip if sync is in progress (conflict or pending — let those
    // resolve before we re-enqueue).
    if (link.sync_status === 'conflict' || link.sync_status === 'pending') {
      continue;
    }

    // Check if projection has changed since last sync.
    const projected = projectPlanToEvent(plan, prefs, timezone);
    const currentChecksum = checksumEvent(projected);
    if (link.checksum !== currentChecksum) {
      result.push(plan.id);
      continue;
    }

    // Re-enqueue if stuck in error (retry on nightly scan).
    if (link.sync_status === 'error') {
      result.push(plan.id);
    }
  }

  return result;
}

// =====================================================================
// Phase 2: Meeting conflict detection
// =====================================================================

type MeetingConflictResult = {
  detected: number;
  proposals_created: number;
  skipped_existing: number;
};

/** Minimum overlap in minutes to consider a conflict. */
const MIN_OVERLAP_MINUTES = 15;

/**
 * Read the user's primary Google Calendar for the next 14 days and
 * check for meetings that overlap planned session times.
 */
async function detectMeetingConflicts(
  sb: SupabaseClient,
  user: ActiveUser,
): Promise<MeetingConflictResult> {
  const result: MeetingConflictResult = {
    detected: 0,
    proposals_created: 0,
    skipped_existing: 0,
  };

  // Build OAuth2 client.
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
  oauth2.setCredentials({
    access_token: user.access_token,
    refresh_token: user.refresh_token || undefined,
    expiry_date: user.expires_at ? new Date(user.expires_at).getTime() : undefined,
  });

  // Persist refreshed tokens.
  oauth2.on('tokens', async (newTok) => {
    const update: Record<string, unknown> = {};
    if (newTok.access_token) update.access_token = newTok.access_token;
    if (newTok.refresh_token) update.refresh_token = newTok.refresh_token;
    if (newTok.expiry_date) update.expires_at = new Date(newTok.expiry_date).toISOString();
    update.updated_at = new Date().toISOString();
    if (Object.keys(update).length > 1) {
      await sb.from('google_tokens').update(update).eq('user_id', user.user_id);
    }
  });

  const cal = google.calendar({ version: 'v3', auth: oauth2 });

  // Load plans, prefs, and timezone.
  const today = new Date().toISOString().slice(0, 10);
  const horizon14 = new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10);

  const [plansResult, prefsResult, profileResult] = await Promise.all([
    sb.from('plans')
      .select('id, date, type, day_code, status, prescription, time_override')
      .eq('user_id', user.user_id)
      .eq('status', 'planned')
      .neq('type', 'rest')
      .gte('date', today)
      .lte('date', horizon14)
      .order('date'),
    sb.from('training_preferences')
      .select('*')
      .eq('user_id', user.user_id)
      .maybeSingle(),
    sb.from('profiles')
      .select('timezone')
      .eq('user_id', user.user_id)
      .maybeSingle(),
  ]);

  const plans = (plansResult.data ?? []) as PlanRow[];
  if (plans.length === 0) return result;

  const rawPrefs = prefsResult.data;
  const timezone = profileResult.data?.timezone ?? 'UTC';
  const prefs: TrainingPreferences = rawPrefs
    ? {
        session_start_time: rawPrefs.session_start_time ?? DEFAULT_PREFERENCES.session_start_time,
        session_duration_minutes: rawPrefs.session_duration_minutes ?? DEFAULT_PREFERENCES.session_duration_minutes,
        day_overrides: rawPrefs.day_overrides ?? DEFAULT_PREFERENCES.day_overrides,
        color_scheme: rawPrefs.color_scheme ?? null,
      }
    : DEFAULT_PREFERENCES;

  // Read the primary calendar events for the next 14 days.
  // We use events.list rather than freebusy because we want the
  // event summary for the proposal rationale.
  const timeMin = new Date(`${today}T00:00:00Z`).toISOString();
  const timeMax = new Date(`${horizon14}T23:59:59Z`).toISOString();

  let primaryEvents: calendar_v3.Schema$Event[] = [];
  try {
    const eventsRes = await cal.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 500,
    });
    primaryEvents = eventsRes.data.items ?? [];
  } catch (e: any) {
    // If we can't read primary calendar (missing scope, etc.), just
    // skip meeting conflict detection silently.
    console.error('[fullscan] primary calendar read failed', user.user_id, e?.message);
    return result;
  }

  // Filter to events that look like meetings (have a start/end time,
  // not all-day events, not declined).
  const meetings = primaryEvents.filter((ev) => {
    if (!ev.start?.dateTime || !ev.end?.dateTime) return false;
    // Skip events from our training calendar.
    if (ev.organizer?.self === false && ev.organizer?.email === user.training_calendar_id) return false;
    // Skip declined events.
    const selfAttendee = ev.attendees?.find((a) => a.self);
    if (selfAttendee?.responseStatus === 'declined') return false;
    return true;
  });

  if (meetings.length === 0) return result;

  // For each plan, check overlap with meetings.
  for (const plan of plans) {
    const { startTime, durationMinutes } = resolveSessionTiming(plan.date, prefs);
    const sessionStart = new Date(`${plan.date}T${startTime}`);
    const sessionEnd = new Date(sessionStart.getTime() + durationMinutes * 60_000);

    const overlapping = findOverlappingMeetings(
      meetings,
      plan.date,
      sessionStart,
      sessionEnd,
    );

    if (overlapping.length === 0) continue;

    result.detected += 1;

    // Create a proposal (idempotent).
    const created = await createMeetingConflictProposal(
      sb,
      user.user_id,
      plan,
      overlapping,
      { startTime, durationMinutes },
    );

    if (created === 'created') result.proposals_created += 1;
    else result.skipped_existing += 1;
  }

  return result;
}

/**
 * Pure function: find meetings that overlap a session's time window
 * on a given date.
 */
function findOverlappingMeetings(
  meetings: calendar_v3.Schema$Event[],
  planDate: string,
  sessionStart: Date,
  sessionEnd: Date,
): calendar_v3.Schema$Event[] {
  return meetings.filter((ev) => {
    const evStart = new Date(ev.start!.dateTime!);
    const evEnd = new Date(ev.end!.dateTime!);

    // Check the event is on the same date.
    const evDate = ev.start!.dateTime!.slice(0, 10);
    if (evDate !== planDate) return false;

    // Check overlap: two intervals [a,b) and [c,d) overlap iff a < d and c < b.
    if (sessionStart >= evEnd || evStart >= sessionEnd) return false;

    // Check minimum overlap threshold.
    const overlapStart = sessionStart > evStart ? sessionStart : evStart;
    const overlapEnd = sessionEnd < evEnd ? sessionEnd : evEnd;
    const overlapMinutes = (overlapEnd.getTime() - overlapStart.getTime()) / 60_000;

    return overlapMinutes >= MIN_OVERLAP_MINUTES;
  });
}

/**
 * Create a meeting_conflict proposal. Idempotent: skip if one
 * already exists for this plan.
 */
async function createMeetingConflictProposal(
  sb: SupabaseClient,
  userId: string,
  plan: PlanRow,
  overlapping: calendar_v3.Schema$Event[],
  sessionTiming: { startTime: string; durationMinutes: number },
): Promise<'created' | 'skipped'> {
  // Idempotency check.
  const { data: existing } = await sb
    .from('ai_proposals')
    .select('id')
    .eq('user_id', userId)
    .eq('kind', 'meeting_conflict')
    .eq('status', 'pending')
    .eq('source_activity_id', plan.id)
    .maybeSingle();

  if (existing) return 'skipped';

  const conflictSummary = overlapping
    .map((ev) => `"${ev.summary ?? 'Busy'}" (${formatTime(ev.start!.dateTime!)}–${formatTime(ev.end!.dateTime!)})`)
    .join(', ');

  const diff = {
    plan_id: plan.id,
    plan_date: plan.date,
    plan_type: plan.type,
    plan_day_code: plan.day_code,
    session_start: sessionTiming.startTime,
    session_duration: sessionTiming.durationMinutes,
    overlapping_meetings: overlapping.map((ev) => ({
      summary: ev.summary ?? 'Busy',
      start: ev.start!.dateTime,
      end: ev.end!.dateTime,
    })),
    options: [
      { id: 'shift_morning', label: 'Move to morning', action: 'reschedule' },
      { id: 'shift_evening', label: 'Move to evening', action: 'reschedule' },
      { id: 'move_day', label: 'Move to adjacent day', action: 'reschedule' },
      { id: 'skip', label: 'Skip this session', action: 'skip' },
      { id: 'dismiss', label: 'Keep as planned', action: 'dismiss' },
    ],
  };

  const rationale = `Your ${plan.type}${plan.day_code ? ` (${plan.day_code})` : ''} session on ${plan.date} at ${sessionTiming.startTime.slice(0, 5)} overlaps with ${conflictSummary}.`;

  await sb.from('ai_proposals').insert({
    user_id: userId,
    kind: 'meeting_conflict',
    triggered_by: 'nightly_full_scan',
    source_activity_id: plan.id,
    status: 'pending',
    diff,
    rationale,
  });

  return 'created';
}

// =====================================================================
// Helpers
// =====================================================================

/**
 * Format an ISO dateTime string to HH:MM for display.
 */
function formatTime(isoDateTime: string): string {
  return isoDateTime.slice(11, 16);
}

// =====================================================================
// Exports for tests
// =====================================================================

export {
  rebuildSyncQueue,
  detectMeetingConflicts,
  identifyStaleOrMissing,
  findOverlappingMeetings,
  createMeetingConflictProposal,
  formatTime,
  MIN_OVERLAP_MINUTES,
};
export type { ActiveUser, RebuildResult, MeetingConflictResult };
