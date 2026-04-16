/**
 * Availability windows — client component (P1.3 / PR-Q).
 *
 * Three conceptual surfaces, all rendered in the same page:
 *
 *   1. LIST — grouped windows (Active now, Upcoming, Recent), each card
 *      showing kind / range / strategy / status with edit+cancel affordances.
 *
 *   2. FORM — bottom-sheet (mobile) / centered modal (desktop) for
 *      creating a new window or modifying an existing one. Same shape in
 *      both modes; the edit path pre-fills and locks `kind` (immutable
 *      per backend contract).
 *
 *   3. REVIEW — preview modal that calls /api/availability/preview, shows
 *      the resulting diff (added / changed / removed with preserved
 *      counts) and resolves on Apply → real POST/PATCH → toast.
 *
 * Design decisions worth calling out:
 *
 *   - No preview round-trip on pure date-range tweaks while typing. The
 *     form locally validates the range, but only runs the diff preview
 *     when the user taps "Review". This keeps DB pressure bounded and
 *     avoids a noisy "you changed one day" reflex.
 *
 *   - Cancel flow is a two-step confirmation (not an undo-on-toast).
 *     Rolling back to the template means rewriting plan rows; a simple
 *     toast undo wouldn't reliably reverse it under drift. Full confirm
 *     dialog with the diff preview gives users what they need.
 *
 *   - Kind is immutable on edit. The form disables the kind tabs in edit
 *     mode and surfaces a footnote: "To change kind, cancel and start a
 *     new window." Matches the backend rule in buildModifyWindowDiff.
 *
 *   - The resolved-strategy explanation (what 'auto' actually does for
 *     this kind) is rendered near the strategy picker so users never
 *     have to guess what 'auto' does for injury vs travel.
 */

'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/ui/Toast';
import WindowGlyph from '@/components/ui/WindowGlyph';
import { DictationButton } from '@/components/ui/Dictation';
import { appendTranscript } from '@/components/ui/DictationInput';
import {
  KIND_META,
  STRATEGY_META,
  formatRange,
  formatShortDate,
  inclusiveDayCount,
  relativeWindowPhrase,
  resolvedStrategyLabel,
  windowTemporalPhase,
  type WindowTemporalPhase,
} from '@/lib/availability/ui';
import { resolveWindowStrategy } from '@/lib/reconcile/rollForward.pure';
import type {
  AvailabilityWindowKind,
  AvailabilityWindowStrategy,
} from '@/lib/reconcile/rollForward.pure';
import type {
  AvailabilityDiffOk,
  Conflict,
  WindowRow,
} from './types';

// =====================================================================
// Entry — list + dialog state
// =====================================================================

type FormMode =
  | { kind: 'closed' }
  | { kind: 'create' }
  | { kind: 'edit'; window: WindowRow };

type ReviewState = {
  diff: AvailabilityDiffOk;
  // Snapshot of the form values at review time — used for the actual
  // apply call (the form may be in the background but we shouldn't
  // re-read it, because a mid-review tweak would mismatch the preview).
  input:
    | { mode: 'create'; payload: CreatePayload }
    | { mode: 'edit'; windowId: string; payload: EditPayload };
};

type CreatePayload = {
  starts_on: string;
  ends_on: string;
  kind: AvailabilityWindowKind;
  strategy: AvailabilityWindowStrategy;
  note: string | null;
};

type EditPayload = {
  starts_on: string;
  ends_on: string;
  strategy: AvailabilityWindowStrategy;
  note: string | null;
};

