/**
 * Presentation helpers for conflict + meeting_conflict proposals (P1.5 / PR-Z).
 *
 * Takes the raw `ai_proposals` row and produces the props needed by
 * ConflictBanner (Today page) and ConflictView (/ai/[id] detail page).
 *
 * Mirrors `returnFromGap.ts` and `phaseTransition.ts` — same file shape
 * so the Today page render stays free of proposal-shape knowledge.
 *
 * Two kinds handled:
 *
 *   - kind='conflict' — etag conflict from sync worker (time_moved,
 *     content_edited, deleted_remotely).
 *   - kind='meeting_conflict' — meeting overlap from nightly scan.
 */

import type { ConflictBannerProps } from '@/components/ConflictBanner';
import type { ConflictViewProps } from '@/components/ConflictView';

// =====================================================================
// Raw shapes (matching what conflict.ts / fullscan.ts write to diff)
// =====================================================================

type ConflictDiffRaw = {
  conflict_kind: string;
  plan_id: string;
  plan_date: string;
  plan_type: string;
  plan_day_code: string | null;
  calendar_link_id: string;
  google_event_id: string;
  google_calendar_id: string;
  projected: {
    summary: string;
    start: { dateTime: string; timeZone: string };
    end: { dateTime: string; timeZone: string };
  };
  remote: {
    summary: string;
    start: { dateTime?: string; date?: string; timeZone?: string };
    end: { dateTime?: string; date?: string; timeZone?: string };
  } | null;
  options: Array<{
    id: string;
    label: string;
    action: string;
  }>;
};

type MeetingConflictDiffRaw = {
  plan_id: string;
  plan_date: string;
  plan_type: string;
  plan_day_code: string | null;
  session_start: string;
  session_duration: number;
  overlapping_meetings: Array<{
    summary: string;
    start: string;
    end: string;
  }>;
  options: Array<{
    id: string;
    label: string;
    action: string;
  }>;
};

export type RawProposal = {
  id: string;
  kind: string | null;
  rationale: string | null;
  diff: unknown;
};

// =====================================================================
// Banner summarizer
// =====================================================================

export type ConflictBannerView = {
  view: 'banner';
  props: ConflictBannerProps;
} | null;

/**
 * Produce banner props for a conflict or meeting_conflict proposal.
 * Returns null if the proposal can't be summarized.
 */
export function summarizeConflictProposal(prop: RawProposal): ConflictBannerView {
  const kind = prop.kind;
  if (kind !== 'conflict' && kind !== 'meeting_conflict') return null;

  if (kind === 'conflict') {
    const diff = prop.diff as ConflictDiffRaw | null;
    if (!diff) return null;

    const headline = buildConflictHeadline(diff);
    return {
      view: 'banner',
      props: {
        id: prop.id,
        kind: 'conflict',
        headline,
        subhead: prop.rationale ?? null,
        plan_date: diff.plan_date,
        plan_type: diff.plan_type,
        plan_day_code: diff.plan_day_code,
        conflict_kind: diff.conflict_kind,
      },
    };
  }

  // meeting_conflict
  const diff = prop.diff as MeetingConflictDiffRaw | null;
  if (!diff) return null;

  const meetings = diff.overlapping_meetings ?? [];
  const headline = meetings.length === 1
    ? `"${meetings[0].summary}" overlaps your session`
    : `${meetings.length} meetings overlap your session`;

  return {
    view: 'banner',
    props: {
      id: prop.id,
      kind: 'meeting_conflict',
      headline,
      subhead: prop.rationale ?? null,
      plan_date: diff.plan_date,
      plan_type: diff.plan_type,
      plan_day_code: diff.plan_day_code,
      conflict_kind: null,
    },
  };
}

// =====================================================================
// Detail view summarizer (for /ai/[id])
// =====================================================================

export function summarizeConflictDetail(prop: RawProposal): ConflictViewProps | null {
  const kind = prop.kind;

  if (kind === 'conflict') {
    const diff = prop.diff as ConflictDiffRaw | null;
    if (!diff) return null;
    return {
      id: prop.id,
      kind: 'conflict',
      status: 'pending', // overridden by caller
      rationale: prop.rationale ?? null,
      headline: buildConflictHeadline(diff),
      plan_date: diff.plan_date,
      plan_type: diff.plan_type,
      plan_day_code: diff.plan_day_code,
      conflict_kind: diff.conflict_kind,
      projected: diff.projected,
      remote: diff.remote,
      overlapping_meetings: null,
      session_start: null,
      session_duration: null,
      options: diff.options.map((o) => ({
        id: o.id,
        label: o.label,
        action: o.action,
      })),
    };
  }

  if (kind === 'meeting_conflict') {
    const diff = prop.diff as MeetingConflictDiffRaw | null;
    if (!diff) return null;

    const meetings = diff.overlapping_meetings ?? [];
    const headline = meetings.length === 1
      ? `"${meetings[0].summary}" overlaps your session`
      : `${meetings.length} meetings overlap your session`;

    return {
      id: prop.id,
      kind: 'meeting_conflict',
      status: 'pending',
      rationale: prop.rationale ?? null,
      headline,
      plan_date: diff.plan_date,
      plan_type: diff.plan_type,
      plan_day_code: diff.plan_day_code,
      conflict_kind: null,
      projected: null,
      remote: null,
      overlapping_meetings: meetings,
      session_start: diff.session_start,
      session_duration: diff.session_duration,
      options: diff.options.map((o) => ({
        id: o.id,
        label: o.label,
        action: o.action,
      })),
    };
  }

  return null;
}

// =====================================================================
// Helpers
// =====================================================================

function buildConflictHeadline(diff: ConflictDiffRaw): string {
  switch (diff.conflict_kind) {
    case 'time_moved':
      return 'Your event was moved in Google Calendar';
    case 'content_edited':
      return 'Your event was renamed in Google Calendar';
    case 'deleted_remotely':
      return 'Your event was deleted from Google Calendar';
    default:
      return 'Calendar sync conflict';
  }
}
