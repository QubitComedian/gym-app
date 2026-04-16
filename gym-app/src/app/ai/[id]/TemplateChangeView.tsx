/**
 * Renderer for `ai_proposals.kind='template_change'` entries (P1.1 / PR-G).
 *
 * This is the "history + review" view the user lands on after applying a
 * weekly-template edit. The proposal row is always stored with
 * status='applied', so there are no Apply/Reject actions — the value here
 * is transparency (what did I change, when, and what landed) and the
 * foundation for a future undo (P1.2 / PR-H).
 *
 * Shape of `diff` (written by apply.ts):
 *   {
 *     phase_id, before, after, window,
 *     updates, creates, deletes, summary,
 *     applied_counts, skipped_counts,
 *     template_version,
 *   }
 */
'use client';

import { format } from 'date-fns';

type Slot = { type: string; day_code: string | null };
type Pattern = Partial<Record<'SU' | 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA', Slot>>;
type Dow = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';
const DOW_ORDER: Dow[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const DOW_LABEL: Record<Dow, string> = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' };

type Diff = {
  phase_id?: string;
  before?: Pattern;
  after?: Pattern;
  window?: { start: string; end: string };
  updates?: Array<{ plan_id: string; date: string; before: Slot; after: Slot }>;
  creates?: Array<{ date: string; type: string; day_code: string | null; is_orphan: boolean }>;
  deletes?: Array<{ plan_id: string; date: string; before: Slot }>;
  summary?: {
    added: number;
    removed: number;
    changed: number;
    skipped_ai_proposed: number;
    orphan_day_codes: Array<{ date: string; day_code: string }>;
  };
  applied_counts?: { updates: number; creates: number; deletes: number };
  skipped_counts?: { updates_drifted: number; deletes_not_planned: number };
  template_version?: number;
};

export default function TemplateChangeView({
  proposal,
}: {
  proposal: {
    id: string;
    status: string;
    triggered_by: string;
    created_at: string;
    applied_at: string | null;
    rationale: string | null;
    diff: Diff;
  };
}) {
  const { diff } = proposal;
  const summary = diff.summary ?? { added: 0, removed: 0, changed: 0, skipped_ai_proposed: 0, orphan_day_codes: [] };
  const applied = diff.applied_counts ?? { updates: 0, creates: 0, deletes: 0 };
  const skipped = diff.skipped_counts ?? { updates_drifted: 0, deletes_not_planned: 0 };
  const totalApplied = applied.updates + applied.creates + applied.deletes;
  const totalSkipped = skipped.updates_drifted + skipped.deletes_not_planned;
  const appliedAt = proposal.applied_at ?? proposal.created_at;

  return (
    <section>
      <header className="mt-2 mb-4">
        <div className="text-tiny text-muted uppercase tracking-wider mb-1 flex items-center gap-2">
          <span aria-hidden>🗓</span>
          <span>Template edit</span>
        </div>
        <h1 className="text-2xl font-bold tracking-tight leading-snug">
          {summary.added + summary.changed + summary.removed === 0
            ? 'Weekly shape saved'
            : 'Weekly shape updated'}
        </h1>
        {proposal.rationale && (
          <p className="text-small text-muted-2 mt-2 whitespace-pre-line">{proposal.rationale}</p>
        )}
        <p className="text-tiny text-muted mt-2">
          Applied {format(new Date(appliedAt), 'MMM d, yyyy · p')}
          {diff.template_version !== undefined && ` · v${diff.template_version}`}
        </p>
      </header>

      {/* Before / after side by side */}
      <div className="rounded-xl bg-panel border border-border p-4 mb-4">
        <div className="text-tiny text-muted uppercase tracking-wider mb-3">Pattern</div>
        <PatternCompare before={diff.before ?? {}} after={diff.after ?? {}} />
      </div>

      {/* Applied / skipped counts */}
      <div className="rounded-xl bg-panel border border-border p-4 mb-4">
        <div className="text-tiny text-muted uppercase tracking-wider mb-2">What landed</div>
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Added" value={applied.creates} />
          <Stat label="Changed" value={applied.updates} />
          <Stat label="Removed" value={applied.deletes} />
        </div>
        {totalSkipped > 0 && (
          <p className="text-tiny text-muted-2 mt-3 leading-relaxed">
            {skipped.updates_drifted > 0 && (
              <>
                {skipped.updates_drifted} session{skipped.updates_drifted === 1 ? '' : 's'} drifted from the preview
                (logged or edited between preview and apply){' '}
              </>
            )}
            {skipped.deletes_not_planned > 0 && (
              <>
                · {skipped.deletes_not_planned} session{skipped.deletes_not_planned === 1 ? '' : 's'} were already past planned state
              </>
            )}
          </p>
        )}
        {summary.skipped_ai_proposed > 0 && (
          <p className="text-tiny text-muted-2 mt-2">
            {summary.skipped_ai_proposed} AI-proposed session{summary.skipped_ai_proposed === 1 ? '' : 's'} preserved.
          </p>
        )}
        {totalApplied === 0 && totalSkipped === 0 && (
          <p className="text-tiny text-muted-2 mt-2">No plan rows required adjustment.</p>
        )}
      </div>

      {/* Detail: added / changed / removed session lists */}
      {(diff.creates?.length || diff.updates?.length || diff.deletes?.length) && (
        <div className="rounded-xl bg-panel border border-border p-4 mb-4">
          <div className="text-tiny text-muted uppercase tracking-wider mb-2">Affected sessions</div>
          {(diff.creates ?? []).length > 0 && (
            <DetailBlock title={`Added (${diff.creates!.length})`}>
              {diff.creates!.map((c, i) => (
                <Line key={i} date={c.date} before="—" after={slotText({ type: c.type, day_code: c.day_code })} />
              ))}
            </DetailBlock>
          )}
          {(diff.updates ?? []).length > 0 && (
            <DetailBlock title={`Changed (${diff.updates!.length})`}>
              {diff.updates!.map((u) => (
                <Line
                  key={u.plan_id}
                  date={u.date}
                  before={slotText(u.before)}
                  after={slotText(u.after)}
                />
              ))}
            </DetailBlock>
          )}
          {(diff.deletes ?? []).length > 0 && (
            <DetailBlock title={`Removed (${diff.deletes!.length})`}>
              {diff.deletes!.map((d) => (
                <Line key={d.plan_id} date={d.date} before={slotText(d.before)} after="—" />
              ))}
            </DetailBlock>
          )}
        </div>
      )}

      {diff.window && (
        <p className="text-tiny text-muted text-center">
          Scope: {diff.window.start} → {diff.window.end}
        </p>
      )}
    </section>
  );
}

function PatternCompare({ before, after }: { before: Pattern; after: Pattern }) {
  return (
    <ul className="space-y-1.5">
      {DOW_ORDER.map((dow) => {
        const b = before[dow];
        const a = after[dow];
        const changed = !slotEqual(b, a);
        return (
          <li
            key={dow}
            className={`flex items-center gap-2 text-small px-2 py-1.5 rounded-md ${changed ? 'bg-accent-soft/60 border border-accent/30' : ''}`}
          >
            <span className="w-10 text-muted-2 shrink-0">{DOW_LABEL[dow]}</span>
            <span className="flex-1 min-w-0 truncate text-muted-2">{slotText(b)}</span>
            <span className="text-muted shrink-0">→</span>
            <span className={`flex-1 min-w-0 truncate ${changed ? 'text-accent font-medium' : 'text-muted-2'}`}>
              {slotText(a)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function slotEqual(a: Slot | undefined, b: Slot | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.type === b.type && (a.day_code ?? null) === (b.day_code ?? null);
}

function slotText(s: Slot | undefined | null): string {
  if (!s) return '—';
  if (s.type === 'rest') return 'Rest';
  return s.day_code ? `${s.type} · ${s.day_code}` : s.type;
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-panel-2 border border-border px-3 py-2 text-center">
      <div className="text-lg font-semibold">{value}</div>
      <div className="text-tiny text-muted-2">{label}</div>
    </div>
  );
}

function DetailBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="border-t border-border pt-2 mt-2 first:border-t-0 first:pt-0 first:mt-0">
      <summary className="text-small font-medium cursor-pointer">{title}</summary>
      <div className="mt-2 space-y-1">{children}</div>
    </details>
  );
}

function Line({ date, before, after }: { date: string; before: string; after: string }) {
  return (
    <div className="flex items-center gap-2 text-tiny">
      <span className="w-20 text-muted-2 shrink-0">{formatShort(date)}</span>
      <span className="flex-1 min-w-0 truncate text-muted-2">{before}</span>
      <span className="text-muted shrink-0">→</span>
      <span className="flex-1 min-w-0 truncate">{after}</span>
    </div>
  );
}

function formatShort(iso: string): string {
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  return `${Number(m)}/${Number(d)}`;
}
