'use client';
import { useState } from 'react';
import { Stepper, SectionCard, Field, LogAsPlannedPill } from './shared';
import { summarizeSaunaCold } from './helpers';

export type SaunaColdPayload = {
  rounds?: number;
  sauna_min_per_round?: number;
  cold_min_per_round?: number;
  sauna_temp_c?: number;
  cold_temp_c?: number;
};

export function saunaColdDefaults(plan: any): SaunaColdPayload {
  const s = plan.prescription?.sauna_cold ?? {};
  return {
    rounds: s.rounds,
    sauna_min_per_round: s.sauna_min_per_round,
    cold_min_per_round: s.cold_min_per_round,
  };
}

export default function SaunaColdLog({
  plan, value, onChange, onTouchStart,
}: {
  plan: any;
  value: SaunaColdPayload;
  onChange: (v: SaunaColdPayload) => void;
  onTouchStart?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const set = <K extends keyof SaunaColdPayload>(k: K, v: SaunaColdPayload[K]) =>
    onChange({ ...value, [k]: v });
  const s = plan.prescription?.sauna_cold;
  const summary = summarizeSaunaCold(s);
  const canLogAsPlanned = !!s && (s.rounds || s.sauna_min_per_round);

  return (
    <div className="space-y-3">
      {canLogAsPlanned && (
        <LogAsPlannedPill
          summary={summary}
          onClick={() => { onTouchStart?.(); onChange({ ...saunaColdDefaults(plan) }); }}
        />
      )}

      <SectionCard title="Session">
        <Field label="Rounds completed">
          <Stepper value={value.rounds} step={1} min={0}
            onChange={v => { onTouchStart?.(); set('rounds', v ? Number(v) : undefined); }}
            onFocus={onTouchStart} width="w-10" />
        </Field>
        <Field label="Sauna / round">
          <Stepper value={value.sauna_min_per_round} step={1} min={0}
            onChange={v => { onTouchStart?.(); set('sauna_min_per_round', v ? Number(v) : undefined); }}
            onFocus={onTouchStart} unit="min" width="w-12" />
        </Field>
        <Field label="Cold / round">
          <Stepper value={value.cold_min_per_round} step={0.5} min={0}
            onChange={v => { onTouchStart?.(); set('cold_min_per_round', v ? Number(v) : undefined); }}
            onFocus={onTouchStart} unit="min" width="w-12" />
        </Field>

        <button type="button" onClick={() => setExpanded(x => !x)}
          className="mt-2 text-tiny text-muted hover:text-white">
          {expanded ? 'Hide temperatures' : '+ Temperatures'}
        </button>

        {expanded && (
          <div className="mt-2 pt-2 border-t border-border space-y-0">
            <Field label="Sauna temp" hint="optional">
              <Stepper value={value.sauna_temp_c} step={5} min={0} max={120}
                onChange={v => set('sauna_temp_c', v ? Number(v) : undefined)}
                onFocus={onTouchStart} unit="°C" width="w-12" />
            </Field>
            <Field label="Cold temp" hint="optional">
              <Stepper value={value.cold_temp_c} step={1} min={0} max={30}
                onChange={v => set('cold_temp_c', v ? Number(v) : undefined)}
                onFocus={onTouchStart} unit="°C" width="w-12" />
            </Field>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
