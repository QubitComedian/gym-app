'use client';

/**
 * Soft-tier welcome-back banner (3–6 day gap).
 *
 * Renders above TodayHero when the user's top pending return_from_gap
 * proposal carries tier='soft'. One-tap accepts the recommended option
 * (shift_week); a quieter "No thanks, keep it" dismisses.
 *
 * Session-scoped dismiss: clicking "Keep it" writes `rfg-dismiss:{id}`
 * to sessionStorage so the banner hides for the rest of this tab, even
 * before the server round-trip resolves. If the user just closes the tab
 * without acting, the banner comes back tomorrow — their next page load
 * will see the proposal is still pending.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export type ReturnFromGapProposalSummary = {
  id: string;
  gap_days: number;
  default_option_id: string;
  headline: string;      // pre-extracted from rationale on the server
  subhead: string | null; // the rest of the rationale, if any
  primary_label: string; // e.g. "Shift this week →"
};

export default function ReturnFromGapBanner({
  proposal,
}: {
  proposal: ReturnFromGapProposalSummary;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return sessionStorage.getItem(`rfg-dismiss:${proposal.id}`) === '1';
  });

  if (hidden) return null;

  async function accept() {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/proposals/${proposal.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'accept_option',
          option_id: proposal.default_option_id,
        }),
      });
      if (!r.ok) throw new Error(`apply failed: ${r.status}`);
      setHidden(true);
      router.refresh();
    } catch (e) {
      console.error('[ReturnFromGapBanner] accept failed', e);
      setBusy(false);
    }
  }

  async function dismiss() {
    if (busy) return;
    // Instant UX — hide first, reconcile server state after.
    try {
      sessionStorage.setItem(`rfg-dismiss:${proposal.id}`, '1');
    } catch { /* private mode / disabled storage */ }
    setHidden(true);
    try {
      await fetch(`/api/proposals/${proposal.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'dismiss' }),
      });
      router.refresh();
    } catch (e) {
      console.error('[ReturnFromGapBanner] dismiss failed', e);
    }
  }

  return (
    <section
      className="rounded-xl bg-accent-soft border border-accent/40 px-4 py-4 mb-5 animate-fade-in"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <span className="text-lg leading-none mt-0.5" aria-hidden>
          👋
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-tiny text-accent uppercase tracking-wider mb-0.5">
            Welcome back
          </div>
          <div className="text-small font-medium">
            {proposal.headline}
          </div>
          {proposal.subhead && (
            <div className="text-small text-muted-2 mt-1">{proposal.subhead}</div>
          )}
          <div className="mt-3 flex items-center gap-2">
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
              No thanks, keep it
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
