'use client';

/**
 * Hard-tier phase-transition hero.
 *
 * Shown when the active phase's target_ends_on is today or already
 * passed. Replaces TodayHero for the session. Radio-group of options:
 *   - transition         (default, if a next phase is viable)
 *   - extend_{1,2,4}w
 *   - reassess           (redirects to /check-in)
 *   - end_phase          (only when no next phase is queued)
 *
 * Each option shows a compact summary chip-line (e.g. "+9 new · −7 replaced
 * · 2 orphans") so the user can see the scope of the change before
 * committing.
 *
 * Session-scoped dismiss via sessionStorage `pt-dismiss:{id}`. A dismissed
 * hard-tier proposal will re-open tomorrow on fresh load — same contract
 * as the RFG hero.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PhaseTransitionOptionId, PhaseTransitionTier } from '@/lib/phase/transition.pure';

export type PhaseTransitionHeroOption = {
  id: PhaseTransitionOptionId;
  label: string;
  description: string;
  recommended: boolean;
  cta_label: string;
  is_reassess: boolean;
  is_end: boolean;
  summary: {
    added: number;
    removed: number;
    orphans: number;
    skipped_logged: number;
    skipped_manual: number;
    skipped_ai_proposed: number;
    skipped_availability_window: number;
    new_target_ends_on: string | null;
  };
};

export type PhaseTransitionHeroProps = {
  id: string;
  tier: PhaseTransitionTier;
  default_option_id: PhaseTransitionOptionId;
  headline: string;
  subhead: string | null;
  phase_code: string | null;
  phase_name: string | null;
  next_phase_code: string | null;
  next_phase_name: string | null;
  target_ends_on: string;
  days_until: number;
  days_overdue: number;
  options: PhaseTransitionHeroOption[];
};

/** Format a compact chip-line for an option summary. */
function summaryChips(s: PhaseTransitionHeroOption['summary']): string | null {
  const parts: string[] = [];
  if (s.added) parts.push(`+${s.added} new`);
  if (s.removed) parts.push(`−${s.removed} replaced`);
  if (s.orphans) parts.push(`${s.orphans} orphan${s.orphans === 1 ? '' : 's'}`);
  const preservedTotal =
    s.skipped_logged +
    s.skipped_manual +
    s.skipped_ai_proposed +
    s.skipped_availability_window;
  if (preservedTotal) parts.push(`${preservedTotal} preserved`);
  if (parts.length === 0) return null;
  return parts.join(' · ');
}

export default function PhaseTransitionHero({
  proposal,
}: {
  proposal: PhaseTransitionHeroProps;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<PhaseTransitionOptionId>(
    proposal.default_option_id
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return sessionStorage.getItem(`pt-dismiss:${proposal.id}`) === '1';
  });

  const selectedOption = useMemo(
    () => proposal.options.find(o => o.id === selected) ?? proposal.options[0],
    [proposal.options, selected]
  );

  if (dismissed) return null;

  const statusCopy =
    proposal.days_overdue > 0
      ? `Ended ${proposal.days_overdue} day${proposal.days_overdue === 1 ? '' : 's'} ago`
      : proposal.days_until === 0
      ? 'Ends today'
      : proposal.days_until === 1
      ? 'Ends tomorrow'
      : `Ends in ${proposal.days_until} days`;

  async function accept() {
    if (busy || !selectedOption) return;

    // Extra confirmation for end_phase — it's destructive-ish (marks
    // phase completed with no successor) and we don't want an accidental
    // tap to close out a phase. Two-click confirm instead of a modal to
    // keep the hero momentum.
    if (selectedOption.is_end && !confirmEnd) {
      setConfirmEnd(true);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/proposals/${proposal.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'accept_option',
          option_id: selectedOption.id,
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `apply failed: ${r.status}`);
      }
      const body = await r.json().catch(() => ({}));
      if (body.redirect) {
        router.push(body.redirect);
        return;
      }
      router.refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Something went wrong';
      console.error('[PhaseTransitionHero] accept failed', e);
      setError(msg);
      setBusy(false);
      setConfirmEnd(false);
    }
  }

  function dismissForSession() {
    try {
      sessionStorage.setItem(`pt-dismiss:${proposal.id}`, '1');
    } catch {
      /* noop */
    }
    setDismissed(true);
  }

  const ctaLabel = !selectedOption
    ? 'Continue'
    : selectedOption.is_end && confirmEnd
    ? 'Tap again to end phase'
    : selectedOption.cta_label;

  return (
    <section
      className="rounded-2xl bg-panel border border-border p-6 mb-4 shadow-card animate-fade-in"
      aria-live="polite"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-tiny text-muted uppercase tracking-wider mb-1">
            {statusCopy}
            {proposal.phase_code ? ` · ${proposal.phase_code}` : ''}
          </div>
          <h2 className="text-xl font-semibold leading-tight">{proposal.headline}</h2>
          {proposal.subhead && (
            <p className="text-small text-muted-2 mt-2">{proposal.subhead}</p>
          )}
        </div>
      </div>

      <div role="radiogroup" aria-label="Phase transition options" className="mt-5 space-y-2">
        {proposal.options.map(opt => {
          const isSelected = opt.id === selected;
          const chips = summaryChips(opt.summary);
          return (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={isSelected}
              onClick={() => {
                setSelected(opt.id);
                setConfirmEnd(false); // reset on any re-selection
              }}
              className={
                'w-full text-left rounded-xl border px-4 py-3.5 transition-colors ' +
                (isSelected
                  ? 'bg-accent-soft border-accent/50'
                  : 'bg-panel-2 border-border hover:border-border-2')
              }
            >
              <div className="flex items-start gap-3">
                <span
                  aria-hidden
                  className={
                    'mt-0.5 w-4 h-4 rounded-full border-2 shrink-0 ' +
                    (isSelected ? 'border-accent bg-accent' : 'border-border')
                  }
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="text-small font-medium">{opt.label}</div>
                    {opt.recommended && (
                      <span className="text-tiny text-accent uppercase tracking-wider">
                        Recommended
                      </span>
                    )}
                    {opt.is_end && (
                      <span className="text-tiny text-rose-300 uppercase tracking-wider">
                        Ends phase
                      </span>
                    )}
                  </div>
                  <div className="text-small text-muted-2 mt-0.5">{opt.description}</div>
                  {chips && (
                    <div className="text-tiny text-muted mt-1 tabular-nums">{chips}</div>
                  )}
                  {opt.summary.new_target_ends_on && !opt.is_reassess && (
                    <div className="text-tiny text-muted mt-0.5">
                      New target: {opt.summary.new_target_ends_on}
                    </div>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={accept}
        disabled={busy || !selectedOption}
        className={
          'mt-5 block w-full rounded-xl text-center font-semibold py-3.5 text-base disabled:opacity-60 ' +
          (selectedOption?.is_end && confirmEnd
            ? 'bg-rose-500 text-white'
            : 'bg-accent text-black')
        }
      >
        {busy ? '…' : ctaLabel}
      </button>

      {error && (
        <div className="mt-2 text-tiny text-rose-400" role="alert">
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={dismissForSession}
        disabled={busy}
        className="mt-3 block mx-auto text-small text-muted hover:text-muted-2"
      >
        Decide later — keep today's plan →
      </button>
    </section>
  );
}