export default function AvailabilityClient({
  windows,
  todayIso,
}: {
  windows: WindowRow[];
  todayIso: string;
}) {
  const [form, setForm] = useState<FormMode>({ kind: 'closed' });
  const [review, setReview] = useState<ReviewState | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState<WindowRow | null>(null);

  // Group windows for presentation. Active windows first (most relevant),
  // then upcoming, then recent (past/cancelled — collapsed).
  const grouped = useMemo(() => groupWindows(windows, todayIso), [windows, todayIso]);

  return (
    <main className="max-w-xl mx-auto px-4 pt-5 pb-32">
      {/* Header */}
      <header className="mb-5">
        <div className="flex items-center justify-between gap-3 mb-3">
          <Link href="/you" className="text-small text-muted-2 hover:text-accent">
            ← Back
          </Link>
          <div className="text-tiny text-muted uppercase tracking-wider">Availability</div>
        </div>
        <h1 className="text-2xl font-bold tracking-tight">Travel, injury &amp; pauses</h1>
        <p className="text-small text-muted-2 mt-1">
          Declare a window and your plan quietly reshapes itself — bodyweight
          sessions for a trip, rest for an injury, or a clean pause. Logged
          work, manual entries, and AI-proposed swaps are always preserved.
        </p>
      </header>

      {/* Empty state */}
      {windows.length === 0 && (
        <EmptyState onCreate={() => setForm({ kind: 'create' })} />
      )}

      {/* Active section */}
      {grouped.active.length > 0 && (
        <ListSection
          title="Active now"
          windows={grouped.active}
          todayIso={todayIso}
          onEdit={(w) => setForm({ kind: 'edit', window: w })}
          onCancel={(w) => setConfirmingCancel(w)}
        />
      )}

      {/* Upcoming section */}
      {grouped.upcoming.length > 0 && (
        <ListSection
          title="Upcoming"
          windows={grouped.upcoming}
          todayIso={todayIso}
          onEdit={(w) => setForm({ kind: 'edit', window: w })}
          onCancel={(w) => setConfirmingCancel(w)}
        />
      )}

      {/* Primary CTA — sits below the upcoming list when there's content,
          inline when empty. Always accessible without scrolling the sheet. */}
      {windows.length > 0 && (
        <div className="mt-4 mb-6">
          <button
            onClick={() => setForm({ kind: 'create' })}
            className="w-full rounded-xl bg-accent text-black font-semibold py-3 text-base"
          >
            + Declare a window
          </button>
        </div>
      )}

      {/* Recent (past / cancelled) — collapsed by default */}
      {grouped.recent.length > 0 && (
        <RecentSection windows={grouped.recent} todayIso={todayIso} />
      )}

      {/* Form dialog */}
      {form.kind !== 'closed' && (
        <FormDialog
          mode={form}
          todayIso={todayIso}
          existingWindows={windows}
          onClose={() => setForm({ kind: 'closed' })}
          onReview={(r) => setReview(r)}
        />
      )}

      {/* Review modal — only shown once a preview has returned */}
      {review && (
        <ReviewDialog
          state={review}
          onBack={() => setReview(null)}
          onApplied={() => {
            setReview(null);
            setForm({ kind: 'closed' });
          }}
        />
      )}

      {/* Cancel confirmation */}
      {confirmingCancel && (
        <CancelDialog
          window={confirmingCancel}
          onClose={() => setConfirmingCancel(null)}
          onDone={() => setConfirmingCancel(null)}
        />
      )}
    </main>
  );
}

// =====================================================================
// Grouping
// =====================================================================

type Grouped = {
  active: WindowRow[];
  upcoming: WindowRow[];
  recent: WindowRow[];
};

function groupWindows(windows: WindowRow[], todayIso: string): Grouped {
  const active: WindowRow[] = [];
  const upcoming: WindowRow[] = [];
  const recent: WindowRow[] = [];

  for (const w of windows) {
    if (w.status === 'cancelled') {
      recent.push(w);
      continue;
    }
    const phase = windowTemporalPhase(w.starts_on, w.ends_on, todayIso);
    if (phase === 'active') active.push(w);
    else if (phase === 'upcoming') upcoming.push(w);
    else recent.push(w);
  }

  // Sort for readability:
  //   active — soonest-to-end first (most urgent on top)
  //   upcoming — soonest-to-start first
  //   recent — newest first
  active.sort((a, b) => a.ends_on.localeCompare(b.ends_on));
  upcoming.sort((a, b) => a.starts_on.localeCompare(b.starts_on));
  recent.sort((a, b) => b.ends_on.localeCompare(a.ends_on));

  return { active, upcoming, recent };
}

// =====================================================================
// Empty state
// =====================================================================

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="rounded-2xl bg-panel border border-border p-6 text-center">
      <div className="flex justify-center gap-3 mb-4">
        <WindowGlyph kind="travel" size={28} />
        <WindowGlyph kind="injury" size={28} />
        <WindowGlyph kind="pause" size={28} />
      </div>
      <h2 className="text-lg font-semibold mb-1">No windows yet</h2>
      <p className="text-small text-muted-2 mb-5 leading-relaxed">
        Traveling, nursing something, or stepping back for a beat? Declare
        it here and Claude will reshape the next stretch of your plan — and
        restore it automatically the moment you&rsquo;re back.
      </p>
      <button
        onClick={onCreate}
        className="w-full rounded-xl bg-accent text-black font-semibold py-3 text-base"
      >
        + Declare your first window
      </button>
    </section>
  );
}

