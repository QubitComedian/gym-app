'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { format, parseISO } from 'date-fns';
import IconGlyph from '@/components/ui/IconGlyph';
import { TYPE_LABEL } from '@/lib/session-types';
import { exName } from '@/components/PrescriptionView';
import type { Win, ExerciseDelta } from '@/lib/wins';
import type { PhaseProgressSummary } from '@/lib/phaseProgress';

type Proposal = {
  id: string;
  status: string;
  rationale: string | null;
  diff: any;
} | null;

export default function RecapClient({
  plan,
  activity,
  wins,
  deltas,
  streak,
  phaseSummary,
  phaseLabel,
  nextPlan,
  initialProposal,
  priorSessionCount,
}: {
  plan: any;
  activity: any;
  wins: Win[];
  deltas: ExerciseDelta[];
  streak: number;
  phaseSummary: PhaseProgressSummary | null;
  phaseLabel: string | null;
  nextPlan: any | null;
  initialProposal: Proposal;
  priorSessionCount: number;
}) {
  const [proposal, setProposal] = useState<Proposal>(initialProposal);
  const [polling, setPolling] = useState<boolean>(!initialProposal);
  const [detailOpen, setDetailOpen] = useState(false);

  // Poll for the AI proposal if it's not ready yet (up to ~20s)
  useEffect(() => {
    if (proposal) return;
    let cancelled = false;
    const start = Date.now();
    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/proposals/for-activity?activity_id=${activity.id}`, { cache: 'no-store' });
        if (res.ok) {
          const j = await res.json();
          if (j.proposal) { setProposal(j.proposal); setPolling(false); return; }
        }
      } catch {}
      if (Date.now() - start > 20000) { setPolling(false); return; }
      setTimeout(tick, 2000);
    };
    const t = setTimeout(tick, 1500);
    return () => { cancelled = true; clearTimeout(t); };
  }, [proposal, activity.id]);

  const sessionLabel = [TYPE_LABEL[activity.type] ?? activity.type, activity.data?.day_code].filter(Boolean).join(' · ');
  const elapsed = activity.data?.duration_actual_min as number | undefined;
  const isFirstEver = priorSessionCount === 0;

  return (
    <main className="max-w-xl mx-auto px-4 pt-4 pb-32">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <Link href="/today" className="text-tiny text-muted">‹ Today</Link>
        <Link href={`/log/${plan.id}`} className="text-tiny text-muted-2 hover:text-muted">Edit log</Link>
      </div>

      {/* Hero — wins */}
      <section className="mb-5">
        <div className="flex items-center gap-3 mb-2">
          <IconGlyph type={activity.type} size={26} />
          <div className="flex-1 min-w-0">
            <div className="text-tiny text-muted uppercase tracking-wider">Session complete</div>
            <h1 className="text-2xl font-bold tracking-tight truncate">{sessionLabel}</h1>
            <div className="text-small text-muted-2 mt-0.5">
              {format(parseISO(activity.date + 'T00:00:00'), 'EEEE, MMM d')}
              {elapsed ? ` · ${elapsed} min` : ''}
              {streak >= 2 ? <> · <span className="text-accent">🔥 {streak}-day streak</span></> : null}
            </div>
          </div>
        </div>

        {/* Wins */}
        {isFirstEver ? (
          <div className="rounded-xl bg-accent-soft border border-accent/30 p-4 mt-3">
            <div className="text-small font-semibold text-accent mb-1">Nice — first session in the books.</div>
            <p className="text-tiny text-muted-2 leading-relaxed">
              Claude will start spotting trends and calling out PRs after a few more sessions. For now, just keep logging.
            </p>
          </div>
        ) : wins.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 mt-3">
            {wins.map((w, i) => <WinPill key={i} win={w} />)}
          </div>
        ) : (
          <div className="rounded-lg bg-panel-2 border border-border px-3 py-2 mt-3">
            <div className="text-tiny text-muted-2">Logged clean. No PRs this round — consistency compounds.</div>
          </div>
        )}
      </section>

      {/* AI review slot */}
      <AIReviewCard proposal={proposal} polling={polling} />

      {/* Session detail (collapsed) */}
      <section className="rounded-xl bg-panel border border-border mb-4 overflow-hidden">
        <button
          onClick={() => setDetailOpen(v => !v)}
          className="w-full flex items-center justify-between px-4 py-3 text-left"
        >
          <div className="text-tiny text-muted uppercase tracking-wider">Session detail</div>
          <span className={`text-muted transition-transform ${detailOpen ? 'rotate-90' : ''}`}>›</span>
        </button>
        {detailOpen && (
          <div className="border-t border-border p-4 animate-fade-in">
            {activity.type === 'gym' ? (
              <GymDetail deltas={deltas} sets={activity.data?.sets ?? {}} />
            ) : (
              <NonGymDetail data={activity.data ?? {}} />
            )}
            {activity.notes && (
              <div className="mt-3 pt-3 border-t border-border text-small italic text-muted-2">
                {activity.notes}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Phase progress */}
      {phaseSummary && <PhaseCard summary={phaseSummary} label={phaseLabel ?? ''} />}

      {/* Next up */}
      {nextPlan && <NextUpCard plan={nextPlan} adjustedByAI={proposal?.status === 'pending'} />}

      {/* Done bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-bg/90 backdrop-blur border-t border-border p-3">
        <div className="max-w-xl mx-auto">
          <Link
            href="/today"
            className="block w-full bg-accent text-black font-semibold rounded-lg py-3 text-center"
          >
            Done
          </Link>
        </div>
      </div>
    </main>
  );
}

/* ───────────────────── Win pill ───────────────────── */

function WinPill({ win }: { win: Win }) {
  const tone = toneFor(win.kind);
  const icon = iconFor(win.kind);
  return (
    <div className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 ${tone.cls}`}>
      <span aria-hidden className="text-sm leading-none">{icon}</span>
      <span className="text-tiny font-medium">
        {win.label}
        {win.detail && <span className="text-muted ml-1">{win.detail}</span>}
      </span>
    </div>
  );
}

