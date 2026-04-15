'use client';
import { useState } from 'react';
import Link from 'next/link';
import IconGlyph from './ui/IconGlyph';
import PrescriptionView, { summarizePrescription } from './PrescriptionView';
import { TYPE_LABEL, typeColor } from '@/lib/session-types';

type Plan = {
  id: string;
  date: string;
  type: string;
  day_code: string | null;
  status: string;
  prescription: any;
} | null;

export default function TodayHero({ plan, alreadyDone, today }: { plan: Plan; alreadyDone: boolean; today: string }) {
  const [expanded, setExpanded] = useState(false);

  if (!plan || plan.type === 'rest') {
    return (
      <>
        <section className="rounded-2xl bg-panel border border-border p-6 mb-4">
          <div className="flex items-center gap-3 mb-3">
            <IconGlyph type="rest" size={24} color="#b0b0b0" />
            <h2 className="text-xl font-semibold">Rest day</h2>
          </div>
          <p className="text-small text-muted-2">Recover. Walk. Hydrate. Sleep.</p>
        </section>
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
          </div>
          <p className="text-small text-muted-2 mb-4">You logged {TYPE_LABEL[plan.type]}{plan.day_code ? ` · ${plan.day_code}` : ''}.</p>
          <Link href={`/calendar/${today}`} className="inline-block rounded-lg bg-panel-2 border border-border px-4 py-2.5 text-small">
            View session detail
          </Link>
        </section>
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
        <button
          onClick={() => setExpanded(e => !e)}
          aria-expanded={expanded}
          className="w-full text-left p-6 flex items-start gap-4 active:bg-panel-2/40 transition-colors"
        >
          <div className="shrink-0 mt-0.5 w-11 h-11 rounded-xl bg-panel-2 border border-border flex items-center justify-center" style={{ boxShadow: `inset 0 0 0 1px ${c}22` }}>
            <IconGlyph type={plan.type} size={24} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-tiny text-muted uppercase tracking-wider mb-0.5">On deck</div>
            <h2 className="text-xl font-semibold leading-tight">{sessionName}</h2>
            {summary && <div className="text-small text-muted-2 mt-1">{summary}</div>}
          </div>
          <span className={`text-muted transition-transform ${expanded ? 'rotate-90' : ''}`}>›</span>
        </button>

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

      <AlternativeDrawer today={today} />
    </>
  );
}

function AlternativeDrawer({ today, secondary = false }: { today: string; secondary?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-xl bg-panel border border-border">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
      >
        <span className="text-small text-muted-2">
          {secondary ? 'Add another session' : "Didn't do this today?"}
        </span>
        <span className={`text-muted transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
      </button>
      {open && (
        <div className="px-4 pb-4 pt-1 animate-fade-in grid grid-cols-2 gap-2">
          <Link href={`/log?date=${today}`} className="rounded-lg bg-panel-2 border border-border px-3 py-3 text-small text-center">
            Log something else
          </Link>
          <Link href={`/calendar`} className="rounded-lg bg-panel-2 border border-border px-3 py-3 text-small text-center">
            Open calendar
          </Link>
        </div>
      )}
    </section>
  );
}
