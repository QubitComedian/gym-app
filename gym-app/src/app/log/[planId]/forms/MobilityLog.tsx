'use client';
import { useMemo } from 'react';
import { Stepper, SectionCard, Field, LogAsPlannedPill } from './shared';
import { normalizeMobility, summarizeMobility } from './helpers';

export type MobilityRoutineRow = {
  exercise: string;
  duration_s?: number;
  reps?: string;
  done: boolean;
};

export type MobilityPayload = {
  duration_min?: number;
  focus?: string;
  routine_completed?: MobilityRoutineRow[];
};

export function mobilityDefaults(plan: any): MobilityPayload {
  const n = normalizeMobility(plan.prescription?.mobility);
  return {
    duration_min: n.duration_min,
    focus: n.focus,
    routine_completed: n.routine.map(r => ({
      exercise: r.exercise,
      duration_s: r.duration_s,
      reps: r.reps,
      done: false,
    })),
  };
}

export default function MobilityLog({
  plan, value, onChange, onTouchStart,
}: {
  plan: any;
  value: MobilityPayload;
  onChange: (v: MobilityPayload) => void;
  onTouchStart?: () => void;
}) {
  const m = plan.prescription?.mobility;
  const normalized = useMemo(() => normalizeMobility(m), [m]);
  const summary = summarizeMobility(m);
  const canLogAsPlanned = !!m && (normalized.duration_min || normalized.routine.length);

  const routine = value.routine_completed ?? [];
  const doneCount = routine.filter(r => r.done).length;

  const markAll = (done: boolean) => {
    onTouchStart?.();
    onChange({ ...value, routine_completed: routine.map(r => ({ ...r, done })) });
  };

  const toggle = (idx: number) => {
    onTouchStart?.();
    onChange({
      ...value,
      routine_completed: routine.map((r, i) => i === idx ? { ...r, done: !r.done } : r),
    });
  };

  return (
    <div className="space-y-3">
      {canLogAsPlanned && (
        <LogAsPlannedPill
          summary={summary}
          onClick={() => { onTouchStart?.(); onChange(mobilityDefaults(plan)); markAll(true); }}
        />
      )}

      {routine.length > 0 ? (
        <SectionCard title="Routine" subtitle={`${doneCount} / ${routine.length} complete`}
          action={
            <button type="button" onClick={() => markAll(doneCount !== routine.length)}
              className="text-tiny text-accent hover:underline">
              {doneCount === routine.length ? 'Uncheck all' : 'Check all'}
            </button>
          }>
          <ul className="space-y-1">
            {routine.map((r, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => toggle(i)}
                  className={`w-full flex items-center gap-2 py-2 px-2 -mx-2 rounded-lg text-left transition-colors ${
                    r.done ? 'bg-accent/10' : 'hover:bg-panel-2'
                  }`}
                >
                  <span className={`w-6 h-6 rounded-full border-2 shrink-0 flex items-center justify-center ${
                    r.done ? 'bg-accent border-accent text-black' : 'border-muted/50 text-transparent'
                  }`}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="5 12 10 17 19 7" />
                    </svg>
                  </span>
                  <span className="flex-1 text-small min-w-0">
                    <span className={`${r.done ? 'text-muted-2 line-through' : ''}`}>{r.exercise}</span>
                  </span>
                  <span className="text-tiny text-muted tabular-nums shrink-0">
                    {r.duration_s ? `${r.duration_s}s` : r.reps ?? ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : (
        <SectionCard title="Session">
          <div className="text-tiny text-muted italic py-2">No routine prescribed — log duration and focus below.</div>
        </SectionCard>
      )}

      <SectionCard title="Details">
        <Field label="Total duration">
          <Stepper value={value.duration_min} step={5} min={0}
            onChange={v => { onTouchStart?.(); onChange({ ...value, duration_min: v ? Number(v) : undefined }); }}
            onFocus={onTouchStart} unit="min" width="w-12" />
        </Field>
        <Field label="Focus">
          <input
            type="text"
            placeholder="hips · hamstrings · …"
            value={value.focus ?? ''}
            onChange={e => onChange({ ...value, focus: e.target.value || undefined })}
            onFocus={onTouchStart}
            className="w-40 bg-panel-2 border border-border rounded px-2 py-1.5 text-small"
          />
        </Field>
      </SectionCard>
    </div>
  );
}
