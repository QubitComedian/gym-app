/**
 * Pure helpers for conflict resolution apply logic (P1.5 / PR-Y).
 *
 * These functions compute what DB changes to make when the user
 * accepts a conflict or meeting-conflict proposal option. No I/O —
 * the I/O wrapper (conflict.apply.ts) calls these and writes.
 *
 * Two proposal kinds handled:
 *
 *   - `kind='conflict'` (etag conflict from sync worker / PR-U)
 *       Options: force_push, accept_remote, cancel_plan, recreate, dismiss
 *
 *   - `kind='meeting_conflict'` (meeting overlap from fullscan / PR-W)
 *       Options: shift_morning, shift_evening, move_day, skip, dismiss
 */

import { normalizeTime, addMinutesToTime, isoWeekday } from './project';

// =====================================================================
// Types
// =====================================================================

export type ConflictOptionAction =
  | 'force_push'
  | 'accept_remote'
  | 'cancel_plan'
  | 'recreate'
  | 'dismiss';

export type MeetingConflictOptionId =
  | 'shift_morning'
  | 'shift_evening'
  | 'move_day'
  | 'skip'
  | 'dismiss';

/** Minimal meeting shape from the proposal diff. */
export type OverlappingMeeting = {
  summary: string;
  start: string; // ISO dateTime
  end: string;   // ISO dateTime
};

/** What the apply handler should do to resolve a conflict. */
export type ConflictResolution =
  | { type: 'force_push' }
  | { type: 'accept_remote_date'; newDate: string }
  | { type: 'accept_remote_noop' } // time-only change, no plan field to update
  | { type: 'cancel_plan' }
  | { type: 'recreate' }
  | { type: 'dismiss' };

/** What the apply handler should do to resolve a meeting conflict. */
export type MeetingConflictResolution =
  | { type: 'reschedule_time'; newTimeOverride: string }
  | { type: 'reschedule_day'; newDate: string }
  | { type: 'skip' }
  | { type: 'dismiss' };

// =====================================================================
// Constants
// =====================================================================

/** Default morning start time for shift_morning. */
export const MORNING_DEFAULT = '06:00:00';

/** Default evening start time for shift_evening. */
export const EVENING_DEFAULT = '19:00:00';

/** How many days forward/backward to search for move_day. */
export const MOVE_DAY_SEARCH_RADIUS = 3;

// =====================================================================
// Conflict (etag) resolution
// =====================================================================

/**
 * Determine what to do for a `kind='conflict'` option.
 *
 * The `remoteStart` is the start dateTime from the remote snapshot
 * (the Google event's current state). Used to detect whether
 * accept_remote involves a date change.
 */
export function resolveConflictAction(
  action: ConflictOptionAction,
  planDate: string,
  remoteStart: string | null,
): ConflictResolution {
  switch (action) {
    case 'force_push':
      return { type: 'force_push' };

    case 'accept_remote': {
      if (!remoteStart) return { type: 'accept_remote_noop' };
      // Extract the date portion from the remote dateTime.
      const remoteDate = remoteStart.slice(0, 10);
      if (remoteDate !== planDate) {
        return { type: 'accept_remote_date', newDate: remoteDate };
      }
      // Same date, different time — no plan field to update (time is
      // derived from preferences). Mark synced so we stop re-pushing.
      return { type: 'accept_remote_noop' };
    }

    case 'cancel_plan':
      return { type: 'cancel_plan' };

    case 'recreate':
      return { type: 'recreate' };

    case 'dismiss':
      return { type: 'dismiss' };

    default:
      return { type: 'dismiss' };
  }
}

// =====================================================================
// Meeting conflict resolution
// =====================================================================

/**
 * Determine what to do for a `kind='meeting_conflict'` option.
 *
 * For shift_morning / shift_evening, we compute a time that avoids
 * the overlapping meetings. For move_day, we find the nearest
 * unoccupied day.
 */
