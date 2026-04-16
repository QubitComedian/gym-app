/**
 * Weekly-template editor (client component) — P1.1 / PR-G.
 *
 * Three states, managed locally:
 *   1. EDIT   — segmented DOW list, each row toggling type (rest/gym/run/…)
 *               and picking a day_code. Changes are local only.
 *   2. REVIEW — modal showing the TemplateDiff (added/changed/removed,
 *               orphan flags, preserved-rows strip). Apply / Cancel.
 *   3. APPLY  — disabled UI while the request is in flight; toast on
 *               success/failure; on success we route back to /you and
 *               surface a "View template change" link on /today.
 *
 * Non-goals: the editor doesn't try to validate that the resulting week is
 * "reasonable" (e.g. 7 rest days). Claude's weekly coach can flag that
 * next cycle. The UX goal is to make the edit feel trivial, not to block
 * the user with nags.
 */
'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useToast } from '@/components/ui/Toast';
import type { WeeklyPattern } from '@/lib/reconcile/rollForward.pure';

type Phase = {
  id: string;
  code: string;
  name: string;
  status: string;
  starts_on?: string | null;
  target_ends_on: string | null;
};
type PhaseStub = { id: string; code: string; name: string; status: string; ordinal: number };

type DayCodeOption = { day_code: string; summary: string | null };

