'use client';
/**
 * Shared primitives for non-gym log forms: Pills, Stepper, SectionCard.
 */
import { ReactNode } from 'react';

/* ──────────── Pills ──────────── */

export function Pill<T extends string>({
  id, label, selected, onClick, disabled,
}: {
  id: T; label: string; selected?: boolean; onClick?: (id: T) => void; disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onClick?.(id)}
      disabled={disabled}
      className={`px-3 py-1.5 rounded-full text-tiny border transition-colors ${
        selected
          ? 'bg-accent text-black border-accent font-medium'
          : 'bg-panel-2 border-border hover:border-muted text-muted-2'
      } disabled:opacity-40`}
    >
      {label}
    </button>
  );
}

export function Pills<T extends string>({
  options, value, onChange, multi,
}: {
  options: { id: T; label: string }[];
  value?: T | T[] | null;
  onChange?: (v: T | T[] | null) => void;
  multi?: boolean;
}) {
  const isSel = (id: T) =>
    multi ? Array.isArray(value) && value.includes(id) : value === id;
  const handle = (id: T) => {
    if (multi) {
      const arr = Array.isArray(value) ? [...value] : [];
      const i = arr.indexOf(id);
      if (i >= 0) arr.splice(i, 1); else arr.push(id);
      onChange?.(arr.length ? arr : null);
    } else {
      onChange?.(value === id ? null : id);
    }
  };
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(o => (
        <Pill key={o.id} id={o.id} label={o.label} selected={isSel(o.id)} onClick={handle} />
      ))}
    </div>
  );
}

/* ──────────── Stepper ──────────── */

export function Stepper({
  value, onChange, step = 1, min, max, unit, placeholder, width = 'w-16', onFocus, className,
}: {
  value?: number | string | null;
  onChange: (v: string) => void;
  step?: number; min?: number; max?: number;
  unit?: string; placeholder?: string; width?: string;
  onFocus?: () => void;
  className?: string;
}) {
  const cur = value == null || value === '' ? NaN : Number(value);
  const precision = step < 1 ? (String(step).split('.')[1]?.length ?? 1) : 0;
  const nudge = (d: number) => {
    const base = isNaN(cur) ? 0 : cur;
    let next = base + d;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    onChange(next.toFixed(precision));
  };
  return (
    <div className={`inline-flex items-center bg-panel-2 border border-border rounded ${className ?? ''}`}>
      <button type="button" onClick={() => nudge(-step)} aria-label="decrement"
        className="px-2 py-1.5 text-muted hover:text-white text-sm leading-none">−</button>
      <input
        type="number" inputMode="decimal" step={step} placeholder={placeholder}
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        onFocus={onFocus}
        className={`${width} bg-transparent text-center py-1.5 focus:outline-none tabular-nums`}
      />
      <button type="button" onClick={() => nudge(step)} aria-label="increment"
        className="px-2 py-1.5 text-muted hover:text-white text-sm leading-none">+</button>
      {unit && <span className="text-tiny text-muted pr-2 pl-0.5">{unit}</span>}
    </div>
  );
}

/* ──────────── SectionCard ──────────── */

export function SectionCard({ title, subtitle, action, children }: {
  title?: string; subtitle?: string; action?: ReactNode; children: ReactNode;
}) {
  return (
    <div className="rounded-xl bg-panel border border-border p-3">
      {(title || action) && (
        <div className="flex items-baseline justify-between mb-2">
          <div>
            {title && <div className="text-tiny font-semibold uppercase tracking-wider text-muted">{title}</div>}
            {subtitle && <div className="text-tiny text-muted-2">{subtitle}</div>}
          </div>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

/* ──────────── Field (label + control) ──────────── */

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className="text-small">{label}</div>
        {hint && <div className="text-tiny text-muted">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/* ──────────── LogAsPlannedPill ──────────── */

export function LogAsPlannedPill({
  summary, onClick, disabled,
}: { summary: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full rounded-xl border border-accent/30 bg-accent/10 hover:bg-accent/15 px-4 py-3 text-left disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <div className="flex items-center gap-2">
        <span className="w-5 h-5 rounded-full bg-accent text-black flex items-center justify-center text-[11px] font-bold shrink-0">✓</span>
        <div className="min-w-0">
          <div className="text-small font-medium text-accent">Log as planned</div>
          <div className="text-tiny text-muted-2 truncate">{summary}</div>
        </div>
      </div>
    </button>
  );
}
