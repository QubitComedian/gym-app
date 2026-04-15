'use client';
import { useEffect, useMemo, useState } from 'react';
import { Pills, Stepper, SectionCard, Field, LogAsPlannedPill } from './shared';
import {
  detectGradeScale,
  gradesForScale,
  hardestSendOf,
  summarizeClimb,
  type GradeScale,
  type Tick,
} from './helpers';

export type ClimbPayload = {
  session_type?: 'bouldering' | 'sport' | 'top_rope' | 'trad' | 'gym';
  duration_min?: number;
  grade_scale?: GradeScale;
  ticks?: Tick[];
  hardest_send?: string;
};

const SESSION_TYPES = [
  { id: 'bouldering', label: 'Bouldering' },
  { id: 'sport', label: 'Sport' },
  { id: 'top_rope', label: 'Top rope' },
  { id: 'trad', label: 'Trad' },
  { id: 'gym', label: 'Gym' },
];

export function climbDefaults(plan: any): ClimbPayload {
  const c = plan.prescription?.climbing ?? plan.prescription?.climb ?? {};
  const scale = detectGradeScale(c.grade_target);
  const targetGrade = c.grade_target;
  const ticks: Tick[] = targetGrade
    ? [{ grade: targetGrade, sent: 0, flashed: 0, worked: 0 }]
    : [];
  return {
    session_type: normalizeSession(c.style ?? c.session_type),
    duration_min: c.duration_min,
    grade_scale: scale,
    ticks,
  };
}

function normalizeSession(s?: string): ClimbPayload['session_type'] {
  if (!s) return undefined;
  const lower = s.toLowerCase().replace(/[- ]/g, '_');
  const valid = ['bouldering', 'sport', 'top_rope', 'trad', 'gym'];
  return valid.includes(lower) ? (lower as ClimbPayload['session_type']) : undefined;
}