type Dow = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';
const DOW_ORDER: Dow[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const DOW_LABEL: Record<Dow, string> = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' };

// Type options. `rest` is always available; the rest match activity_type
// values the rest of the app already understands.
const TYPE_OPTIONS: Array<{ value: string; label: string; icon: string }> = [
  { value: 'rest',  label: 'Rest',  icon: '·' },
  { value: 'gym',   label: 'Gym',   icon: '🏋️' },
  { value: 'run',   label: 'Run',   icon: '🏃' },
  { value: 'bike',  label: 'Bike',  icon: '🚴' },
  { value: 'swim',  label: 'Swim',  icon: '🏊' },
  { value: 'yoga',  label: 'Yoga',  icon: '🧘' },
  { value: 'climb', label: 'Climb', icon: '🧗' },
];

// Diff shape the preview endpoint returns. Mirrors TemplateDiff but we
// don't need the full type tree on the client — just enough to render.
type Slot = { type: string; day_code: string | null };
type DiffUpdate = { plan_id: string; date: string; before: Slot; after: Slot };
type DiffCreate = { date: string; type: string; day_code: string | null; is_orphan: boolean };
type DiffDelete = { plan_id: string; date: string; before: Slot };
type DiffSummary = {
  added: number;
  removed: number;
  changed: number;
  skipped_ai_proposed: number;
  orphan_day_codes: Array<{ date: string; day_code: string }>;
};
type TemplateDiff = {
  phase_id: string;
  before: WeeklyPattern;
  after: WeeklyPattern;
  window: { start: string; end: string };
  updates: DiffUpdate[];
  creates: DiffCreate[];
  deletes: DiffDelete[];
  summary: DiffSummary;
  rationale: string;
};

// -------- main -------------------------------------------------------

export default function TemplateEditorClient({
  phase,
  allPhases,
  initialPattern,
  initialVersion,
  dayCodes,
}: {
  phase: Phase;
  allPhases: PhaseStub[];
  initialPattern: WeeklyPattern;
  initialVersion: number | null;
  dayCodes: DayCodeOption[];
}) {
  const router = useRouter();
  const { push } = useToast();

  const [pattern, setPattern] = useState<WeeklyPattern>(initialPattern);
  const [version] = useState<number | null>(initialVersion);
  const [pending, startTransition] = useTransition();
  const [review, setReview] = useState<{ diff: TemplateDiff; version: number | null } | null>(null);
  const [applying, setApplying] = useState(false);

  // Dirty bit: structural equality of slots. A deep-ish compare over the
  // seven keys is cheap and avoids the "you haven't changed anything"
  // footgun when the user fiddles then reverts.
  const dirty = useMemo(() => !patternsEqual(initialPattern, pattern), [initialPattern, pattern]);

  function updateSlot(dow: Dow, next: Slot | null) {
    setPattern((prev) => {
      const copy: WeeklyPattern = { ...prev };
      if (next === null) {
        delete copy[dow];
      } else {
        copy[dow] = next;
      }
      return copy;
    });
  }

  async function onReview() {
    // Bail early if nothing changed — avoid a pointless round-trip and
    // let the user know there's nothing to preview.
    if (!dirty) {
      push({ kind: 'info', title: 'No changes yet', description: 'Edit a day to see the weekly diff.' });
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch(`/api/templates/${phase.id}/preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ after: pattern }),
        });
        const body = await res.json();
        if (!res.ok) {
          push({ kind: 'info', title: 'Preview failed', description: body.error ?? 'Try again.' });
          return;
        }
        setReview({ diff: body.diff as TemplateDiff, version: body.version ?? version });
      } catch (e) {
        push({ kind: 'info', title: 'Preview failed', description: String(e) });
      }
    });
  }

  async function onApply() {
    if (!review) return;
    setApplying(true);
    try {
      const res = await fetch(`/api/templates/${phase.id}/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ after: pattern, expected_version: review.version }),
      });
      const body = await res.json();
      if (res.status === 409 && body.reason === 'version_conflict') {
        push({
          kind: 'info',
          title: 'Template changed',
          description: 'Someone else (or another tab) just saved a different edit. Reloading to show the latest.',
        });
        setApplying(false);
        setReview(null);
        router.refresh();
        return;
      }
      if (!res.ok || body.ok === false) {
        push({
          kind: 'info',
          title: 'Apply failed',
          description: body.detail ?? body.reason ?? 'Try again.',
        });
        setApplying(false);
        return;
      }

      // Success. Summary toast with a View action if there was a proposal
      // created (no_op edits don't create one).
      const total = body.applied.updates + body.applied.creates + body.applied.deletes;
      push({
        kind: 'success',
        title: body.no_op ? 'No changes to apply' : `Template updated — ${total} session${total === 1 ? '' : 's'} adjusted`,
        description: (body.diff as TemplateDiff | undefined)?.rationale,
        actionLabel: body.proposal_id ? 'View' : undefined,
        onAction: body.proposal_id ? () => router.push(`/ai/${body.proposal_id}`) : undefined,
      });
      setApplying(false);
      router.push('/you');
    } catch (e) {
      setApplying(false);
      push({ kind: 'info', title: 'Apply failed', description: String(e) });
    }
  }

  const phaseTabs = allPhases.filter((p) => p.id !== phase.id);

  return (
    <main className="max-w-xl mx-auto px-4 pt-5 pb-40">
      {/* Header */}
      <header className="mb-5">
        <div className="flex items-center justify-between gap-3">
          <Link href="/you" className="text-small text-muted-2 hover:text-accent">← Back</Link>
          <div className="text-tiny text-muted uppercase tracking-wider">Weekly template</div>
        </div>
        <div className="mt-3 flex items-baseline gap-2 flex-wrap">
          <h1 className="text-2xl font-bold tracking-tight">{phase.name}</h1>
          <span className="text-tiny text-muted-2 uppercase tracking-wider">{phase.code}</span>
        </div>
        <p className="text-small text-muted-2 mt-1">
          Set the shape of your training week. Changes affect planned sessions over the next 4 weeks —
          logged, missed, and AI-proposed sessions are preserved.
        </p>
        {phaseTabs.length > 0 && (
          <nav className="mt-3 flex gap-1.5 flex-wrap" aria-label="Switch phase">
            {phaseTabs.map((p) => (
              <Link
                key={p.id}
                href={`/you/template?phase=${p.id}`}
                className="text-tiny px-2 py-1 rounded-md bg-panel-2 border border-border text-muted-2 hover:text-accent"
              >
                {p.code} · {p.name}
              </Link>
            ))}
          </nav>
        )}
      </header>

      {/* Days */}
      <ul className="space-y-2">
        {DOW_ORDER.map((dow) => (
          <DayRow
            key={dow}
            dow={dow}
            slot={pattern[dow] ?? { type: 'rest', day_code: null }}
            onChange={(next) => updateSlot(dow, next)}
            dayCodes={dayCodes}
          />
        ))}
      </ul>

      {/* Sticky footer */}
      <div className="fixed inset-x-0 bottom-0 z-30 bg-panel border-t border-border">
        <div className="max-w-xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="flex-1 text-tiny text-muted-2">
            {dirty ? 'Unsaved changes' : 'Up to date'}
          </div>
          <Link
            href="/you"
            className="text-small px-3 py-2 rounded-lg border border-border text-muted-2 hover:text-accent"
          >
            Cancel
          </Link>
          <button
            onClick={onReview}
            disabled={!dirty || pending}
            className="text-small font-semibold px-4 py-2 rounded-lg bg-accent text-white disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {pending ? 'Previewing…' : 'Review changes'}
          </button>
        </div>
      </div>

      {/* Review modal */}
      {review && (
        <ReviewModal
          diff={review.diff}
          onCancel={() => setReview(null)}
          onApply={onApply}
          applying={applying}
        />
      )}
    </main>
  );
}

