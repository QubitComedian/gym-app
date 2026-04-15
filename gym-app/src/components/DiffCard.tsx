'use client';
import PrescriptionView, { exName } from './PrescriptionView';
import IconGlyph from './ui/IconGlyph';
import { TYPE_LABEL } from '@/lib/session-types';

export type DiffUpdate = {
  plan_id: string;
  before?: { date: string; type: string; day_code?: string | null; prescription: any };
  patch: { prescription?: any; date?: string; type?: string; day_code?: string | null };
};

export type DiffCreate = {
  date: string;
  type: string;
  day_code?: string | null;
  prescription?: any;
};

/**
 * Single card showing a proposed change. Three shapes:
 *   - update:   before/after side-by-side
 *   - create:   one column, green accent
 *   - delete:   one column, red accent, strikethrough
 */
export function UpdateDiffCard({ u }: { u: DiffUpdate }) {
  const after = {
    date: u.patch.date ?? u.before?.date,
    type: u.patch.type ?? u.before?.type ?? 'gym',
    day_code: u.patch.day_code !== undefined ? u.patch.day_code : u.before?.day_code,
    prescription: u.patch.prescription ?? u.before?.prescription ?? {},
  };
  const before = u.before;

  return (
    <article className="rounded-xl bg-panel border border-border overflow-hidden">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-border bg-panel-2">
        <span className="text-micro uppercase tracking-wider text-warn">Modify</span>
        <span className="text-tiny text-muted">· {after.date}</span>
        <span className="ml-auto flex items-center gap-1.5">
          <IconGlyph type={after.type} size={16} />
          <span className="text-tiny">{TYPE_LABEL[after.type] ?? after.type}{after.day_code ? ` · ${after.day_code}` : ''}</span>
        </span>
      </header>
      <div className="grid grid-cols-1 sm:grid-cols-2">
        {before && (
          <div className="p-4 border-b sm:border-b-0 sm:border-r border-border opacity-70">
            <div className="text-micro uppercase tracking-wider text-muted mb-2">Before</div>
            <PrescriptionView prescription={before.prescription} dense />
          </div>
        )}
        <div className="p-4">
          <div className="text-micro uppercase tracking-wider text-accent mb-2">Proposed</div>
          <PrescriptionView prescription={after.prescription} dense />
        </div>
      </div>
    </article>
  );
}

export function CreateDiffCard({ c }: { c: DiffCreate }) {
  return (
    <article className="rounded-xl bg-panel border border-border overflow-hidden">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-border bg-panel-2">
        <span className="text-micro uppercase tracking-wider text-ok">Add</span>
        <span className="text-tiny text-muted">· {c.date}</span>
        <span className="ml-auto flex items-center gap-1.5">
          <IconGlyph type={c.type} size={16} />
          <span className="text-tiny">{TYPE_LABEL[c.type] ?? c.type}{c.day_code ? ` · ${c.day_code}` : ''}</span>
        </span>
      </header>
      <div className="p-4 border-l-2 border-ok/50">
        <PrescriptionView prescription={c.prescription} dense />
      </div>
    </article>
  );
}

export function DeleteDiffCard({ plan }: { plan: { id: string; date: string; type: string; day_code?: string | null; prescription?: any } }) {
  return (
    <article className="rounded-xl bg-panel border border-border overflow-hidden">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-border bg-panel-2">
        <span className="text-micro uppercase tracking-wider text-danger">Remove</span>
        <span className="text-tiny text-muted">· {plan.date}</span>
        <span className="ml-auto flex items-center gap-1.5 opacity-70">
          <IconGlyph type={plan.type} size={16} />
          <span className="text-tiny line-through">{TYPE_LABEL[plan.type] ?? plan.type}{plan.day_code ? ` · ${plan.day_code}` : ''}</span>
        </span>
      </header>
      <div className="p-4 border-l-2 border-danger/50 opacity-60">
        <PrescriptionView prescription={plan.prescription} dense />
      </div>
    </article>
  );
}

export { exName };