export default function ClimbLog({
  plan, value, onChange, onTouchStart,
}: {
  plan: any;
  value: ClimbPayload;
  onChange: (v: ClimbPayload) => void;
  onTouchStart?: () => void;
}) {
  const set = <K extends keyof ClimbPayload>(k: K, v: ClimbPayload[K]) =>
    onChange({ ...value, [k]: v });

  const c = plan.prescription?.climbing ?? plan.prescription?.climb;
  const summary = summarizeClimb(c);
  const canLogAsPlanned = !!c;

  const scale: GradeScale = value.grade_scale ?? 'v';
  const allGrades = gradesForScale(scale);
  const ticks = value.ticks ?? [];

  const hardest = useMemo(() => hardestSendOf(ticks, scale), [ticks, scale]);
  const [addingGrade, setAddingGrade] = useState(false);

  // Keep hardest_send field in sync
  useEffect(() => {
    if (hardest !== (value.hardest_send ?? null)) {
      onChange({ ...value, hardest_send: hardest ?? undefined });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hardest]);

  const updateTick = (i: number, patch: Partial<Tick>) => {
    onTouchStart?.();
    set('ticks', ticks.map((t, idx) => idx === i ? { ...t, ...patch } : t));
  };
  const removeTick = (i: number) => {
    set('ticks', ticks.filter((_, idx) => idx !== i));
  };
  const addGrade = (grade: string) => {
    onTouchStart?.();
    if (ticks.some(t => t.grade === grade)) { setAddingGrade(false); return; }
    set('ticks', [...ticks, { grade, sent: 0, flashed: 0, worked: 0 }]);
    setAddingGrade(false);
  };

  const totalSends = ticks.reduce((s, t) => s + (t.sent || 0) + (t.flashed || 0), 0);

  return (
    <div className="space-y-3">
      {canLogAsPlanned && (
        <LogAsPlannedPill
          summary={summary}
          onClick={() => { onTouchStart?.(); onChange(climbDefaults(plan)); }}
        />
      )}

      <SectionCard title="Session">
        <div className="pt-1">
          <div className="text-tiny text-muted mb-1.5">Type</div>
          <Pills options={SESSION_TYPES} value={value.session_type ?? null}
            onChange={v => { onTouchStart?.(); set('session_type', (v as any) ?? undefined); }} />
        </div>
        <Field label="Duration">
          <Stepper value={value.duration_min} step={10} min={0}
            onChange={v => { onTouchStart?.(); set('duration_min', v ? Number(v) : undefined); }}
            onFocus={onTouchStart} unit="min" width="w-14" />
        </Field>
        <Field label="Grade scale">
          <div className="flex gap-1">
            <button type="button"
              onClick={() => { onTouchStart?.(); set('grade_scale', 'v'); }}
              className={`px-3 py-1 rounded text-tiny border ${scale === 'v' ? 'bg-accent text-black border-accent' : 'bg-panel-2 border-border text-muted-2'}`}>
              V
            </button>
            <button type="button"
              onClick={() => { onTouchStart?.(); set('grade_scale', 'french'); }}
              className={`px-3 py-1 rounded text-tiny border ${scale === 'french' ? 'bg-accent text-black border-accent' : 'bg-panel-2 border-border text-muted-2'}`}>
              French
            </button>
          </div>
        </Field>
      </SectionCard>

      <SectionCard
        title="Ticks"
        subtitle={
          ticks.length === 0
            ? 'Add grades you climbed'
            : `${totalSends} send${totalSends === 1 ? '' : 's'}${hardest ? ` · hardest ${hardest}` : ''}`
        }
        action={
          !addingGrade ? (
            <button type="button" onClick={() => setAddingGrade(true)}
              className="text-tiny text-accent hover:underline">+ grade</button>
          ) : (
            <button type="button" onClick={() => setAddingGrade(false)}
              className="text-tiny text-muted hover:underline">cancel</button>
          )
        }
      >
        {addingGrade && (
          <div className="mb-2 rounded-lg border border-border bg-panel-2 p-2">
            <div className="text-tiny text-muted mb-1.5">Pick a grade</div>
            <div className="flex flex-wrap gap-1">
              {allGrades.map(g => (
                <button key={g} type="button" onClick={() => addGrade(g)}
                  disabled={ticks.some(t => t.grade === g)}
                  className="px-2 py-1 rounded text-tiny border border-border bg-panel hover:border-accent disabled:opacity-40 disabled:cursor-not-allowed tabular-nums">
                  {g}
                </button>
              ))}
            </div>
          </div>
        )}

        {ticks.length === 0 && !addingGrade && (
          <div className="text-tiny text-muted italic py-2">No ticks yet — tap "+ grade" to start.</div>
        )}

        <div className="space-y-1.5">
          {ticks.map((t, i) => (
            <div key={t.grade + i} className="rounded-lg border border-border bg-panel-2 p-2">
              <div className="flex items-center justify-between mb-1.5">
                <div className="font-mono font-semibold tabular-nums">{t.grade}</div>
                <button type="button" onClick={() => removeTick(i)}
                  className="text-muted-2 hover:text-danger text-xs">remove</button>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <TickStepper label="Sent" value={t.sent} onChange={v => updateTick(i, { sent: v })} onFocus={onTouchStart} />
                <TickStepper label="Flash" value={t.flashed} onChange={v => updateTick(i, { flashed: v })} onFocus={onTouchStart} />
                <TickStepper label="Worked" value={t.worked} onChange={v => updateTick(i, { worked: v })} onFocus={onTouchStart} />
              </div>
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}

function TickStepper({
  label, value, onChange, onFocus,
}: { label: string; value: number; onChange: (v: number) => void; onFocus?: () => void }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted mb-1">{label}</div>
      <Stepper value={value || ''} step={1} min={0}
        onChange={v => onChange(v ? Number(v) : 0)}
        onFocus={onFocus}
        width="w-10"
      />
    </div>
  );
}
