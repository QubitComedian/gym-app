/**
 * Calendar connect / disconnect logic (P1.4 / PR-V).
 *
 * Handles the post-OAuth calendar setup: create a dedicated training
 * calendar on Google, store its id, and enqueue a full backfill of all
 * planned sessions. Also handles disconnect (revoke status, clear
 * calendar id).
 *
 * Separated from the route handlers so the core logic is testable
 * without HTTP plumbing.
 *
 * Architecture:
 *   - Uses the cookie-based Supabase client (user context) for reads
 *     and writes — these are user-initiated actions, not cron jobs.
 *   - Builds an OAuth2 client with GOOGLE_CLIENT_ID / SECRET so token
 *     refresh works server-side (same pattern as the worker).
 *   - The "connect" flow is idempotent: if training_calendar_id is
 *     already set and the calendar still exists on Google, we skip
 *     creation and just re-run the backfill.
 */

import { google, type calendar_v3 } from 'googleapis';
import type { SupabaseClient } from '@supabase/supabase-js';
import { enqueuePlanSync } from '@/lib/plans/write';

// =====================================================================
// Types
// =====================================================================

export type ConnectResult = {
  calendar_id: string;
  calendar_name: string;
  backfill_enqueued: number;
  backfill_skipped: number;
  already_connected: boolean;
};

export type DisconnectResult = {
  disconnected: boolean;
};

export type CalendarStatus = {
  connected: boolean;
  status: 'active' | 'error' | 'revoked' | 'not_connected';
  training_calendar_id: string | null;
  training_calendar_name: string | null;
  last_error: string | null;
};

// =====================================================================
// Connect
// =====================================================================

const CALENDAR_NAME = 'Training';

/**
 * Create (or re-use) a dedicated training calendar on Google and
 * enqueue a full backfill of all planned sessions.
 *
 * Idempotent: if the user already has a training_calendar_id that
 * still exists on Google, we skip creation and just re-backfill.
 */
export async function connectCalendar(
  sb: SupabaseClient,
  userId: string,
): Promise<ConnectResult> {
  // ---- Load token row --------------------------------------------------
  const { data: tok, error: tokErr } = await sb
    .from('google_tokens')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (tokErr || !tok) {
    throw new Error('No Google tokens found. Please sign out and back in to grant calendar access.');
  }

  // ---- Build OAuth2 client ---------------------------------------------
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
  oauth2.setCredentials({
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || undefined,
    expiry_date: tok.expires_at ? new Date(tok.expires_at).getTime() : undefined,
  });

  // Persist refreshed tokens.
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

  // ---- Check if already connected with a valid calendar ----------------
  let calendarId = tok.training_calendar_id;
  let calendarName = CALENDAR_NAME;
  let alreadyConnected = false;

  if (calendarId) {
    // Verify the calendar still exists on Google.
    try {
      const existing = await cal.calendars.get({ calendarId });
      calendarName = existing.data.summary ?? CALENDAR_NAME;
      alreadyConnected = true;
    } catch (e: any) {
      const status = e?.code ?? e?.response?.status;
      if (status === 404) {
        // Calendar was deleted on Google — recreate.
        calendarId = null;
      } else {
        throw e;
      }
    }
  }

  // ---- Create dedicated calendar if needed -----------------------------
  if (!calendarId) {
    const created = await cal.calendars.insert({
      requestBody: {
        summary: CALENDAR_NAME,
        description: 'Auto-managed by your training app. Edits here sync back.',
        timeZone: await getUserTimezone(sb, userId),
      },
    });
    calendarId = created.data.id!;
    calendarName = created.data.summary ?? CALENDAR_NAME;
  }

  // ---- Store calendar id + mark active ---------------------------------
  await sb
    .from('google_tokens')
    .update({
      training_calendar_id: calendarId,
      status: 'active',
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId);

  // ---- Enqueue full backfill -------------------------------------------
  const backfill = await enqueueFullBackfill(sb, userId);

  return {
    calendar_id: calendarId,
    calendar_name: calendarName,
    backfill_enqueued: backfill.enqueued,
    backfill_skipped: backfill.skipped,
    already_connected: alreadyConnected,
  };
}

// =====================================================================
// Disconnect
// =====================================================================

/**
 * Disconnect Google Calendar sync. Sets token status to 'revoked' and
 * clears training_calendar_id. Does NOT delete the Google calendar or
 * its events — past events stay where they are (per design doc §8).
 */
export async function disconnectCalendar(
  sb: SupabaseClient,
  userId: string,
): Promise<DisconnectResult> {
  const { data: tok } = await sb
    .from('google_tokens')
    .select('status')
    .eq('user_id', userId)
    .maybeSingle();

  if (!tok) {
    return { disconnected: false };
  }

  await sb
    .from('google_tokens')
    .update({
      status: 'revoked',
      training_calendar_id: null,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId);

  return { disconnected: true };
}

// =====================================================================
// Status
// =====================================================================

/**
 * Return the user's Google Calendar connection status for the UI.
 */
export async function getCalendarStatus(
  sb: SupabaseClient,
  userId: string,
): Promise<CalendarStatus> {
  const { data: tok } = await sb
    .from('google_tokens')
    .select('status, training_calendar_id')
    .eq('user_id', userId)
    .maybeSingle();

  if (!tok) {
    return {
      connected: false,
      status: 'not_connected',
      training_calendar_id: null,
      training_calendar_name: null,
      last_error: null,
    };
  }

  const connected = tok.status === 'active' && !!tok.training_calendar_id;

  return {
    connected,
    status: tok.status as CalendarStatus['status'],
    training_calendar_id: tok.training_calendar_id ?? null,
    training_calendar_name: connected ? CALENDAR_NAME : null,
    last_error: tok.status === 'error' ? 'Token refresh failed. Please reconnect.' : null,
  };
}

// =====================================================================
// Helpers
// =====================================================================

/**
 * Enqueue plan_upsert jobs for ALL planned sessions in the rolling
 * window (today through today+21). This is the "full backfill" that
 * runs when a user first connects their calendar.
 */
async function enqueueFullBackfill(
  sb: SupabaseClient,
  userId: string,
): Promise<{ enqueued: number; skipped: number }> {
  const today = new Date().toISOString().slice(0, 10);

  const { data: plans, error } = await sb
    .from('plans')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'planned')
    .gte('date', today)
    .neq('type', 'rest')
    .order('date');

  if (error || !plans?.length) {
    return { enqueued: 0, skipped: 0 };
  }

  const planIds = plans.map((p: { id: string }) => p.id);
  return enqueuePlanSync(sb, userId, { upsertIds: planIds });
}

/**
 * Read the user's timezone from their profile. Falls back to UTC.
 */
async function getUserTimezone(
  sb: SupabaseClient,
  userId: string,
): Promise<string> {
  const { data } = await sb
    .from('profiles')
    .select('timezone')
    .eq('user_id', userId)
    .maybeSingle();
  return data?.timezone ?? 'UTC';
}

// =====================================================================
// Exports for tests
// =====================================================================

export {
  enqueueFullBackfill,
  getUserTimezone,
  CALENDAR_NAME,
};
