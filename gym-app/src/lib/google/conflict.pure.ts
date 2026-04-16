/**
 * Pure conflict classification (P1.4 / PR-U).
 *
 * Given what we projected locally and what Google currently holds,
 * classify the conflict so the resolver can decide whether to
 * force-push (trivial) or create a proposal (meaningful).
 *
 * Design philosophy — from docs/calendar-system.md §1:
 *
 *   "The app is the source of truth, the calendar is a projection."
 *
 * Most etag conflicts are trivial: Google gave us a new etag because
 * something invisible changed (response status, attendee accept, etc.)
 * or because the user made a cosmetic tweak (moved by 5 min, fixed a
 * typo). The right default is to silently re-push our projection.
 *
 * A "meaningful" conflict is one where the user clearly expressed
 * intent by moving the session to a different time or deleting it.
 * Those get a proposal so the user can decide.
 *
 * Taxonomy:
 *
 *   - `trivial`          — content unchanged or only description/color
 *                           differs. Force-push safely.
 *   - `time_moved`       — the user shifted the start or end time (or
 *                           date) in Google. Proposal: keep app time,
 *                           accept Google time, or dismiss.
 *   - `content_edited`   — the summary changed meaningfully (user
 *                           renamed the event). Proposal: keep ours,
 *                           accept theirs.
 *   - `deleted_remotely` — the Google event no longer exists (404 from
 *                           events.get). Proposal: recreate, or
 *                           cancel the plan.
 */

import type { GoogleEventBody } from './project';

// =====================================================================
// Types
// =====================================================================

/** What the resolver fetched from Google. */
export type RemoteEvent = {
  /** Event still exists on Google. */
  exists: true;
  summary: string;
  description: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  etag: string | null;
} | {
  /** Event was deleted on Google (events.get returned 404). */
  exists: false;
};

export type ConflictKind =
  | 'trivial'
  | 'time_moved'
  | 'content_edited'
  | 'deleted_remotely';

export type ConflictClassification = {
  kind: ConflictKind;
  /** Human-readable explanation for the rationale field. */
  reason: string;
  /** When kind !== 'trivial', the proposal options. */
  options?: ConflictOption[];
};

export type ConflictOption = {
  id: string;
  label: string;
  /** What happens if the user picks this option. */
  action: 'force_push' | 'accept_remote' | 'cancel_plan' | 'recreate' | 'dismiss';
};

// =====================================================================
// Classification
// =====================================================================

export function classifyConflict(
  projected: GoogleEventBody,
  remote: RemoteEvent,
): ConflictClassification {
  // ---- Deleted remotely -----------------------------------------------
  if (!remote.exists) {
    return {
      kind: 'deleted_remotely',
      reason: 'The Google Calendar event was deleted externally.',
      options: [
        { id: 'recreate', label: 'Recreate the event', action: 'recreate' },
        { id: 'cancel', label: 'Cancel this session', action: 'cancel_plan' },
        { id: 'dismiss', label: 'Leave as-is (no Google event)', action: 'dismiss' },
      ],
    };
  }

  // ---- Event exists — compare fields ----------------------------------
  const timeMoved = isTimeMoved(projected, remote);
  const summaryChanged = isSummaryChanged(projected.summary, remote.summary);

  // Time was moved — this is the strongest signal of user intent.
  if (timeMoved) {
    return {
      kind: 'time_moved',
      reason: `Event was moved in Google Calendar (${describeTimeChange(projected, remote)}).`,
      options: [
        { id: 'keep_app', label: 'Keep app schedule', action: 'force_push' },
        { id: 'accept_google', label: 'Accept Google time', action: 'accept_remote' },
        { id: 'dismiss', label: 'Dismiss', action: 'dismiss' },
      ],
    };
  }

  // Summary was meaningfully renamed (not just whitespace/emoji).
  if (summaryChanged) {
    return {
      kind: 'content_edited',
      reason: `Event was renamed in Google Calendar ("${remote.summary}").`,
      options: [
        { id: 'keep_app', label: 'Keep app title', action: 'force_push' },
        { id: 'accept_google', label: 'Accept Google title', action: 'accept_remote' },
        { id: 'dismiss', label: 'Dismiss', action: 'dismiss' },
      ],
    };
  }

  // Everything else — description changed, color changed, attendees
  // tweaked, response status changed, etc. All trivial.
  return {
    kind: 'trivial',
    reason: 'Etag changed but no meaningful content difference.',
  };
}

// =====================================================================
// Comparison helpers (exported for tests)
// =====================================================================

/**
 * True if the remote event's start or end dateTime differs from our
 * projection. We normalize both to bare `YYYY-MM-DDTHH:MM:SS` for
 * comparison (stripping timezone suffix and trailing zeros) since
 * Google may return offsets like `+02:00` while we send bare
 * dateTime + timeZone.
 */
export function isTimeMoved(
  projected: GoogleEventBody,
  remote: Extract<RemoteEvent, { exists: true }>,
): boolean {
  const projStart = normalizeDT(projected.start.dateTime);
  const projEnd = normalizeDT(projected.end.dateTime);
  const remStart = normalizeDT(remote.start.dateTime ?? remote.start.date ?? '');
  const remEnd = normalizeDT(remote.end.dateTime ?? remote.end.date ?? '');

  return projStart !== remStart || projEnd !== remEnd;
}

/**
 * True if the summary changed meaningfully. We strip emoji and
 * normalize whitespace before comparing so cosmetic tweaks (extra
 * space, different emoji) don't trigger a proposal.
 */
export function isSummaryChanged(
  projected: string,
  remote: string,
): boolean {
  return normalizeSummary(projected) !== normalizeSummary(remote);
}

/**
 * Describe the time change for the rationale field.
 */
export function describeTimeChange(
  projected: GoogleEventBody,
  remote: Extract<RemoteEvent, { exists: true }>,
): string {
  const remStart = remote.start.dateTime ?? remote.start.date ?? '?';
  const projStart = projected.start.dateTime;
  return `app: ${projStart}, Google: ${remStart}`;
}

// =====================================================================
// Normalization utilities (exported for tests)
// =====================================================================

/**
 * Normalize a dateTime string to `YYYY-MM-DDTHH:MM:SS` by stripping
 * timezone offset, 'Z' suffix, and milliseconds. This lets us compare
 * wall-clock times without timezone noise.
 *
 * Examples:
 *   '2026-04-16T07:00:00'        → '2026-04-16T07:00:00'
 *   '2026-04-16T07:00:00+02:00'  → '2026-04-16T07:00:00'
 *   '2026-04-16T07:00:00Z'       → '2026-04-16T07:00:00'
 *   '2026-04-16T07:00:00.000Z'   → '2026-04-16T07:00:00'
 *   '2026-04-16'                  → '2026-04-16'
 */
export function normalizeDT(dt: string): string {
  if (!dt) return '';
  // Strip milliseconds (.000)
  let s = dt.replace(/\.\d+/, '');
  // Strip Z suffix
  s = s.replace(/Z$/, '');
  // Strip timezone offset (+HH:MM or -HH:MM)
  s = s.replace(/[+-]\d{2}:\d{2}$/, '');
  return s;
}

/**
 * Normalize a summary for comparison: strip emoji (all chars in the
 * Emoji presentation range), collapse whitespace, lowercase, trim.
 */
export function normalizeSummary(s: string): string {
  return s
    // Strip emoji (broad Unicode ranges covering most presentation emoji)
    .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
