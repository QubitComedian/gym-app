'use client';
import { useEffect, useMemo } from 'react';
import { Pills, Stepper, SectionCard, Field, LogAsPlannedPill } from './shared';
import { derivePace, summarizeCardio } from './helpers';

export type CardioType = 'run' | 'bike' | 'swim';

export type IntervalRow = { planned: string; done: boolean };

export type CardioPayload = {
  distance_km?: number;   // run / bike
  distance_m?: number;    // swim
  duration_min?: number;
  pace?: string;          // "5:30/km" or "1:45/100m"
  pace_override?: boolean;
  rpe?: number;
  avg_power_w?: number;   // bike
  stroke?: string;        // swim
  intervals_completed?: IntervalRow[];
  zone?: string;          // bike zones Z1-Z5
};

const STROKES = [
  { id: 'freestyle', label: 'Freestyle' },
  { id: 'breast', label: 'Breast' },
  { id: 'back', label: 'Back' },
  { id: 'fly', label: 'Fly' },
  { id: 'mixed', label: 'Mixed' },
];

const ZONES = [
  { id: 'z1', label: 'Z1' },
  { id: 'z2', label: 'Z2' },
  { id: 'z3', label: 'Z3' },
  { id: 'z4', label: 'Z4' },
  { id: 'z5', label: 'Z5' },
];

export function cardioDefaults(type: CardioType, plan: any): CardioPayload {
  const block = plan.prescription?.[type] ?? {};
  const intervals = Array.isArray(plan.prescription?.intervals)
    ? plan.prescription.intervals.map((iv: any) => ({
        planned: typeof iv === 'string' ? iv : iv.label ?? JSON.stringify(iv),
        done: false,
      }))
    : undefined;
  if (type === 'swim') {
    return {
      distance_m: block.distance_m,
      duration_min: block.duration_min,
      stroke: block.stroke,
      intervals_completed: intervals,
    };
  }
  return {
    distance_km: block.km ?? block.distance_km,
    duration_min: block.duration_min,
    zone: type === 'bike' ? block.zone : undefined,
    intervals_completed: type === 'run' ? intervals : undefined,
  };
}