// -------- day row ----------------------------------------------------

function DayRow({
  dow,
  slot,
  onChange,
  dayCodes,
}: {
  dow: Dow;
  slot: Slot;
  onChange: (next: Slot) => void;
  dayCodes: DayCodeOption[];
}) {
  const type = slot.type ?? 'rest';
  const isRest = type === 'rest';

  return (
    <li className="rounded-xl bg-panel border border-border p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-small font-semibold">{DOW_LABEL[dow]}</div>
        <div className="text-tiny text-muted-2 uppercase tracking-wider">
          {isRest ? 'Rest' : type}
          {slot.day_code ? ` · ${slot.day_code}` : ''}
        </div>
      </div>

      {/* Segmented control — horizontally scrollable on narrow viewports */}
      <div className="flex gap-1 overflow-x-auto no-scrollbar -mx-1 px-1 pb-0.5">
        {TYPE_OPTIONS.map((opt) => {
          const active = type === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => {
                // Changing type clears day_code unless switching among the
                // same base 'type' (which doesn't happen in practice, but
                // being defensive is free).
                if (opt.value === slot.type) return;
                onChange({ type: opt.value, day_code: opt.value === 'rest' ? null : null });
              }}
              className={`shrink-0 text-tiny px-3 py-1.5 rounded-md border transition-colors whitespace-nowrap ${
                active
                  ? 'bg-accent text-white border-accent'
                  : 'bg-panel-2 border-border text-muted-2 hover:text-accent'
              }`}
            >
              <span className="mr-1" aria-hidden>{opt.icon}</span>
              {opt.label}
            </button>
          );
        })}
      </div>

      {/* day_code picker — only for non-rest days */}
      {!isRest && (
        <div className="mt-2">
          <label className="block">
            <span className="text-tiny text-muted-2 block mb-1">Session template</span>
            <select
              value={slot.day_code ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                onChange({ type, day_code: v === '' ? null : v });
              }}
              className="w-full bg-panel-2 border border-border rounded-lg px-3 py-2 text-small"
            >
              <option value="">(no template bound)</option>
              {dayCodes.map((dc) => (
                <option key={dc.day_code} value={dc.day_code}>
                  {dc.day_code}
                  {dc.summary ? ` — ${dc.summary}` : ''}
                </option>
              ))}
            </select>
          </label>
          <p className="text-tiny text-muted mt-1">
            Pulls the full prescription (exercises, sets, targets) from this phase&apos;s session.
          </p>
        </div>
      )}
    </li>
  );
}

// -------- review modal -----------------------------------------------

