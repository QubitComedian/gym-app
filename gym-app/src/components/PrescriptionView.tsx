type SetScheme =
  | { type: 'standard'; sets?: number; reps?: string | number }
  | { type: 'emom'; minutes: number; reps_per_min: number; total_reps?: number }
  | { type: 'time'; sets?: number; seconds_per_side?: number; seconds?: number }
  | { type: 'circuit'; rounds?: number };

type Block =
  | {
      kind: 'single';
      position: number;
      exercise_id: string;
      set_scheme: SetScheme;
      weight_hint?: string;
      rest_s?: number;
      rir_target?: number;
      notes?: string;
    }
  | {
      kind: 'superset';
      position: number;
      rounds: number;
      rest_between_s?: number;
      drop_set_on_last?: { drop_pct?: number; to_near_failure?: boolean };
      items: {
        letter: string;
        exercise_id: string;
        set_scheme: SetScheme;
        weight_hint?: string;
        notes?: string;
      }[];
    };

export type Prescription = {
  blocks?: Block[];
  notes_top?: string;
  estimated_minutes?: number;
  creatine_g?: number;
  run?: { distance_km?: number | string; duration_min?: number; pace?: string; notes?: string };
  mobility?: { duration_min?: number; protocol?: string };
};

function fmtScheme(s: SetScheme): string {
  if (!s) return '';
  if (s.type === 'standard') return `${s.sets ?? '?'} × ${s.reps ?? '?'}`;
  if (s.type === 'emom') return `EMOM ${s.minutes}′ · ${s.reps_per_min}/min` + (s.total_reps ? ` · ${s.total_reps} total` : '');
  if (s.type === 'time') {
    if (s.seconds_per_side) return `${s.sets ?? 1} × ${s.seconds_per_side}s/side`;
    return `${s.sets ?? 1} × ${s.seconds ?? '?'}s`;
  }
  if (s.type === 'circuit') return `${s.rounds ?? '?'} rounds`;
  return '';
}

function exName(id: string) {
  return id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export default function PrescriptionView({ prescription }: { prescription: Prescription }) {
  const blocks = prescription?.blocks ?? [];
  return (
    <div className="space-y-3">
      {prescription?.notes_top && (
        <p className="text-xs italic text-muted leading-relaxed">{prescription.notes_top}</p>
      )}
      {prescription?.run && (
        <div className="rounded-lg bg-panel-2 border border-border p-3 text-sm">
          <div className="font-medium">Run</div>
          <div className="text-muted">
            {prescription.run.distance_km && `${prescription.run.distance_km} km`}
            {prescription.run.duration_min && ` · ${prescription.run.duration_min} min`}
            {prescription.run.pace && ` · ${prescription.run.pace}`}
          </div>
          {prescription.run.notes && <div className="text-xs text-muted mt-1">{prescription.run.notes}</div>}
        </div>
      )}
      {prescription?.mobility && (
        <div className="rounded-lg bg-panel-2 border border-border p-3 text-sm">
          <div className="font-medium">Mobility</div>
          <div className="text-muted">{prescription.mobility.duration_min} min · {prescription.mobility.protocol}</div>
        </div>
      )}
      {blocks.map((b, i) => (
        <div key={i} className="rounded-lg bg-panel-2 border border-border p-3">
          {b.kind === 'single' ? (
            <>
              <div className="flex items-baseline justify-between gap-2">
                <div className="font-medium text-sm">{exName(b.exercise_id)}</div>
                <div className="text-xs text-muted">{fmtScheme(b.set_scheme)}</div>
              </div>
              <div className="text-xs text-muted mt-0.5">
                {b.weight_hint && <span>{b.weight_hint}</span>}
                {b.rest_s != null && <span> · rest {b.rest_s}s</span>}
                {b.rir_target != null && <span> · RIR {b.rir_target}</span>}
              </div>
              {b.notes && <div className="text-xs italic text-muted mt-1">{b.notes}</div>}
            </>
          ) : (
            <>
              <div className="flex items-baseline justify-between gap-2">
                <div className="text-xs uppercase tracking-wider text-accent">Superset · {b.rounds} rounds</div>
                {b.rest_between_s != null && <div className="text-xs text-muted">rest {b.rest_between_s}s</div>}
              </div>
              <ul className="mt-1 space-y-1.5">
                {b.items.map((it, j) => (
                  <li key={j} className="text-sm flex justify-between gap-2">
                    <span><span className="text-muted mr-1">{it.letter}.</span>{exName(it.exercise_id)}</span>
                    <span className="text-xs text-muted whitespace-nowrap">{fmtScheme(it.set_scheme)} · {it.weight_hint ?? ''}</span>
                  </li>
                ))}
              </ul>
              {b.drop_set_on_last && (
                <div className="text-xs text-accent mt-1.5">
                  Drop-set on last round{b.drop_set_on_last.drop_pct ? ` (-${b.drop_set_on_last.drop_pct}%)` : ''}
                  {b.drop_set_on_last.to_near_failure ? ' to near failure' : ''}
                </div>
              )}
            </>
          )}
        </div>
      ))}
      {prescription?.estimated_minutes && (
        <p className="text-[11px] text-muted text-right">≈ {prescription.estimated_minutes} min</p>
      )}
    </div>
  );
}

export { exName };