function toneFor(kind: Win['kind']) {
  if (kind === 'pr' || kind === 'hardest_send' || kind === 'distance_pr' || kind === 'pace_pr') {
    return { cls: 'bg-accent-soft border-accent/40 text-accent' };
  }
  if (kind === 'streak' || kind === 'first_time' || kind === 'first_session') {
    return { cls: 'bg-panel border-border text-white' };
  }
  return { cls: 'bg-panel-2 border-border text-muted-2' };
}

function iconFor(kind: Win['kind']): string {
  switch (kind) {
    case 'pr': return '🏆';
    case 'hardest_send': return '🧗';
    case 'distance_pr': return '📏';
    case 'pace_pr': return '⚡';
    case 'streak': return '🔥';
    case 'first_time': return '✨';
    case 'first_session': return '🌱';
    case 'volume_up': return '📈';
    case 'intensity': return '💥';
    case 'modality_milestone': return '🎯';
    default: return '•';
  }
}

/* ───────────────────── AI review card ───────────────────── */

function AIReviewCard({ proposal, polling }: { proposal: Proposal; polling: boolean }) {
  if (!proposal && !polling) return null; // never ran or gave up

  if (!proposal && polling) {
    return (
      <section className="rounded-xl bg-panel border border-border p-4 mb-4">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
          <div className="text-tiny text-muted uppercase tracking-wider">Claude is reviewing…</div>
        </div>
        <div className="h-4 bg-panel-2 rounded w-3/4 mt-2 animate-pulse" />
        <div className="h-3 bg-panel-2 rounded w-1/2 mt-2 animate-pulse" />
      </section>
    );
  }

  if (!proposal) return null;

  // Parse the rationale: first "Headline:" line is the headline.
  const headline =
    proposal.rationale?.split('\n').find(l => l.startsWith('Headline:'))?.replace(/^Headline:\s*/, '') ??
    proposal.rationale?.split('\n')[0]?.slice(0, 140) ??
    'Review ready';
  const counts = {
    u: proposal.diff?.updates?.length ?? 0,
    c: proposal.diff?.creates?.length ?? 0,
    d: proposal.diff?.deletes?.length ?? 0,
  };
  const total = counts.u + counts.c + counts.d;

  if (proposal.status === 'applied' || total === 0) {
    // No changes proposed — celebrate the clean review quietly
    return (
      <section className="rounded-xl bg-panel border border-border p-4 mb-4">
        <div className="text-tiny text-muted uppercase tracking-wider mb-1">Claude's review</div>
        <div className="text-small">{headline}</div>
        <div className="text-tiny text-muted-2 mt-1">No changes proposed — on track.</div>
      </section>
    );
  }

  return (
    <section className="rounded-xl bg-panel border border-accent/40 p-4 mb-4">
      <div className="text-tiny text-accent uppercase tracking-wider mb-1">Claude's review</div>
      <div className="text-small font-medium mb-1">{headline}</div>
      <div className="text-tiny text-muted mb-3">
        {counts.u ? `${counts.u} update${counts.u === 1 ? '' : 's'}` : ''}
        {counts.u && (counts.c || counts.d) ? ' · ' : ''}
        {counts.c ? `${counts.c} new` : ''}
        {counts.c && counts.d ? ' · ' : ''}
        {counts.d ? `${counts.d} removed` : ''}
      </div>
      <Link
        href={`/ai/${proposal.id}`}
        className="inline-block bg-accent text-black font-semibold rounded-lg px-4 py-2 text-small"
      >
        Review changes →
      </Link>
    </section>
  );
}

/* ───────────────────── Gym detail ───────────────────── */

