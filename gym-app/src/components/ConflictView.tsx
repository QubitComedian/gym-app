'use client';

/**
 * Detail view for conflict + meeting_conflict proposals (P1.5 / PR-Z).
 *
 * Rendered inside /ai/[id] when the proposal kind is 'conflict' or
 * 'meeting_conflict'. Shows what changed, the options available, and
 * lets the user pick one.
 *
 * For 'conflict' (etag): side-by-side comparison of app projection vs
 * Google's current state. Options: keep app, accept Google, cancel, etc.
 *
 * For 'meeting_conflict': shows the overlapping meetings and the
 * session timing. Options: shift morning, shift evening, move day,
 * skip, dismiss.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import IconGlyph from './ui/IconGlyph';
import { TYPE_LABEL } from '@/lib/session-types';
import { useToast } from '@/components/ui/Toast';

// =====================================================================
// Types
// =====================================================================

export type ConflictViewOption = {
  id: string;
  label: string;
  action: string;
};

export type ConflictViewProps = {
  id: string;
  kind: 'conflict' | 'meeting_conflict';
  status: string;
  rationale: string | null;
  headline: string;
  plan_date: string;
  plan_type: string;
  plan_day_code: string | null;
  conflict_kind: string | null;
  projected: {
    summary: string;
    start: { dateTime: string; timeZone: string };
    end: { dateTime: string; timeZone: string };
  } | null;
  remote: {
    summary: string;
    start: { dateTime?: string; date?: string; timeZone?: string };
    end: { dateTime?: string; date?: string; timeZone?: string };
  } | null;
  overlapping_meetings: Array<{
    summary: string;
    start: string;
    end: string;
  }> | null;
  session_start: string | null;
  session_duration: number | null;
  options: ConflictViewOption[];
};

// =====================================================================
// Component
// =====================================================================

export default function ConflictView({ proposal }: { proposal: ConflictViewProps }) {
  const router = useRouter();
  const { push } = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const isPending = proposal.status === 'pending';

  async function pickOption(optionId: string) {
    if (busy) return;
    setBusy(optionId);
    try {
      const res = await fetch(`/api/proposals/${proposal.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'accept_option', option_id: optionId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Failed: ${res.status}`);
      }
      push({
        kind: 'success',
        title: 'Resolved',
        description: 'Conflict has been handled.',
      });
      router.push('/today');
      router.refresh();
    } catch (e: any) {
      push({ kind: 'info', title: 'Failed', description: e.message });
      setBusy(null);
    }
  }

  async function dismiss() {
    if (busy) return;
    setBusy('_dismiss');
    try {
      const res = await fetch(`/api/proposals/${proposal.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'dismiss' }),
      });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      push({ kind: 'info', title: 'Dismissed', description: 'Conflict left unresolved.' });
      router.push('/today');
      router.refresh();
    } catch (e: any) {
      push({ kind: 'info', title: 'Failed', description: e.message });
      setBusy(null);
    }
  }

  return (
    <section>
      <header className="mt-2 mb-4">
        <div className="flex items-center gap-2 text-tiny text-warn uppercase tracking-wider mb-1">
          <span aria-hidden>{proposal.kind === 'meeting_conflict' ? '📅' : '🔄'}</span>
          <span>{proposal.kind === 'meeting_conflict' ? 'Meeting conflict' : 'Calendar conflict'}</span>
        </div>
        <h1 className="text-2xl font-bold tracking-tight leading-snug">
          {proposal.headline}
        </h1>
        {proposal.rationale && (
          <p className="text-small text-muted-2 mt-2 whitespace-pre-line">
            {proposal.rationale}
          </p>
        )}
      </header>

      {/* Session info chip */}
      <div className="flex items-center gap-2 mb-4 text-small text-muted">
        <IconGlyph type={proposal.plan_type} size={16} />
        <span>
          {TYPE_LABEL[proposal.plan_type] ?? proposal.plan_type}
          {proposal.plan_day_code ? ` · ${proposal.plan_day_code}` : ''}
        </span>
        <span>· {formatDate(proposal.plan_date)}</span>
      </div>

      {/* Conflict detail card */}
      {proposal.kind === 'conflict' && proposal.projected && (
        <ConflictCompare
          projected={proposal.projected}
          remote={proposal.remote}
          conflictKind={proposal.conflict_kind}
        />
      )}

      {proposal.kind === 'meeting_conflict' && proposal.overlapping_meetings && (
        <MeetingOverlapCard
          meetings={proposal.overlapping_meetings}
          sessionStart={proposal.session_start}
          sessionDuration={proposal.session_duration}
        />
      )}

      {/* Options */}
      {isPending && (
        <div className="mt-5 space-y-2">
          <div className="text-tiny text-muted uppercase tracking-wider mb-2">
            Choose how to resolve
          </div>
          {proposal.options.map((opt) => (
            <button
              key={opt.id}
              onClick={() => pickOption(opt.id)}
              disabled={!!busy}
              className={`w-full text-left rounded-xl border px-4 py-3.5 transition-colors ${
                busy === opt.id
                  ? 'bg-accent/10 border-accent/50'
                  : 'bg-panel border-border hover:border-accent/40'
              } disabled:opacity-60`}
            >
              <div className="text-small font-medium">{opt.label}</div>
              <div className="text-tiny text-muted-2 mt-0.5">
                {optionDescription(proposal.kind, opt.id)}
              </div>
            </button>
          ))}
        </div>
      )}

      {!isPending && (
        <div className="mt-5 text-center text-tiny text-muted uppercase tracking-wider">
          {proposal.status}
        </div>
      )}
    </section>
  );
}

