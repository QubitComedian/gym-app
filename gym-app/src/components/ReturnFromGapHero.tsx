'use client';

/**
 * Hard-tier welcome-back hero (7+ day gap).
 *
 * Replaces TodayHero entirely. Radio-group pattern — tap an option row
 * to pre-select it; the CTA text updates to match. Accept fires one
 * POST to /api/proposals/[id] with `action='accept_option'` and the
 * selected option_id. Options with action='reassess' return a redirect
 * to /check-in rather than mutating plans.
 *
 * Session-scoped dismiss via sessionStorage `rfg-dismiss:{id}`. If the
 * user dismisses and closes the tab, tomorrow's page load will re-open
 * the hero because the proposal is still pending. A future PR will
 * count consecutive session-dismissals and down-grade to the soft
 * banner after three — for now the hero keeps its poise.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

export type ReturnFromGapHeroOption = {
  id: string;
  label: string;
  description: string;
  recommended: boolean;
  /** Dynamic CTA label, e.g. 'Start re-entry week'. */
  cta_label: string;
  /** True if this option redirects to /check-in instead of mutating plans. */
  is_reassess: boolean;
};

export type ReturnFromGapHeroProposal = {
  id: string;
  gap_days: number;
  tier: 'hard' | 'hard_extended';
  default_option_id: string;
  headline: string;
  subhead: string | null;
  options: ReturnFromGapHeroOption[];
};

export default function ReturnFromGapHero({
  proposal,
}: {
  proposal: ReturnFromGapHeroProposal;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string>(proposal.default_option_id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return sessionStorage.getItem(`rfg-dismiss:${proposal.id}`) === '1';
  });

  const selectedOption = useMemo(
    () => proposal.options.find((o) => o.id === selected) ?? proposal.options[0],
    [proposal.options, selected]
  );

  if (dismissed) return null;

  async function accept() {
    if (busy || !selectedOption) return;
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
      // Option applied. Server reconcile has been kicked; refresh the
      // server component tree to pick up the new plans.
      router.refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Something went wrong';
      console.error('[ReturnFromGapHero] accept failed', e);
      setError(msg);
      setBusy(false);
    }
  }

  function dismissForSession() {
    try {
      sessionStorage.setItem(`rfg-dismiss:${proposal.id}`, '1');
    } catch { /* noop */ }
    setDismissed(true);
  }

  return (
    <section
      className="rounded-2xl bg-panel border border-border p-6 mb-4 shadow-card animate-fade-in"
      aria-live="polite"
    >
      <div className="text-tiny text-accent uppercase tracking-wider mb-1">
        Welcome back
      </div>
      <h2 className="text-xl font-semibold leading-tight">
        {proposal.headline}
      </h2>
      {proposal.subhead && (
        <p className="text-small text-muted-2 mt-2">{proposal.subhead}</p>
      )}

      <div role="radiogroup" aria-label="Return options" className="mt-5 space-y-2">
        {proposal.options.map((opt) => {
          const isSelected = opt.id === selected;
          return (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={isSelected}
              onClick={() => setSelected(opt.id)}
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
                  <div className="flex items-center gap-2">
                    <div className="text-small font-medium">{opt.label}</div>
                    {opt.recommended && (
                      <span className="text-tiny text-accent uppercase tracking-wider">
                        Recommended
                      </span>
                    )}
                  </div>
                  <div className="text-small text-muted-2 mt-0.5">
                    {opt.description}
                  </div>
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
        className="mt-5 block w-full rounded-xl bg-accent text-black text-center font-semibold py-3.5 text-base disabled:opacity-60"
      >
        {busy ? '…' : selectedOption?.cta_label ?? 'Continue'}
      </button>

      {error && (
        <div className="mt-2 text-tiny text-rose-400" role="alert">{error}</div>
      )}

      <button
        type="button"
        onClick={dismissForSession}
        disabled={busy}
        className="mt-3 block mx-auto text-small text-muted hover:text-muted-2"
      >
        Not ready to choose? Keep today's plan →
      </button>
    </section>
  );
}