function ReviewModal({
  diff,
  onCancel,
  onApply,
  applying,
}: {
  diff: TemplateDiff;
  onCancel: () => void;
  onApply: () => void;
  applying: boolean;
}) {
  const { summary, updates, creates, deletes, window, rationale } = diff;
  const total = summary.added + summary.changed + summary.removed;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Review template changes"
      className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 animate-fade-in"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-md max-h-[88vh] bg-panel border-t sm:border border-border sm:rounded-xl shadow-pop flex flex-col"
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-border flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-tiny text-muted uppercase tracking-wider">Review changes</div>
            <div className="text-small font-semibold mt-0.5 truncate">
              {total === 0 ? 'No plan changes — template only' : `${total} session${total === 1 ? '' : 's'} will be adjusted`}
            </div>
          </div>
          <button
            onClick={onCancel}
            className="text-muted hover:text-white text-xl leading-none -mt-1"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Scroll body */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {/* Summary chips */}
          <div className="flex gap-2 flex-wrap">
            {summary.added > 0 && <Chip tone="ok" label={`+${summary.added} added`} />}
            {summary.changed > 0 && <Chip tone="accent" label={`${summary.changed} changed`} />}
            {summary.removed > 0 && <Chip tone="danger" label={`${summary.removed} removed`} />}
            {summary.skipped_ai_proposed > 0 && (
              <Chip tone="muted" label={`${summary.skipped_ai_proposed} AI-proposed preserved`} />
            )}
          </div>

          {/* Rationale */}
          <p className="text-tiny text-muted-2 leading-relaxed">{rationale}</p>

          {/* Window */}
          <p className="text-tiny text-muted">
            Scope: {window.start} → {window.end} (planned sessions only)
          </p>

          {/* Orphan warning */}
          {summary.orphan_day_codes.length > 0 && (
            <div className="rounded-lg border border-warn/40 bg-warn/10 p-3">
              <div className="text-small font-semibold text-warn">Heads up: missing session templates</div>
              <p className="text-tiny text-muted-2 mt-1">
                These dates reference a session template that doesn&apos;t exist yet in this phase.
                The plan row will be created as a placeholder — add the template to this phase&apos;s calendar to
                populate the full prescription.
              </p>
              <ul className="mt-2 text-tiny text-muted-2 space-y-0.5">
                {summary.orphan_day_codes.slice(0, 6).map((o, i) => (
                  <li key={i}>
                    <span className="text-muted">{o.date}</span> · {o.day_code}
                  </li>
                ))}
                {summary.orphan_day_codes.length > 6 && (
                  <li className="text-muted">+ {summary.orphan_day_codes.length - 6} more</li>
                )}
              </ul>
            </div>
          )}

          {/* Added */}
          <DetailsSection
            title={`Added (${summary.added})`}
            open={summary.added > 0 && summary.added <= 6}
            empty={creates.length === 0 ? 'No new sessions.' : undefined}
          >
            {creates.map((c) => (
              <Row
                key={c.date + c.type + (c.day_code ?? '')}
                date={c.date}
                left={<span className="text-muted-2">— empty —</span>}
                right={<SlotPill type={c.type} dayCode={c.day_code} orphan={c.is_orphan} />}
              />
            ))}
          </DetailsSection>

          {/* Changed */}
          <DetailsSection
            title={`Changed (${summary.changed})`}
            open={summary.changed > 0 && summary.changed <= 6}
            empty={updates.length === 0 ? 'No sessions changed shape.' : undefined}
          >
            {updates.map((u) => (
              <Row
                key={u.plan_id}
                date={u.date}
                left={<SlotPill type={u.before.type} dayCode={u.before.day_code} />}
                right={<SlotPill type={u.after.type} dayCode={u.after.day_code} />}
              />
            ))}
          </DetailsSection>

          {/* Removed */}
          <DetailsSection
            title={`Removed (${summary.removed})`}
            open={summary.removed > 0 && summary.removed <= 6}
            empty={deletes.length === 0 ? 'No sessions removed.' : undefined}
          >
            {deletes.map((d) => (
              <Row
                key={d.plan_id}
                date={d.date}
                left={<SlotPill type={d.before.type} dayCode={d.before.day_code} />}
                right={<span className="text-muted-2">— removed —</span>}
              />
            ))}
          </DetailsSection>

          {summary.skipped_ai_proposed > 0 && (
            <p className="text-tiny text-muted-2 leading-relaxed border-t border-border pt-3">
              <span className="font-semibold text-muted">
                {summary.skipped_ai_proposed} AI-proposed session{summary.skipped_ai_proposed === 1 ? ' is' : 's are'} preserved.
              </span>{' '}
              Claude previously suggested a change for {summary.skipped_ai_proposed === 1 ? 'this date' : 'these dates'} and
              you accepted it. Editing the weekly template won&apos;t quietly undo those picks — dismiss them individually if you want them gone.
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border flex items-center gap-3">
          <button
            onClick={onCancel}
            disabled={applying}
            className="text-small px-3 py-2 rounded-lg border border-border text-muted-2 disabled:opacity-50"
          >
            Back to edit
          </button>
          <button
            onClick={onApply}
            disabled={applying}
            className="flex-1 text-small font-semibold px-4 py-2 rounded-lg bg-accent text-white disabled:opacity-50"
          >
            {applying ? 'Applying…' : total === 0 ? 'Save template' : 'Apply changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// -------- tiny UI helpers --------------------------------------------

function Chip({ tone, label }: { tone: 'ok' | 'accent' | 'danger' | 'muted'; label: string }) {
  const cls =
    tone === 'ok' ? 'bg-ok/15 text-ok border-ok/30'
    : tone === 'accent' ? 'bg-accent-soft text-accent border-accent/30'
    : tone === 'danger' ? 'bg-danger/15 text-danger border-danger/30'
    : 'bg-panel-2 text-muted-2 border-border';
  return (
    <span className={`text-tiny px-2 py-1 rounded-md border ${cls}`}>{label}</span>
  );
}

function DetailsSection({
  title,
  open,
  empty,
  children,
}: {
  title: string;
  open?: boolean;
  empty?: string;
  children: React.ReactNode;
}) {
  const hasContent = !empty;
  return (
    <details open={!!open} className="rounded-lg bg-panel-2/40 border border-border">
      <summary className="px-3 py-2 text-small font-medium cursor-pointer select-none list-none flex items-center justify-between">
        <span>{title}</span>
        <span className="text-muted text-tiny">{hasContent ? '' : empty}</span>
      </summary>
      {hasContent && <div className="px-3 pb-3 pt-1 space-y-1">{children}</div>}
    </details>
  );
}

function Row({
  date,
  left,
  right,
}: {
  date: string;
  left: React.ReactNode;
  right: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 text-tiny">
      <span className="w-20 text-muted-2 shrink-0">{formatDate(date)}</span>
      <span className="flex-1 min-w-0 truncate">{left}</span>
      <span className="text-muted shrink-0">→</span>
      <span className="flex-1 min-w-0 truncate">{right}</span>
    </div>
  );
}

function SlotPill({
  type,
  dayCode,
  orphan,
}: {
  type: string;
  dayCode: string | null;
  orphan?: boolean;
}) {
  if (type === 'rest') return <span className="text-muted-2">Rest</span>;
  return (
    <span>
      <span className="text-muted">{type}</span>
      {dayCode && (
        <span className="text-accent"> · {dayCode}{orphan ? ' ⚠︎' : ''}</span>
      )}
    </span>
  );
}

// -------- helpers ----------------------------------------------------

function formatDate(iso: string): string {
  // MM/dd in user-local; inputs are yyyy-MM-dd so a cheap split avoids
  // Date construction entirely.
  const [, m, d] = iso.split('-');
  return `${Number(m)}/${Number(d)}`;
}

function patternsEqual(a: WeeklyPattern, b: WeeklyPattern): boolean {
  for (const dow of DOW_ORDER) {
    const sa = a[dow];
    const sb = b[dow];
    if (!sa && !sb) continue;
    if (!sa || !sb) return false;
    if (sa.type !== sb.type) return false;
    if ((sa.day_code ?? null) !== (sb.day_code ?? null)) return false;
  }
  return true;
}