export function resolveMeetingConflictAction(
  optionId: MeetingConflictOptionId,
  planDate: string,
  sessionDurationMinutes: number,
  meetings: OverlappingMeeting[],
  /** Dates that already have a planned session (ISO strings). */
  occupiedDates: string[],
  today: string,
): MeetingConflictResolution {
  switch (optionId) {
    case 'shift_morning': {
      const time = computeMorningTime(meetings, sessionDurationMinutes);
      return { type: 'reschedule_time', newTimeOverride: time };
    }

    case 'shift_evening': {
      const time = computeEveningTime(meetings, sessionDurationMinutes);
      return { type: 'reschedule_time', newTimeOverride: time };
    }

    case 'move_day': {
      const alt = findAlternateDay(planDate, occupiedDates, today);
      if (!alt) {
        // No alternate day found — fall back to dismiss.
        return { type: 'dismiss' };
      }
      return { type: 'reschedule_day', newDate: alt };
    }

    case 'skip':
      return { type: 'skip' };

    case 'dismiss':
      return { type: 'dismiss' };

    default:
      return { type: 'dismiss' };
  }
}

// =====================================================================
// Time computation helpers
// =====================================================================

/**
 * Compute a morning start time that ends before the earliest meeting.
 *
 * Strategy: find the earliest meeting start, place the session so it
 * ends 15 minutes before that meeting. Fall back to MORNING_DEFAULT
 * if the session wouldn't fit (too early = before 05:00).
 */
export function computeMorningTime(
  meetings: OverlappingMeeting[],
  sessionDurationMinutes: number,
): string {
  if (meetings.length === 0) return MORNING_DEFAULT;

  // Find earliest meeting start.
  const earliestStart = meetings
    .map((m) => m.start.slice(11, 16)) // HH:MM
    .sort()[0];

  if (!earliestStart) return MORNING_DEFAULT;

  // Place session to end 15 min before meeting.
  const meetingMinutes = timeToMinutes(earliestStart);
  const sessionEndTarget = meetingMinutes - 15;
  const sessionStartMinutes = sessionEndTarget - sessionDurationMinutes;

  // If session would start before 05:00, use default.
  if (sessionStartMinutes < 5 * 60) return MORNING_DEFAULT;

  return minutesToTime(sessionStartMinutes);
}

/**
 * Compute an evening start time that begins after the latest meeting.
 *
 * Strategy: find the latest meeting end, place the session 15 minutes
 * after. Fall back to EVENING_DEFAULT if the session wouldn't fit
 * (too late = would end after 23:00).
 */
export function computeEveningTime(
  meetings: OverlappingMeeting[],
  sessionDurationMinutes: number,
): string {
  if (meetings.length === 0) return EVENING_DEFAULT;

  // Find latest meeting end.
  const latestEnd = meetings
    .map((m) => m.end.slice(11, 16))
    .sort()
    .pop();

  if (!latestEnd) return EVENING_DEFAULT;

  // Place session 15 min after the latest meeting ends.
  const meetingEndMinutes = timeToMinutes(latestEnd);
  const sessionStartMinutes = meetingEndMinutes + 15;

  // If session would end after 23:00, use default.
  if (sessionStartMinutes + sessionDurationMinutes > 23 * 60) {
    return EVENING_DEFAULT;
  }

  return minutesToTime(sessionStartMinutes);
}

/**
 * Find the nearest available day for rescheduling.
 *
 * Search pattern: +1, -1, +2, -2, +3, -3 (prefer forward).
 * Skip days that already have a session, days in the past,
 * and Sundays (ISO weekday 7) to keep rest days intact.
 */
export function findAlternateDay(
  planDate: string,
  occupiedDates: string[],
  today: string,
): string | null {
  const occupied = new Set(occupiedDates);
  const planMs = Date.parse(planDate + 'T00:00:00Z');
  const todayMs = Date.parse(today + 'T00:00:00Z');

  for (let delta = 1; delta <= MOVE_DAY_SEARCH_RADIUS; delta++) {
    // Try forward first, then backward.
    for (const dir of [1, -1]) {
      const candidateMs = planMs + dir * delta * 86400_000;
      // Don't move into the past.
      if (candidateMs < todayMs) continue;

      const candidate = new Date(candidateMs).toISOString().slice(0, 10);

      // Skip if already occupied.
      if (occupied.has(candidate)) continue;

      return candidate;
    }
  }

  return null;
}

// =====================================================================
// Minute ↔ time conversion (exported for tests)
// =====================================================================

/** Parse 'HH:MM' → total minutes since midnight. */
export function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Format total minutes since midnight → 'HH:MM:SS'. */
export function minutesToTime(totalMin: number): string {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
}