// =====================================================================
// List + card
// =====================================================================

function ListSection({
  title,
  windows,
  todayIso,
  onEdit,
  onCancel,
}: {
  title: string;
  windows: WindowRow[];
  todayIso: string;
  onEdit: (w: WindowRow) => void;
  onCancel: (w: WindowRow) => void;
}) {
  return (
    <section className="mb-5">
      <h2 className="text-tiny text-muted uppercase tracking-wider mb-2 px-1">
        {title}
      </h2>
      <ul className="space-y-2">
        {windows.map((w) => (
          <li key={w.id}>
            <WindowCard
              window={w}
              todayIso={todayIso}
              onEdit={() => onEdit(w)}
              onCancel={() => onCancel(w)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function WindowCard({
  window: w,
  todayIso,
  onEdit,
  onCancel,
}: {
  window: WindowRow;
  todayIso: string;
  onEdit: () => void;
  onCancel: () => void;
}) {
  const meta = KIND_META[w.kind];
  const phase = windowTemporalPhase(w.starts_on, w.ends_on, todayIso);
  const days = inclusiveDayCount(w.starts_on, w.ends_on);
  const resolvedLabel = resolvedStrategyLabel(w.kind, w.strategy);
  const relative = relativeWindowPhrase(w.starts_on, w.ends_on, todayIso);

  return (
    <article className="rounded-xl bg-panel border border-border p-4">
      <div className="flex items-start gap-3">
        <div className={`shrink-0 w-10 h-10 rounded-lg ${meta.tint.bg} ring-1 ${meta.tint.ring} flex items-center justify-center`}>
          <WindowGlyph kind={w.kind} size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <h3 className="text-base font-semibold truncate">{meta.longLabel}</h3>
            {phase === 'active' && (
              <span className="text-tiny text-accent font-semibold uppercase tracking-wider shrink-0">
                Live
              </span>
            )}
          </div>
          <div className="text-small text-muted-2 mt-0.5">
            {formatRange(w.starts_on, w.ends_on)}
            <span className="text-muted"> · </span>
            {days} day{days === 1 ? '' : 's'}
          </div>
          <div className="text-tiny text-muted mt-1">{relative}</div>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <Chip tone="accent" label={resolvedLabel} />
        {w.strategy === 'auto' && (
          <span className="text-tiny text-muted-2">auto · kind default</span>
        )}
      </div>

      {w.note && (
        <p className="mt-3 text-small text-muted-2 leading-relaxed border-t border-border pt-3">
          &ldquo;{w.note}&rdquo;
        </p>
      )}

      <div className="mt-4 flex items-center gap-2">
        <button
          onClick={onEdit}
          className="text-small px-3 py-1.5 rounded-lg bg-panel-2 border border-border text-muted-2 hover:text-accent"
        >
          Edit
        </button>
        <button
          onClick={onCancel}
          className="text-small px-3 py-1.5 rounded-lg bg-panel-2 border border-danger/30 text-danger hover:bg-danger/10"
        >
          Cancel window
        </button>
      </div>
    </article>
  );
}

// =====================================================================
// Recent — collapsed disclosure for past + cancelled
// =====================================================================

function RecentSection({
  windows,
  todayIso,
}: {
  windows: WindowRow[];
  todayIso: string;
}) {
  return (
    <section className="mb-5">
      <details className="rounded-xl bg-panel border border-border">
        <summary className="px-4 py-3 text-small font-medium cursor-pointer select-none list-none flex items-center justify-between">
          <span>Recent windows <span className="text-muted-2 font-normal">· {windows.length}</span></span>
          <span className="text-muted transition-transform details-chevron">›</span>
        </summary>
        <ul className="border-t border-border divide-y divide-border">
          {windows.map((w) => (
            <li key={w.id} className="px-4 py-3 flex items-center gap-3">
              <WindowGlyph kind={w.kind} size={16} />
              <div className="flex-1 min-w-0">
                <div className="text-small truncate">
                  {KIND_META[w.kind].longLabel}
                  <span className="text-muted-2">
                    {' · '}{formatRange(w.starts_on, w.ends_on)}
                  </span>
                </div>
                <div className="text-tiny text-muted">
                  {w.status === 'cancelled'
                    ? `Cancelled${w.cancelled_at ? ` ${formatShortDate(w.cancelled_at.slice(0, 10))}` : ''}`
                    : `Ended ${formatShortDate(w.ends_on)}`}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

// =====================================================================
// Form dialog — create + edit
// =====================================================================

function FormDialog({
  mode,
  todayIso,
  existingWindows,
  onClose,
  onReview,
}: {
  mode: Exclude<FormMode, { kind: 'closed' }>;
  todayIso: string;
  existingWindows: WindowRow[];
  onClose: () => void;
  onReview: (r: ReviewState) => void;
}) {
  const router = useRouter();
  const editing = mode.kind === 'edit';

  // If preview comes back with a 404/409 drift signal, the window we're
  // editing is gone or cancelled. Refetch the page (to re-render the
  // list) and close the dialog on the next tick.
  const onDrift = () => {
    router.refresh();
    setTimeout(onClose, 400);
  };

  // Seed values from the window being edited, or sensible create-time
  // defaults (today .. today + 6 days, travel kind, auto strategy).
  const seed = useMemo<CreatePayload>(() => {
    if (mode.kind === 'edit') {
      return {
        starts_on: mode.window.starts_on,
        ends_on: mode.window.ends_on,
        kind: mode.window.kind,
        strategy: mode.window.strategy,
        note: mode.window.note,
      };
    }
    return {
      starts_on: todayIso,
      ends_on: addDaysIso(todayIso, 6),
      kind: 'travel',
      strategy: 'auto',
      note: null,
    };
  }, [mode, todayIso]);

  const [starts_on, setStartsOn] = useState(seed.starts_on);
  const [ends_on, setEndsOn] = useState(seed.ends_on);
  const [kind, setKind] = useState<AvailabilityWindowKind>(seed.kind);
  const [strategy, setStrategy] = useState<AvailabilityWindowStrategy>(seed.strategy);
  const [note, setNote] = useState(seed.note ?? '');
  const [previewing, startPreview] = useTransition();
  const [errorText, setErrorText] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const { push } = useToast();

  const dayCount = inclusiveDayCount(starts_on, ends_on);
  const rangeValid = starts_on && ends_on && starts_on <= ends_on;
  const resolved = resolveWindowStrategy(kind, strategy);
  const meta = KIND_META[kind];

  // Local overlap hint — matches the backend's overlap rule. Purely
  // advisory; the backend is authoritative and will reject with 409 if
  // the client is wrong.
  const overlapHint = useMemo(() => {
    if (!rangeValid) return null;
    const effStart = starts_on > todayIso ? starts_on : todayIso;
    const effEnd = ends_on;
    if (effStart > effEnd) return null;
    const myId = mode.kind === 'edit' ? mode.window.id : null;
    const clashes = existingWindows.filter((w) => {
      if (w.status !== 'active') return false;
      if (w.id === myId) return false;
      return effStart <= w.ends_on && w.starts_on <= effEnd;
    });
    return clashes.length > 0 ? clashes : null;
  }, [rangeValid, starts_on, ends_on, todayIso, existingWindows, mode]);

  async function onSubmit() {
    setErrorText(null);
    setConflicts(null);

    if (!rangeValid) {
      setErrorText('Start date must be on or before end date.');
      return;
    }
    if (ends_on < todayIso) {
      setErrorText('The window is entirely in the past — pick a future end date.');
      return;
    }
    // Length cap: the pure engine caps at 400 days. Surface this early.
    if (dayCount > 365) {
      setErrorText('Windows can\u2019t be longer than a year. Break it up into smaller blocks.');
      return;
    }

    const trimmedNote = note.trim();
    const noteOrNull = trimmedNote.length > 0 ? trimmedNote : null;

    startPreview(async () => {
      try {
        const body = mode.kind === 'edit'
          ? {
              window_id: mode.window.id,
              patch: {
                starts_on,
                ends_on,
                strategy,
                note: noteOrNull,
              },
            }
          : {
              starts_on,
              ends_on,
              kind,
              strategy,
              note: noteOrNull,
            };

        const res = await fetch('/api/availability/preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = await res.json();

        if (res.status === 409 && json.error === 'overlaps_existing') {
          setConflicts(json.conflicts ?? []);
          return;
        }
        // Drift: the window we're editing was cancelled or deleted on
        // another tab / device. The only sane recovery is to close the
        // dialog and let the parent refetch the list.
        if (res.status === 404 && json.error === 'window_not_found') {
          setErrorText('This window was just removed. Refresh to see the latest state.');
          push({
            kind: 'info',
            title: 'Window no longer exists',
            description: 'It was cancelled on another device. Refreshing your view.',
          });
          onDrift();
          return;
        }
        if (res.status === 409 && json.error === 'window_not_active') {
          setErrorText('This window was cancelled elsewhere. Refresh to see the latest state.');
          push({
            kind: 'info',
            title: 'Window already cancelled',
            description: 'Another device cancelled this window. Refreshing your view.',
          });
          onDrift();
          return;
        }
        if (!res.ok) {
          setErrorText(json.detail ?? json.error ?? 'Preview failed.');
          return;
        }

        const input: ReviewState['input'] = mode.kind === 'edit'
          ? {
              mode: 'edit',
              windowId: mode.window.id,
              payload: {
                starts_on,
                ends_on,
                strategy,
                note: noteOrNull,
              },
            }
          : {
              mode: 'create',
              payload: {
                starts_on,
                ends_on,
                kind,
                strategy,
                note: noteOrNull,
              },
            };

        onReview({ diff: json.diff as AvailabilityDiffOk, input });
      } catch (e) {
        setErrorText(String(e));
        push({ kind: 'info', title: 'Preview failed', description: String(e) });
      }
    });
  }

  return (
    <Sheet
      title={editing ? 'Edit window' : 'Declare a window'}
      onClose={onClose}
      footer={
        <>
          <button
            onClick={onClose}
            disabled={previewing}
            className="text-small px-3 py-2 rounded-lg border border-border text-muted-2 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onSubmit}
            disabled={previewing || !rangeValid}
            className="flex-1 text-small font-semibold px-4 py-2 rounded-lg bg-accent text-black disabled:opacity-40"
          >
            {previewing ? 'Previewing…' : 'Review changes'}
          </button>
        </>
      }
    >
      {/* Kind selector (locked in edit mode) */}
      <FieldGroup
        label="What kind?"
        helper={
          editing
            ? 'Kind is locked after creation. To change it, cancel this window and start a new one.'
            : meta.blurb
        }
      >
        <div className="flex gap-1.5 flex-wrap">
          {(['travel', 'injury', 'pause'] as AvailabilityWindowKind[]).map((k) => {
            const m = KIND_META[k];
            const active = kind === k;
            const disabled = editing && k !== seed.kind;
            return (
              <button
                key={k}
                type="button"
                disabled={disabled}
                onClick={() => {
                  if (disabled) return;
                  setKind(k);
                  // Reset strategy to auto so the kind's natural default applies,
                  // unless the user had explicitly set it.
                  if (strategy !== 'auto') return;
                }}
                className={`flex-1 min-w-[90px] rounded-lg px-3 py-2.5 border text-small flex flex-col items-center gap-1 transition-colors ${
                  active
                    ? `${m.tint.bg} ring-1 ${m.tint.ring} ${m.tint.text} border-transparent`
                    : 'bg-panel-2 border-border text-muted-2 hover:text-accent'
                } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                aria-pressed={active}
              >
                <WindowGlyph kind={k} size={20} color={active ? m.tint.hex : undefined} />
                <span className="font-medium">{m.label}</span>
              </button>
            );
          })}
        </div>
      </FieldGroup>

      {/* Date range */}
      <FieldGroup
        label="From…"
        helper={rangeValid ? `${dayCount} day${dayCount === 1 ? '' : 's'} inclusive` : ''}
      >
        <div className="flex items-center gap-2">
          <DateInput value={starts_on} onChange={setStartsOn} />
          <span className="text-muted">→</span>
          <DateInput value={ends_on} onChange={setEndsOn} min={starts_on} />
        </div>
      </FieldGroup>

      {/* Strategy */}
      <FieldGroup
        label="What happens inside"
        helper={
          strategy === 'auto'
            ? `Auto → ${STRATEGY_META[resolved].label.toLowerCase()} (default for ${meta.label.toLowerCase()}). ${STRATEGY_META[resolved].blurb}`
            : STRATEGY_META[strategy].blurb
        }
      >
        <div className="grid grid-cols-2 gap-1.5">
          {(['auto', 'bodyweight', 'rest', 'suppress'] as AvailabilityWindowStrategy[]).map((s) => {
            const active = strategy === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => setStrategy(s)}
                className={`rounded-lg px-3 py-2 text-small border text-left ${
                  active
                    ? 'bg-accent-soft ring-1 ring-accent/40 text-accent border-transparent'
                    : 'bg-panel-2 border-border text-muted-2 hover:text-accent'
                }`}
                aria-pressed={active}
              >
                <div className="font-medium">{STRATEGY_META[s].label}</div>
                {s === 'auto' && (
                  <div className="text-tiny text-muted-2 mt-0.5">
                    → {STRATEGY_META[resolved].label.toLowerCase()}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </FieldGroup>

      {/* Note */}
      <FieldGroup
        label="Note"
        helper="Shows up on plan cards during the window. Keep it short."
        optional
      >
        <div className="relative">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 500))}
            rows={2}
            placeholder={kind === 'travel' ? 'e.g. Lisbon, hotel only' : kind === 'injury' ? 'e.g. left knee, easing back' : 'e.g. work crunch'}
            className="w-full bg-panel-2 border border-border rounded-lg px-3 py-2 pr-10 text-small resize-none"
          />
          <div className="absolute bottom-2 right-2">
            <DictationButton
              size="sm"
              compact
              onTranscript={(t: string) => setNote((prev) => appendTranscript(prev, t).slice(0, 500))}
            />
          </div>
        </div>
        <div className="text-tiny text-muted text-right mt-1">{note.length}/500</div>
      </FieldGroup>

      {/* Inline conflict / error area */}
      {conflicts && conflicts.length > 0 && (
        <div className="rounded-lg border border-warn/40 bg-warn/10 p-3 mt-2">
          <div className="text-small font-semibold text-warn">Overlaps an existing window</div>
          <p className="text-tiny text-muted-2 mt-1">
            Windows can&rsquo;t stack in this version. Edit the conflicting window first, or pick a different range.
          </p>
          <ul className="mt-2 text-tiny text-muted-2 space-y-0.5">
            {conflicts.map((c) => (
              <li key={c.id}>
                {KIND_META[c.kind].longLabel} · {formatRange(c.starts_on, c.ends_on)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {errorText && (
        <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 mt-2 text-small text-danger">
          {errorText}
        </div>
      )}

      {/* Upfront overlap hint — runs client-side; pure courtesy. */}
      {!conflicts && overlapHint && (
        <p className="text-tiny text-warn mt-1">
          Heads up: this range overlaps {overlapHint.length === 1 ? 'an existing window' : `${overlapHint.length} existing windows`}.
          You&rsquo;ll see the conflict details when you review.
        </p>
      )}
    </Sheet>
  );
}

// =====================================================================
// Review dialog
// =====================================================================

function ReviewDialog({
  state,
  onBack,
  onApplied,
}: {
  state: ReviewState;
  onBack: () => void;
  onApplied: () => void;
}) {
  const router = useRouter();
  const { push } = useToast();
  const [applying, setApplying] = useState(false);
  const { diff, input } = state;
  const { summary, creates, updates, deletes, rationale, range } = diff;

  const totalOps = summary.added + summary.changed + summary.removed;
  const preserved =
    summary.skipped_logged +
    summary.skipped_manual +
    summary.skipped_ai_proposed +
    summary.skipped_other_window;

  async function onApply() {
    setApplying(true);
    try {
      const res = input.mode === 'create'
        ? await fetch('/api/availability', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input.payload),
          })
        : await fetch(`/api/availability/${input.windowId}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input.payload),
          });

      const body = await res.json();

      if (res.status === 409 && body.reason === 'overlaps_existing') {
        push({
          kind: 'info',
          title: 'Window overlaps another',
          description: 'Another window changed under you. Reload to see the latest.',
        });
        setApplying(false);
        router.refresh();
        return;
      }

      if (!res.ok || body.ok === false) {
        push({
          kind: 'info',
          title: input.mode === 'create' ? 'Couldn\u2019t create window' : 'Couldn\u2019t save changes',
          description: body.detail ?? body.reason ?? 'Try again.',
        });
        setApplying(false);
        return;
      }

      const applied =
        (body.applied?.updates ?? 0) +
        (body.applied?.creates ?? 0) +
        (body.applied?.deletes ?? 0);

      push({
        kind: 'success',
        title:
          input.mode === 'create'
            ? applied > 0
              ? `Window applied — ${applied} session${applied === 1 ? '' : 's'} adjusted`
              : 'Window created'
            : applied > 0
              ? `Window updated — ${applied} session${applied === 1 ? '' : 's'} adjusted`
              : 'Window updated',
        description: body.diff?.rationale,
        actionLabel: body.proposal_id ? 'View' : undefined,
        onAction: body.proposal_id ? () => router.push(`/ai/${body.proposal_id}`) : undefined,
      });
      setApplying(false);
      onApplied();
      router.refresh();
    } catch (e) {
      setApplying(false);
      push({ kind: 'info', title: 'Apply failed', description: String(e) });
    }
  }

  return (
    <Sheet
      title={input.mode === 'create' ? 'Review new window' : 'Review changes'}
      onClose={applying ? () => {} : onBack}
      footer={
        <>
          <button
            onClick={onBack}
            disabled={applying}
            className="text-small px-3 py-2 rounded-lg border border-border text-muted-2 disabled:opacity-50"
          >
            Back
          </button>
          <button
            onClick={onApply}
            disabled={applying}
            className="flex-1 text-small font-semibold px-4 py-2 rounded-lg bg-accent text-black disabled:opacity-50"
          >
            {applying
              ? 'Applying…'
              : totalOps === 0 && input.mode === 'create'
                ? 'Save window'
                : 'Apply changes'}
          </button>
        </>
      }
    >
      {/* Summary chips */}
      <div className="flex gap-2 flex-wrap">
        {summary.added > 0 && <Chip tone="ok" label={`+${summary.added} added`} />}
        {summary.changed > 0 && <Chip tone="accent" label={`${summary.changed} reshaped`} />}
        {summary.removed > 0 && <Chip tone="danger" label={`${summary.removed} cleared`} />}
        {preserved > 0 && (
          <Chip tone="muted" label={`${preserved} preserved`} />
        )}
        {totalOps === 0 && (
          <Chip tone="muted" label="No plan changes" />
        )}
      </div>

      {/* Rationale */}
      <p className="text-tiny text-muted-2 leading-relaxed mt-3">{rationale}</p>

      {/* Scope */}
      {range && (
        <p className="text-tiny text-muted mt-2">
          Scope: {formatRange(range.start, range.end)} (planned sessions only).
        </p>
      )}

      {/* Added */}
      <DetailsSection
        title={`Added (${summary.added})`}
        open={summary.added > 0 && summary.added <= 6}
        empty={creates.length === 0 ? 'No new sessions.' : undefined}
      >
        {creates.map((c) => (
          <Row
            key={c.date + c.type}
            date={c.date}
            left={<span className="text-muted-2">— empty —</span>}
            right={<SlotPill type={c.type} dayCode={c.day_code} source={c.source} />}
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
            left={<SlotPill type={u.before.type} dayCode={u.before.day_code} source={u.before.source} />}
            right={<SlotPill type={u.after.type} dayCode={u.after.day_code} source={u.after.source} />}
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
            left={<SlotPill type={d.before.type} dayCode={d.before.day_code} source={d.before.source} />}
            right={<span className="text-muted-2">— removed —</span>}
          />
        ))}
      </DetailsSection>

      {/* Preserved call-out */}
      {preserved > 0 && (
        <PreservedCallout summary={summary} />
      )}
    </Sheet>
  );
}

function PreservedCallout({ summary }: { summary: AvailabilityDiffOk['summary'] }) {
  const parts: string[] = [];
  if (summary.skipped_logged) parts.push(`${summary.skipped_logged} logged`);
  if (summary.skipped_manual) parts.push(`${summary.skipped_manual} manual`);
  if (summary.skipped_ai_proposed) parts.push(`${summary.skipped_ai_proposed} AI-proposed`);
  if (summary.skipped_other_window) parts.push(`${summary.skipped_other_window} other-window`);
  return (
    <p className="text-tiny text-muted-2 leading-relaxed border-t border-border pt-3 mt-4">
      <span className="font-semibold text-muted">Preserved:</span> {parts.join(', ')}.
      The window won&rsquo;t touch these — edit or log them individually if you want to.
    </p>
  );
}

// =====================================================================
// Cancel dialog — confirmation + preview
// =====================================================================

function CancelDialog({
  window: w,
  onClose,
  onDone,
}: {
  window: WindowRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const router = useRouter();
  const { push } = useToast();
  const [busy, setBusy] = useState(false);

  async function onConfirm() {
    setBusy(true);
    try {
      const res = await fetch(`/api/availability/${w.id}`, { method: 'DELETE' });
      const body = await res.json();
      if (!res.ok || body.ok === false) {
        push({
          kind: 'info',
          title: 'Couldn\u2019t cancel',
          description: body.detail ?? body.reason ?? 'Try again.',
        });
        setBusy(false);
        return;
      }
      const applied =
        (body.applied?.updates ?? 0) +
        (body.applied?.creates ?? 0) +
        (body.applied?.deletes ?? 0);
      push({
        kind: 'success',
        title: applied > 0
          ? `Window cancelled — ${applied} session${applied === 1 ? '' : 's'} restored`
          : 'Window cancelled',
        description: body.diff?.rationale,
        actionLabel: body.proposal_id ? 'View' : undefined,
        onAction: body.proposal_id ? () => router.push(`/ai/${body.proposal_id}`) : undefined,
      });
      setBusy(false);
      onDone();
      router.refresh();
    } catch (e) {
      setBusy(false);
      push({ kind: 'info', title: 'Cancel failed', description: String(e) });
    }
  }

  return (
    <Sheet
      title={`Cancel ${KIND_META[w.kind].label.toLowerCase()} window?`}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button
            onClick={onClose}
            disabled={busy}
            className="text-small px-3 py-2 rounded-lg border border-border text-muted-2 disabled:opacity-50"
          >
            Keep it
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="flex-1 text-small font-semibold px-4 py-2 rounded-lg bg-danger/20 text-danger border border-danger/40 disabled:opacity-50"
          >
            {busy ? 'Cancelling…' : 'Cancel window'}
          </button>
        </>
      }
    >
      <p className="text-small text-muted-2 leading-relaxed">
        This restores your template for {formatRange(w.starts_on, w.ends_on)}.
        Logged sessions and manual entries stay put; only planned rows this
        window placed get realigned back to your weekly template.
      </p>
      <div className="mt-3 rounded-lg bg-panel-2/60 border border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <WindowGlyph kind={w.kind} size={18} />
          <span className="text-small font-medium">{KIND_META[w.kind].longLabel}</span>
          <span className="text-tiny text-muted-2">· {formatRange(w.starts_on, w.ends_on)}</span>
        </div>
        {w.note && <p className="text-tiny text-muted-2 mt-1">&ldquo;{w.note}&rdquo;</p>}
      </div>
      <p className="text-tiny text-muted mt-3 leading-relaxed">
        Cancel shows up in the AI history with a one-tap rollback if you
        change your mind.
      </p>
    </Sheet>
  );
}

// =====================================================================
// UI primitives — Sheet, FieldGroup, DateInput, Chip, DetailsSection, Row, SlotPill
// =====================================================================

function Sheet({
  title,
  children,
  footer,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  footer: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 animate-fade-in"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-md max-h-[92vh] bg-panel border-t sm:border border-border sm:rounded-xl shadow-pop flex flex-col"
      >
        <div className="px-4 py-3 border-b border-border flex items-start justify-between gap-3">
          <div className="text-small font-semibold">{title}</div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-muted hover:text-white text-xl leading-none -mt-1"
          >
            ×
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">{children}</div>
        <div className="px-4 py-3 border-t border-border flex items-center gap-3">
          {footer}
        </div>
      </div>
    </div>
  );
}

function FieldGroup({
  label,
  helper,
  optional,
  children,
}: {
  label: string;
  helper?: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <label className="text-tiny text-muted uppercase tracking-wider">
          {label}
          {optional && <span className="text-muted-2 normal-case ml-1">· optional</span>}
        </label>
      </div>
      {children}
      {helper && <p className="text-tiny text-muted-2 mt-1.5 leading-relaxed">{helper}</p>}
    </div>
  );
}

function DateInput({
  value,
  onChange,
  min,
}: {
  value: string;
  onChange: (v: string) => void;
  min?: string;
}) {
  return (
    <input
      type="date"
      value={value}
      min={min}
      onChange={(e) => onChange(e.target.value)}
      className="flex-1 bg-panel-2 border border-border rounded-lg px-3 py-2 text-small"
    />
  );
}

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
    <details open={!!open} className="rounded-lg bg-panel-2/40 border border-border mt-3">
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
      <span className="w-20 text-muted-2 shrink-0">{formatShortDate(date)}</span>
      <span className="flex-1 min-w-0 truncate">{left}</span>
      <span className="text-muted shrink-0">→</span>
      <span className="flex-1 min-w-0 truncate">{right}</span>
    </div>
  );
}

function SlotPill({
  type,
  dayCode,
  source,
}: {
  type: string;
  dayCode: string | null;
  source: string;
}) {
  if (type === 'rest') {
    return <span className="text-muted-2">Rest{source === 'availability_window' ? ' · window' : ''}</span>;
  }
  if (type === 'bodyweight') {
    return <span className="text-accent">Bodyweight{source === 'availability_window' ? ' · window' : ''}</span>;
  }
  return (
    <span>
      <span className="text-muted">{type}</span>
      {dayCode && <span className="text-accent"> · {dayCode}</span>}
    </span>
  );
}

// =====================================================================
// Misc helpers
// =====================================================================

function addDaysIso(iso: string, days: number): string {
  const ms = Date.parse(iso + 'T00:00:00Z') + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}
