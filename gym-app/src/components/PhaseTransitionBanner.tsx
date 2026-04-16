'use client';

/**
 * Soft-tier phase-transition banner.
 *
 * Shown when the active phase is ending within [today+1, today+7] and a
 * `phase_transition` proposal is pending. One-tap accepts the default
 * option (usually `transition` if a next phase is queued, otherwise
 * `extend_2w`); a quieter "Decide later" dismisses the proposal for this
 * tab. Clicking "See options →" routes to the hard-tier hero-style page
 * (rendered via the proposal's kind handling on /ai/[id] in a future PR;
 * for now we still surface the detail view by scrolling the hero into
 * place — the hero-vs-banner split is deliberately a rendering choice,
 * not a data split).
 *
 * Session-scoped dismiss: `pt-dismiss:{id}` in sessionStorage hides the
 * banner for the rest of this tab. Reopening the tab tomorrow re-shows
 * it because the proposal is still pending (same contract as RFG).
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PhaseTransitionOptionId, PhaseTransitionTier } from '@/lib/phase/transition.pure';

export type PhaseTransitionBannerProps = {
  id: string;
  tier: PhaseTransitionTier;
  default_option_id: PhaseTransitionOptionId;
  headline: string;
  subhead: string | null;
  /** CTA copy lifted from the default option. */
  primary_label: string;
  phase_code: string | null;
  phase_name: string | null;
  next_phase_code: string | null;
  target_ends_on: string;
  /** Days until `target_ends_on` (0 or positive for soft-tier). */
  days_until: number;
};

export default function PhaseTransitionBanner({
  proposal,
}: {
  proposal: PhaseTransitionBannerProps;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return sessionStorage.getItem(`pt-dismiss:${proposal.id}`) === '1';
  });

  if (hidden) return null;

  async function accept() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/proposals/${proposal.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'accept_option',
          option_id: proposal.default_option_id,
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
      setHidden(true);
      router.refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Something went wrong';
      console.error('[PhaseTransitionBanner] accept failed', e);
      setError(msg);
      setBusy(false);
    }
  }

  async function dismiss() {
    if (busy) return;
    try {
      sessionStorage.setItem(`pt-dismiss:${proposal.id}`, '1');
    } catch {
      /* private mode / disabled storage */
    }
    setHidden(true);
    try {
      await fetch(`/api/proposals/${proposal.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'dismiss' }),
      });
      router.refresh();
    } catch (e) {
      console.error('[PhaseTransitionBanner] dismiss failed', e);
    }
  }

  const daysCopy =
    proposal.days_until === 0
      ? 'today'
      : proposal.days_until === 1
      ? 'tomorrow'
      : `in ${proposal.days_until} days`;

  return (
    <section
      className="rounded-xl bg-panel-2 border border-border px-4 py-4 mb-5 animate-fade-in"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <span className="text-lg leading-none mt-0.5" aria-hidden>
          🎯
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-tiny text-muted uppercase tracking-wider mb-0.5">
            Phase ending {daysCopy}
          </div>
          <div className="text-small font-medium">{proposal.headline}</div>
          {proposal.subhead && (
            <div className="text-small text-muted-2 mt-1">{proposal.subhead}</div>
          )}
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={accept}
              disabled={busy}
              className="inline-flex items-center justify-center rounded-lg bg-accent text-black font-semibold text-small px-3.5 py-2 disabled:opacity-60"
            >
              {busy ? '…' : proposal.primary_label}
            </button>
            <button
              type="button"
              onClick={dismiss}
              disabled={busy}
              className="text-small text-muted hover:text-muted-2 px-2 py-2"
            >
              Decide later
            </button>
          </div>
          {error && (
            <div className="mt-2 text-tiny text-rose-400" role="alert">
              {error}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