// =====================================================================
// Sub-components
// =====================================================================

function ConflictCompare({
  projected,
  remote,
  conflictKind,
}: {
  projected: NonNullable<ConflictViewProps['projected']>;
  remote: ConflictViewProps['remote'];
  conflictKind: string | null;
}) {
  if (conflictKind === 'deleted_remotely') {
    return (
      <div className="rounded-xl bg-panel border border-border overflow-hidden mb-2">
        <div className="px-4 py-3 border-b border-border bg-panel-2">
          <span className="text-micro uppercase tracking-wider text-danger">Event deleted</span>
        </div>
        <div className="p-4">
          <div className="text-small">
            The Google Calendar event for this session no longer exists.
          </div>
          <div className="text-tiny text-muted-2 mt-2">
            App expects: {projected.summary} at {formatTime(projected.start.dateTime)}–{formatTime(projected.end.dateTime)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-panel border border-border overflow-hidden mb-2">
      <div className="px-4 py-3 border-b border-border bg-panel-2">
        <span className="text-micro uppercase tracking-wider text-warn">
          {conflictKind === 'time_moved' ? 'Time changed' : 'Event edited'}
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2">
        <div className="p-4 border-b sm:border-b-0 sm:border-r border-border">
          <div className="text-micro uppercase tracking-wider text-muted mb-2">App schedule</div>
          <div className="text-small font-medium">{projected.summary}</div>
          <div className="text-tiny text-muted-2 mt-1">
            {formatTime(projected.start.dateTime)}–{formatTime(projected.end.dateTime)}
          </div>
        </div>
        <div className="p-4">
          <div className="text-micro uppercase tracking-wider text-accent mb-2">Google Calendar</div>
          {remote ? (
            <>
              <div className="text-small font-medium">{remote.summary}</div>
              <div className="text-tiny text-muted-2 mt-1">
                {formatTime(remote.start.dateTime ?? remote.start.date ?? '?')}–
                {formatTime(remote.end.dateTime ?? remote.end.date ?? '?')}
              </div>
            </>
          ) : (
            <div className="text-small text-muted-2">No remote data</div>
          )}
        </div>
      </div>
    </div>
  );
}

function MeetingOverlapCard({
  meetings,
  sessionStart,
  sessionDuration,
}: {
  meetings: Array<{ summary: string; start: string; end: string }>;
  sessionStart: string | null;
  sessionDuration: number | null;
}) {
  return (
    <div className="rounded-xl bg-panel border border-border overflow-hidden mb-2">
      <div className="px-4 py-3 border-b border-border bg-panel-2 flex items-center justify-between">
        <span className="text-micro uppercase tracking-wider text-warn">Overlapping meetings</span>
        {sessionStart && sessionDuration && (
          <span className="text-tiny text-muted">
            Session: {sessionStart.slice(0, 5)} ({sessionDuration}min)
          </span>
        )}
      </div>
      <div className="p-4 space-y-2">
        {meetings.map((m, i) => (
          <div key={i} className="flex items-center gap-3 text-small">
            <span className="text-warn shrink-0" aria-hidden>•</span>
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{m.summary}</div>
              <div className="text-tiny text-muted-2">
                {formatTime(m.start)}–{formatTime(m.end)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// =====================================================================
// Helpers
// =====================================================================

function optionDescription(kind: string, optionId: string): string {
  // Etag conflict options
  if (kind === 'conflict') {
    switch (optionId) {
      case 'keep_app':
        return 'Push the app\u2019s schedule back to Google Calendar';
      case 'accept_google':
        return 'Accept Google Calendar\u2019s version into your plan';
      case 'recreate':
        return 'Create a new Google Calendar event for this session';
      case 'cancel':
        return 'Cancel this session and remove from your plan';
      case 'dismiss':
        return 'Stop notifying about this mismatch';
      default:
        return '';
    }
  }
  // Meeting conflict options
  switch (optionId) {
    case 'shift_morning':
      return 'Move your session to before your first meeting';
    case 'shift_evening':
      return 'Move your session to after your last meeting';
    case 'move_day':
      return 'Reschedule to the nearest available day';
    case 'skip':
      return 'Skip this session entirely';
    case 'dismiss':
      return 'Keep the session as planned despite the overlap';
    default:
      return '';
  }
}

function formatTime(isoDateTime: string): string {
  if (!isoDateTime) return '?';
  // Handle both full ISO and HH:MM:SS formats.
  const timeIdx = isoDateTime.indexOf('T');
  const timePart = timeIdx >= 0 ? isoDateTime.slice(timeIdx + 1) : isoDateTime;
  return timePart.slice(0, 5);
}

function formatDate(iso: string): string {
  const [, m, d] = iso.split('-');
  if (!m || !d) return iso;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(m) - 1]} ${Number(d)}`;
}