export default function CardioLog({
  type, plan, value, onChange, onTouchStart,
}: {
  type: CardioType;
  plan: any;
  value: CardioPayload;
  onChange: (v: CardioPayload) => void;
  onTouchStart?: () => void;
}) {
  const set = <K extends keyof CardioPayload>(k: K, v: CardioPayload[K]) =>
    onChange({ ...value, [k]: v });

  const prescriptionBlock = plan.prescription?.[type];
  const summary = summarizeCardio(type, plan.prescription);
  const canLogAsPlanned = !!prescriptionBlock;

  // Auto-derive pace unless user has set an override
  const derived = useMemo(() => {
    if (type === 'swim') {
      return derivePace('swim', value.distance_m, value.duration_min);
    }
    return derivePace(type, value.distance_km, value.duration_min);
  }, [type, value.distance_km, value.distance_m, value.duration_min]);

  useEffect(() => {
    if (value.pace_override) return;
    if (derived && derived !== value.pace) {
      onChange({ ...value, pace: derived });
    }
    if (!derived && value.pace) {
      onChange({ ...value, pace: undefined });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derived]);

  const toggleInterval = (i: number) => {
    onTouchStart?.();
    set('intervals_completed', (value.intervals_completed ?? []).map((iv, idx) =>
      idx === i ? { ...iv, done: !iv.done } : iv
    ));
  };

  return (
    <div className="space-y-3">
      {canLogAsPlanned && (
        <LogAsPlannedPill
          summary={summary}
          onClick={() => { onTouchStart?.(); onChange(cardioDefaults(type, plan)); }}
        />
      )}

      <SectionCard title="Session">
        {type === 'swim' ? (
          <Field label="Distance">
            <Stepper value={value.distance_m} step={50} min={0}
              onChange={v => { onTouchStart?.(); set('distance_m', v ? Number(v) : undefined); }}
              onFocus={onTouchStart} unit="m" width="w-16" />
          </Field>
        ) : (
          <Field label="Distance">
            <Stepper value={value.distance_km} step={0.5} min={0}
              onChange={v => { onTouchStart?.(); set('distance_km', v ? Number(v) : undefined); }}
              onFocus={onTouchStart} unit="km" width="w-14" />
          </Field>
        )}
        <Field label="Duration">
          <Stepper value={value.duration_min} step={5} min={0}
            onChange={v => { onTouchStart?.(); set('duration_min', v ? Number(v) : undefined); }}
            onFocus={onTouchStart} unit="min" width="w-14" />
        </Field>
        <Field
          label="Pace"
          hint={value.pace_override ? 'manual' : derived ? 'auto from distance + duration' : 'enter distance + duration'}
        >
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={value.pace ?? ''}
              onFocus={onTouchStart}
              onChange={e => {
                onTouchStart?.();
                onChange({ ...value, pace: e.target.value || undefined, pace_override: true });
              }}
              placeholder={type === 'swim' ? '1:45/100m' : '5:30/km'}
              className="w-24 bg-panel-2 border border-border rounded px-2 py-1.5 text-small tabular-nums text-center"
            />
            {value.pace_override && (
              <button
                type="button"
                onClick={() => onChange({ ...value, pace_override: false, pace: derived || undefined })}
                className="text-tiny text-accent hover:underline"
              >
                auto
              </button>
            )}
          </div>
        </Field>
      </SectionCard>

      <SectionCard title="Effort">
        <Field label="RPE" hint="1 easy – 10 max">
          <Stepper value={value.rpe} step={1} min={1} max={10}
            onChange={v => { onTouchStart?.(); set('rpe', v ? Number(v) : undefined); }}
            onFocus={onTouchStart} width="w-10" />
        </Field>
        {type === 'bike' && (
          <>
            <Field label="Avg power" hint="optional">
              <Stepper value={value.avg_power_w} step={5} min={0}
                onChange={v => set('avg_power_w', v ? Number(v) : undefined)}
                onFocus={onTouchStart} unit="W" width="w-14" />
            </Field>
            <div className="pt-2">
              <div className="text-tiny text-muted mb-1.5">Zone</div>
              <Pills options={ZONES} value={value.zone as any ?? null}
                onChange={v => { onTouchStart?.(); set('zone', (v as string) ?? undefined); }} />
            </div>
          </>
        )}
        {type === 'swim' && (
          <div className="pt-2">
            <div className="text-tiny text-muted mb-1.5">Stroke</div>
            <Pills options={STROKES} value={value.stroke as any ?? null}
              onChange={v => { onTouchStart?.(); set('stroke', (v as string) ?? undefined); }} />
          </div>
        )}
      </SectionCard>

      {value.intervals_completed && value.intervals_completed.length > 0 && (
        <SectionCard
          title="Intervals"
          subtitle={`${value.intervals_completed.filter(i => i.done).length} / ${value.intervals_completed.length} complete`}
        >
          <ul className="space-y-1">
            {value.intervals_completed.map((iv, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => toggleInterval(i)}
                  className={`w-full flex items-center gap-2 py-2 px-2 -mx-2 rounded-lg text-left transition-colors ${
                    iv.done ? 'bg-accent/10' : 'hover:bg-panel-2'
                  }`}
                >
                  <span className={`w-6 h-6 rounded-full border-2 shrink-0 flex items-center justify-center ${
                    iv.done ? 'bg-accent border-accent text-black' : 'border-muted/50 text-transparent'
                  }`}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="5 12 10 17 19 7" />
                    </svg>
                  </span>
                  <span className={`flex-1 text-small min-w-0 ${iv.done ? 'text-muted-2 line-through' : ''}`}>
                    {iv.planned}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
    </div>
  );
}
