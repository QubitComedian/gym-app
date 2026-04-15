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

export function exName(id: string) {
  if (!id) return '';
  return id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function summarizePrescription(p?: Prescription): string {
  if (!p) return '';
  const blocks = p.blocks ?? [];
  if (blocks.length === 0) {
    if (p.run) {
      const bits: string[] = [];
      if (p.run.distance_km) bits.push(`${p.run.distance_km} km`);
      if (p.run.duration_min) bits.push(`${p.run.duration_min} min`);
      if (p.run.pace) bits.push(String(p.run.pace));
      return bits.join(' · ');
    }
    if (p.mobility) return `${p.mobility.duration_min ?? ''} min · ${p.mobility.protocol ?? 'mobility'}`.trim();
    return '';
  }
  const count = blocks.reduce((n, b) => n + (b.kind === 'single' ? 1 : b.items.length), 0);
  const est = p.estimated_minutes ? ` · ~${p.estimated_minutes} min` : '';
  return `${count} exercise${count === 1 ? '' : 's'}${est}`;
}

export default function PrescriptionView({
  prescription,
  dense = false,
}: {
  prescription?: Prescription;
  dense?: boolean;
}) {
  if (!prescription) return null;
  const blocks = prescription.blocks ?? [];
  const gap = dense ? 'space-y-2' : 'space-y-2.5';

  return (
    <div className={gap}>
      {prescription.notes_top && (
        <p className="text-tiny italic text-muted leading-relaxed">{prescription.notes_top}</p>
      )}

      {prescription.run && (
        <div className="rounded-lg bg-panel-2 border border-border px-3.5 py-3">
          <div className="text-small font-medium">Run</div>
          <div className="text-tiny text-muted mt-0.5">
            {[
              prescription.run.distance_km && `${prescription.run.distance_km} km`,
              prescription.run.duration_min && `${prescription.run.duration_min} min`,
              prescription.run.pace,
            ].filter(Boolean).join(' · ')}
          </div>
          {prescription.run.notes && <div className="text-tiny text-muted mt-1">{prescription.run.notes}</div>}
        </div>
      )}

      {prescription.mobility && (
        <div className="rounded-lg bg-panel-2 border border-border px-3.5 py-3">
          <div className="text-small font-medium">Mobility</div>
          <div className="text-tiny text-muted mt-0.5">
            {prescription.mobility.duration_min && `${prescription.mobility.duration_min} min`}
            {prescription.mobility.protocol && ` · ${prescription.mobility.protocol}`}
          </div>
        </div>
      )}

      {blocks.map((b, i) => (
        <div key={i} className="rounded-lg bg-panel-2 border border-border px-3.5 py-3">
          {b.kind === 'single' ? (
            <>
              <div className="flex items-baseline justify-between gap-3">
                <div className="text-small font-medium">{exName(b.exercise_id)}</div>
                <div className="text-tiny text-muted whitespace-nowrap tabular-nums">{fmtScheme(b.set_scheme)}</div>
              </div>
              {(b.weight_hint || b.rest_s != null || b.rir_target != null) && (
                <div className="text-tiny text-muted mt-1">
                  {[
                    b.weight_hint,
                    b.rest_s != null && `rest ${b.rest_s}s`,
                    b.rir_target != null && `RIR ${b.rir_target}`,
                  ].filter(Boolean).join(' · ')}
                </div>
              )}
              {b.notes && <div className="text-tiny italic text-muted mt-1">{b.notes}</div>}
            </>
          ) : (
            <>
              <div className="flex items-baseline justify-between gap-3">
                <div className="text-micro uppercase tracking-wider text-accent">Superset · {b.rounds} rounds</div>
                {b.rest_between_s != null && <div className="text-tiny text-muted">rest {b.rest_between_s}s</div>}
              </div>
              <ul className="mt-1.5 space-y-1.5">
                {b.items.map((it, j) => (
                  <li key={j} className="text-small flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate">
                      <span className="text-muted mr-1.5">{it.letter}.</span>
                      {exName(it.exercise_id)}
                    </span>
                    <span className="text-tiny text-muted whitespace-nowrap tabular-nums">
                      {fmtScheme(it.set_scheme)}{it.weight_hint ? ` · ${it.weight_hint}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
              {b.drop_set_on_last && (
                <div className="text-tiny text-accent mt-2">
                  Drop-set on last round{b.drop_set_on_last.drop_pct ? ` (-${b.drop_set_on_last.drop_pct}%)` : ''}
                  {b.drop_set_on_last.to_near_failure ? ' to near failure' : ''}
                </div>
              )}
            </>
          )}
        </div>
      ))}

      {prescription.estimated_minutes && blocks.length > 0 && (
        <p className="text-micro text-muted text-right tabular-nums">≈ {prescription.estimated_minutes} min</p>
      )}
    </div>
  );
}
