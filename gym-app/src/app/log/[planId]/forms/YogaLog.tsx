'use client';
import { Pills, Stepper, SectionCard, Field, LogAsPlannedPill } from './shared';
import { summarizeYoga } from './helpers';

export type YogaPayload = {
  duration_min?: number;
  style?: string;
  focus?: string[];
  intensity?: 'gentle' | 'moderate' | 'strong';
};

const STYLES = [
  { id: 'hatha', label: 'Hatha' },
  { id: 'vinyasa', label: 'Vinyasa' },
  { id: 'yin', label: 'Yin' },
  { id: 'restorative', label: 'Restorative' },
  { id: 'power', label: 'Power' },
  { id: 'other', label: 'Other' },
];

const FOCUS = [
  { id: 'hips', label: 'Hips' },
  { id: 'hamstrings', label: 'Hamstrings' },
  { id: 'shoulders', label: 'Shoulders' },
  { id: 'back', label: 'Back' },
  { id: 'core', label: 'Core' },
  { id: 'full_body', label: 'Full body' },
  { id: 'mobility', label: 'Mobility' },
];

const INTENSITIES = [
  { id: 'gentle', label: 'Gentle' },
  { id: 'moderate', label: 'Moderate' },
  { id: 'strong', label: 'Strong' },
];

export function yogaDefaults(plan: any): YogaPayload {
  const y = plan.prescription?.yoga ?? {};
  const focusStr: string | undefined = y.focus;
  const inferredFocus = focusStr
    ? FOCUS.filter(f => focusStr.toLowerCase().includes(f.id.replace('_', ' ')) || focusStr.toLowerCase().includes(f.label.toLowerCase())).map(f => f.id)
    : [];
  return {
    duration_min: y.duration_min,
    style: normalizeStyle(y.style),
    focus: inferredFocus.length ? inferredFocus : undefined,
  };
}

function normalizeStyle(s?: string): string | undefined {
  if (!s) return undefined;
  const lower = s.toLowerCase();
  const match = STYLES.find(x => x.id === lower || x.label.toLowerCase() === lower);
  return match?.id ?? 'other';
}

export default function YogaLog({
  plan, value, onChange, onTouchStart,
}: {
  plan: any;
  value: YogaPayload;
  onChange: (v: YogaPayload) => void;
  onTouchStart?: () => void;
}) {
  const set = <K extends keyof YogaPayload>(k: K, v: YogaPayload[K]) =>
    onChange({ ...value, [k]: v });
  const y = plan.prescription?.yoga;
  const summary = summarizeYoga(y);
  const canLogAsPlanned = !!y && (y.duration_min || y.style);

  return (
    <div className="space-y-3">
      {canLogAsPlanned && (
        <LogAsPlannedPill
          summary={summary}
          onClick={() => { onTouchStart?.(); onChange({ ...yogaDefaults(plan) }); }}
        />
      )}

      <SectionCard title="Session">
        <Field label="Duration">
          <Stepper value={value.duration_min} step={5} min={0}
            onChange={v => { onTouchStart?.(); set('duration_min', v ? Number(v) : undefined); }}
            onFocus={onTouchStart} unit="min" width="w-14" />
        </Field>
        <div className="pt-2">
          <div className="text-tiny text-muted mb-1.5">Style</div>
          <Pills options={STYLES} value={value.style as any ?? null}
            onChange={v => { onTouchStart?.(); set('style', (v as string) ?? undefined); }} />
        </div>
        <div className="pt-3">
          <div className="text-tiny text-muted mb-1.5">Focus (tap all that apply)</div>
          <Pills options={FOCUS} multi value={value.focus ?? null}
            onChange={v => { onTouchStart?.(); set('focus', (v as string[]) ?? undefined); }} />
        </div>
        <div className="pt-3">
          <div className="text-tiny text-muted mb-1.5">Intensity</div>
          <Pills options={INTENSITIES} value={value.intensity ?? null}
            onChange={v => { onTouchStart?.(); set('intensity', (v as any) ?? undefined); }} />
        </div>
      </SectionCard>
    </div>
  );
}
