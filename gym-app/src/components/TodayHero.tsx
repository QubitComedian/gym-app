'use client';
import { useState } from 'react';
import Link from 'next/link';
import IconGlyph from './ui/IconGlyph';
import PrescriptionView, { summarizePrescription } from './PrescriptionView';
import { TYPE_LABEL, typeColor } from '@/lib/session-types';
import WhySheet from './WhySheet';
import type { WhyExplainer } from '@/lib/whyThisSession';

type Plan = {
  id: string;
  date: string;
  type: string;
  day_code: string | null;
  status: string;
  prescription: any;
} | null;

export default function TodayHero({
  plan,
  alreadyDone,
  today,
  why,
}: {
  plan: Plan;
  alreadyDone: boolean;
  today: string;
  why?: WhyExplainer | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);

  if (!plan || plan.type === 'rest') {
    return (
      <>
        <section className="rounded-2xl bg-panel border border-border p-6 mb-4">
          <div className="flex items-center gap-3 mb-3">
            <IconGlyph type="rest" size={24} color="#b0b0b0" />
            <h2 className="text-xl font-semibold">Rest day</h2>
            {why && plan && (
              <WhyButton onClick={() => setWhyOpen(true)} />
            )}
          </div>
          <p className="text-small text-muted-2">Recover. Walk. Hydrate. Sleep.</p>
        </section>
        {why && plan && (
          <WhySheet open={whyOpen} onClose={() => setWhyOpen(false)} why={why} planId={plan.id} date={plan.date} />
        )}
        <AlternativeDrawer today={today} />
      </>
    );
  }

  if (alreadyDone) {
    return (
      <>
        <section className="rounded-2xl bg-panel border border-border p-6 mb-4">
          <div className="flex items-center gap-3 mb-2">
            <IconGlyph type={plan.type} size={24} />
            <h2 className="text-xl font-semibold">Done today</h2>
            {why && <WhyButton onClick={() => setWhyOpen(true)} />}
          </div>
          <p className="text-small text-muted-2 mb-4">You logged {TYPE_LABEL[plan.type]}{plan.day_code ? ` · ${plan.day_code}` : ''}.</p>
          <Link href={`/calendar/${today}`} className="inline-block rounded-lg bg-panel-2 border border-border px-4 py-2.5 text-small">
            View session detail
          </Link>
        </section>
        {why && (
          <WhySheet open={whyOpen} onClose={() => setWhyOpen(false)} why={why} planId={plan.id} date={plan.date} />
        )}
        <AlternativeDrawer today={today} secondary />
      </>
    );
  }

  const summary = summarizePrescription(plan.prescription);
  const sessionName = `${TYPE_LABEL[plan.type] ?? plan.type}${plan.day_code ? ` · ${plan.day_code}` : ''}`;
  const c = typeColor(plan.type);

  return (
    <>
      <section className="rounded-2xl bg-panel border border-border overflow-hidden mb-4 shadow-card">
        <div className="relative">
          <button
            onClick={() => setExpanded(e => !e)}
            aria-expanded={expanded}
            className="w-full text-left p-6 flex items-start gap-4 active:bg-panel-2/40 transition-colors"
          >
            <div className="shrink-0 mt-0.5 w-11 h-11 rounded-xl bg-panel-2 border border-border flex items-center justify-center" style={{ boxShadow: `inset 0 0 0 1px ${c}22` }}>
              <IconGlyph type={plan.type} size={24} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-tiny text-muted uppercase tracking-wider mb-0.5 flex items-center gap-2">
                <span>On deck</span>
              </div>
              <h2 className="text-xl font-semibold leading-tight flex items-center gap-2">
                <span className="truncate">{sessionName}</span>
              </h2>
              {summary && <div className="text-small text-muted-2 mt-1">{summary}</div>}
            </div>
            <span className={`text-muted transition-transform ${expanded ? 'rotate-90' : ''}`}>›</span>
          </button>
          {why && (
            <div className="absolute top-5 right-12">
              <WhyButton onClick={() => setWhyOpen(true)} />
            </div>
          )}
        </div>

        {expanded && (
          <div className="px-6 pb-4 animate-fade-in border-t border-border pt-4">
            <PrescriptionView prescription={plan.prescription} dense />
          </div>
        )}

        <div className="px-4 pb-4 pt-2 border-t border-border">
          <Link
            href={`/log/${plan.id}`}
            className="block w-full rounded-xl bg-accent text-black text-center font-semibold py-3.5 text-base"
          >
            Begin session
          </Link>
        </div>
      </section>

      {why && (
        <WhySheet open={whyOpen} onClose={() => setWhyOpen(false)} why={why} planId={plan.id} date={plan.date} />
      )}

      <AlternativeDrawer today={today} />
    </>
  );
}

function WhyButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); onClick(); }}
      aria-label="Why this session?"
      className="w-6 h-6 rounded-full bg-panel-2 border border-border text-muted hover:text-accent hover:border-accent/40 text-tiny flex items-center justify-center leading-none transition-colors"
    >
      ?
    </button>
  );
}

/**
 * Alternative actions drawer shown beneath the "on deck" card.
 *
 * When the user *hasn't* done today's session (`!secondary`) we offer two
 * actions: (a) log something different they did instead, or (b) ask the
 * coach to rebalance the plan — the latter dispatches a `coach:open` event
 * that `CoachChat` listens for, pre-filling the textarea.
 *
 * When the user *has* already done a session (`secondary`), the drawer is
 * labelled "Add another session" and only needs a single logging CTA —
 * rescheduling doesn't apply, and the calendar is a tab away anyway.
 */
function AlternativeDrawer({ today, secondary = false }: { today: string; secondary?: boolean }) {
  const [open, setOpen] = useState(false);

  function openCoachToReschedule() {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('coach:open', {
      detail: { prefill: "I can't do today's session — please rebalance instead of just deleting it." },
    }));
  }

  return (
    <section className="rounded-xl bg-panel border border-border">
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
      >
        <span className="text-small text-muted-2">
          {secondary ? 'Add another session' : "Didn't do this today?"}
        </span>
        <span className={`text-muted transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden>›</span>
      </button>
      {open && (
        <div className={`px-4 pb-4 pt-1 animate-fade-in ${secondary ? '' : 'grid grid-cols-2 gap-2'}`}>
          <Link
            href={`/log?date=${today}`}
            className="rounded-lg bg-panel-2 border border-border px-3 py-3 text-small text-center block"
          >
            Log something else
          </Link>
          {!secondary && (
            <button
              type="button"
              onClick={openCoachToReschedule}
              className="rounded-lg bg-panel-2 border border-border px-3 py-3 text-small text-center"
            >
              Reschedule with coach
            </button>
          )}
        </div>
      )}
    </section>
  );
}