function GymDetail({ deltas, sets }: { deltas: ExerciseDelta[]; sets: Record<string, any[]> }) {
  if (deltas.length === 0) {
    return <div className="text-tiny text-muted italic">No sets logged.</div>;
  }
  return (
    <ul className="space-y-3">
      {deltas.map(d => {
        const rows = sets[d.exercise_id] ?? [];
        return (
          <li key={d.exercise_id} className="rounded-lg bg-panel-2 border border-border p-3">
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-small font-medium">{exName(d.exercise_id)}</div>
              {d.delta_kg != null && d.delta_kg !== 0 && (
                <div className={`text-tiny tabular-nums ${d.delta_kg > 0 ? 'text-ok' : 'text-muted-2'}`}>
                  {d.delta_kg > 0 ? '+' : ''}{d.delta_kg} kg
                </div>
              )}
              {d.delta_kg === 0 && (
                <div className="text-tiny text-muted tabular-nums">=</div>
              )}
            </div>
            <div className="text-tiny text-muted-2 tabular-nums">
              {rows
                .filter(r => r.w || r.r)
                .map((r, i) => (
                  <span key={i}>
                    {i > 0 ? ', ' : ''}
                    {r.w ?? '—'}×{r.r ?? '—'}{r.rir != null ? ` (RIR ${r.rir})` : ''}
                  </span>
                ))}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/* ───────────────────── Non-gym detail ───────────────────── */

function NonGymDetail({ data }: { data: any }) {
  const entries = Object.entries(data).filter(([k, v]) => {
    if (v == null || v === '' || k === 'day_code') return false;
    if (Array.isArray(v)) return v.length > 0;
    return true;
  });
  if (entries.length === 0) return <div className="text-tiny text-muted italic">No detail captured.</div>;
  return (
    <dl className="grid grid-cols-2 gap-y-1.5 text-small">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted capitalize">{k.replace(/_/g, ' ')}</dt>
          <dd className="tabular-nums">{formatValue(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function formatValue(v: any): string {
  if (Array.isArray(v)) {
    if (v.length > 0 && typeof v[0] === 'object' && v[0] !== null) {
      if ('done' in v[0] && 'planned' in v[0]) {
        const done = v.filter((x: any) => x.done).length;
        return `${done} / ${v.length} complete`;
      }
      if ('grade' in v[0]) {
        return v.map((x: any) => `${x.grade} (${(x.sent ?? 0) + (x.flashed ?? 0)})`).join(', ');
      }
    }
    return v.join(', ');
  }
  return String(v);
}

/* ───────────────────── Phase card ───────────────────── */

function PhaseCard({ summary, label }: { summary: PhaseProgressSummary; label: string }) {
  const bar = summary.weekTotal
    ? Math.min(1, summary.weekIndex / summary.weekTotal)
    : null;
  const weekPct = summary.weekBar.planned
    ? Math.min(1, summary.weekBar.done / summary.weekBar.planned)
    : 0;
  return (
    <section className="rounded-xl bg-panel border border-border p-4 mb-4">
      <div className="text-tiny text-muted uppercase tracking-wider mb-1">Phase progress</div>
      <div className="text-small font-medium mb-2">{label}</div>
      {bar != null && (
        <div className="h-1.5 rounded-full bg-panel-2 overflow-hidden mb-3">
          <div className="h-full bg-accent/50" style={{ width: `${bar * 100}%` }} />
        </div>
      )}
      {summary.weekBar.planned > 0 && (
        <div className="flex items-center gap-2 mb-2">
          <div className="flex-1 h-1 rounded-full bg-panel-2 overflow-hidden">
            <div className="h-full bg-ok/70" style={{ width: `${weekPct * 100}%` }} />
          </div>
          <div className="text-tiny text-muted tabular-nums shrink-0">
            {summary.weekBar.done}/{summary.weekBar.planned} this week
          </div>
        </div>
      )}
      {summary.targets.length > 0 && (
        <ul className="mt-3 space-y-1">
          {summary.targets.map((t, i) => (
            <li key={i} className="text-tiny text-muted-2 leading-snug">· {t}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ───────────────────── Next-up card ───────────────────── */

function NextUpCard({ plan, adjustedByAI }: { plan: any; adjustedByAI?: boolean }) {
  const d = parseISO(plan.date + 'T00:00:00');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dayLabel = d.getTime() === today.getTime() ? 'Today'
    : d.getTime() === today.getTime() + 86400000 ? 'Tomorrow'
    : format(d, 'EEE, MMM d');
  const typeLabel = TYPE_LABEL[plan.type] ?? plan.type;

  return (
    <Link
      href={d.getTime() === today.getTime() ? '/today' : `/calendar/${plan.date}`}
      className="block rounded-xl bg-panel border border-border p-4 mb-4 hover:border-accent/40 transition-colors"
    >
      <div className="flex items-center gap-3">
        <IconGlyph type={plan.type} size={22} />
        <div className="flex-1 min-w-0">
          <div className="text-tiny text-muted uppercase tracking-wider">Up next</div>
          <div className="text-small font-medium truncate">
            {dayLabel} · {typeLabel}{plan.day_code ? ` · ${plan.day_code}` : ''}
          </div>
          {adjustedByAI && (
            <div className="text-tiny text-accent mt-0.5">Claude has suggestions for this session</div>
          )}
        </div>
        <span className="text-muted">›</span>
      </div>
    </Link>
  );
}
