import Link from 'next/link';

/* ───────────────────────── Schema ───────────────────────── */

type SetScheme =
  | { type: 'standard'; sets?: number; reps?: string | number }
  | { type: 'emom'; minutes: number; reps_per_min: number; total_reps?: number }
  | { type: 'time'; sets?: number; seconds_per_side?: number; seconds?: number }
  | { type: 'circuit'; rounds?: number; items?: string[] };

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

type RunRx = {
  km?: number;
  distance_km?: number;
  duration_min?: number;
  pace?: string;
  pace_s_per_km?: [number, number] | number;
  effort?: string;
  zone?: string;
  warmup_km?: number; warmup_min?: number;
  cooldown_km?: number; cooldown_min?: number;
  intervals?: any[];
  sets?: number;
  interval_km?: number;
  interval_pace_s_per_km?: [number, number];
  rest_s?: number;
  options?: any[];
  route?: string;
  notes?: string;
};

type BikeRx = {
  km?: number;
  distance_km?: number;
  duration_min?: number;
  avg_power_w?: number;
  zone?: string;
  notes?: string;
};

type SwimRx = {
  distance_m?: number;
  duration_min?: number;
  stroke?: string;
  sets?: any[];
  notes?: string;
};

type YogaRx = { duration_min?: number; style?: string; focus?: string; notes?: string };
type ClimbRx = { duration_min?: number; style?: string; grade_target?: string; notes?: string };

type MobilityItem = { exercise: string; duration_s?: number; reps?: string; notes?: string };
type MobilityRx =
  | string[]
  | { duration_min?: number; focus?: string; routine?: MobilityItem[] };

type SaunaColdRx = {
  rounds?: number;
  sauna_min_per_round?: number;
  cold_min_per_round?: number;
  notes?: string;
};

export type Prescription = {
  blocks?: Block[];
  notes_top?: string;
  estimated_minutes?: number;
  creatine_g?: number;
  run?: RunRx;
  bike?: BikeRx;
  swim?: SwimRx;
  yoga?: YogaRx;
  climb?: ClimbRx;
  mobility?: MobilityRx;
  sauna_cold?: SaunaColdRx;
};

/* ───────────────────────── Helpers ───────────────────────── */

export function exName(id: string) {
  if (!id) return '';
  return id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

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

function fmtPaceSpk(p?: number | [number, number]): string {
  if (p == null) return '';
  if (Array.isArray(p)) {
    return `${fmtPaceSpk(p[0])}–${fmtPaceSpk(p[1])}/km`;
  }
  const m = Math.floor(p / 60);
  const s = Math.round(p % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function paceString(r: RunRx): string {
  if (r.pace) return r.pace;
  if (r.pace_s_per_km != null) {
    return Array.isArray(r.pace_s_per_km)
      ? fmtPaceSpk(r.pace_s_per_km)
      : `${fmtPaceSpk(r.pace_s_per_km)}/km`;
  }
  return '';
}

function runDistance(r: RunRx): string {
  const km = r.km ?? r.distance_km;
  return km != null ? `${km} km` : '';
}

/* ───────────────────────── Summarizer ───────────────────────── */

export function summarizePrescription(p?: Prescription): string {
  if (!p) return '';
  const blocks = p.blocks ?? [];
  if (blocks.length > 0) {
    const count = blocks.reduce((n, b) => n + (b.kind === 'single' ? 1 : b.items.length), 0);
    const est = p.estimated_minutes ? ` · ~${p.estimated_minutes} min` : '';
    return `${count} exercise${count === 1 ? '' : 's'}${est}`;
  }
  if (p.run) {
    const bits: string[] = [];
    const d = runDistance(p.run);
    if (d) bits.push(d);
    if (p.run.duration_min) bits.push(`${p.run.duration_min} min`);
    const pace = paceString(p.run);
    if (pace) bits.push(pace);
    if (bits.length) return bits.join(' · ');
    if (p.run.options?.length) return `${p.run.options.length} options`;
  }
  if (p.bike) {
    const bits: string[] = [];
    if (p.bike.km ?? p.bike.distance_km) bits.push(`${p.bike.km ?? p.bike.distance_km} km`);
    if (p.bike.duration_min) bits.push(`${p.bike.duration_min} min`);
    if (p.bike.zone) bits.push(p.bike.zone);
    return bits.join(' · ');
  }
  if (p.swim) {
    const bits: string[] = [];
    if (p.swim.distance_m) bits.push(`${p.swim.distance_m} m`);
    if (p.swim.duration_min) bits.push(`${p.swim.duration_min} min`);
    if (p.swim.stroke) bits.push(p.swim.stroke);
    return bits.join(' · ');
  }
  if (p.yoga) {
    const bits: string[] = [];
    if (p.yoga.duration_min) bits.push(`${p.yoga.duration_min} min`);
    if (p.yoga.style) bits.push(p.yoga.style);
    if (p.yoga.focus) bits.push(p.yoga.focus);
    return bits.join(' · ');
  }
  if (p.climb) {
    const bits: string[] = [];
    if (p.climb.duration_min) bits.push(`${p.climb.duration_min} min`);
    if (p.climb.style) bits.push(p.climb.style);
    if (p.climb.grade_target) bits.push(p.climb.grade_target);
    return bits.join(' · ');
  }
  if (p.mobility) {
    if (Array.isArray(p.mobility)) return `${p.mobility.length} stretches`;
    const bits: string[] = [];
    if (p.mobility.duration_min) bits.push(`${p.mobility.duration_min} min`);
    if (p.mobility.routine?.length) bits.push(`${p.mobility.routine.length} moves`);
    if (p.mobility.focus) bits.push(p.mobility.focus);
    return bits.join(' · ');
  }
  if (p.sauna_cold) {
    const bits: string[] = [];
    if (p.sauna_cold.rounds) bits.push(`${p.sauna_cold.rounds} rounds`);
    if (p.sauna_cold.sauna_min_per_round) bits.push(`${p.sauna_cold.sauna_min_per_round}m sauna`);
    if (p.sauna_cold.cold_min_per_round) bits.push(`${p.sauna_cold.cold_min_per_round}m cold`);
    return bits.join(' · ');
  }
  return '';
}

/* ───────────────────────── Section UI primitives ───────────────────────── */

function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-panel-2 border border-border px-3.5 py-3">
      {title && <div className="text-micro uppercase tracking-wider text-muted mb-1.5">{title}</div>}
      {children}
    </div>
  );
}

function KV({ label, value }: { label: string; value?: React.ReactNode }) {
  if (value == null || value === '' || value === false) return null;
  return (
    <div className="flex items-baseline justify-between gap-3 text-small">
      <span className="text-muted-2">{label}</span>
      <span className="font-medium tabular-nums text-right">{value}</span>
    </div>
  );
}

/* ───────────────────────── Renderers per type ───────────────────────── */

function RunView({ r }: { r: RunRx }) {
  const distance = runDistance(r);
  const pace = paceString(r);
  const intervals = r.intervals ?? (r.sets && r.interval_km ? [{ repeats: r.sets, work_km: r.interval_km, pace_s_per_km: r.interval_pace_s_per_km, rest_s: r.rest_s }] : []);
  const hasMain = distance || r.duration_min || pace || r.effort || r.zone;

  return (
    <div className="space-y-2">
      {hasMain && (
        <Section title="Main">
          <div className="space-y-1">
            <KV label="Distance" value={distance} />
            <KV label="Duration" value={r.duration_min ? `${r.duration_min} min` : undefined} />
            <KV label="Pace" value={pace} />
            <KV label="Effort" value={r.effort} />
            <KV label="Zone" value={r.zone} />
          </div>
        </Section>
      )}

      {(r.warmup_km || r.warmup_min) && (
        <Section title="Warmup">
          <div className="text-small text-muted-2">
            {r.warmup_km ? `${r.warmup_km} km` : ''}{r.warmup_km && r.warmup_min ? ' · ' : ''}{r.warmup_min ? `${r.warmup_min} min` : ''} easy
          </div>
        </Section>
      )}

      {intervals.length > 0 && (
        <Section title="Intervals">
          <ul className="space-y-1">
            {intervals.map((iv: any, i: number) => {
              const work = iv.work_km ? `${iv.work_km} km`
                : iv.work_distance_m ? `${iv.work_distance_m} m`
                : iv.work_s ? `${iv.work_s}s`
                : '';
              const pace = iv.pace ?? (iv.pace_s_per_km ? fmtPaceSpk(iv.pace_s_per_km) + '/km' : '');
              const rest = iv.rest_s ? `rest ${iv.rest_s}s` : '';
              return (
                <li key={i} className="flex items-baseline justify-between gap-3 text-small">
                  <span className="font-medium tabular-nums">{iv.repeats ?? 1} × {work}</span>
                  <span className="text-muted text-tiny tabular-nums">{[pace, rest].filter(Boolean).join(' · ')}</span>
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {(r.cooldown_km || r.cooldown_min) && (
        <Section title="Cooldown">
          <div className="text-small text-muted-2">
            {r.cooldown_km ? `${r.cooldown_km} km` : ''}{r.cooldown_km && r.cooldown_min ? ' · ' : ''}{r.cooldown_min ? `${r.cooldown_min} min` : ''} easy
          </div>
        </Section>
      )}

      {r.options && r.options.length > 0 && (
        <Section title="Pick one">
          <ul className="space-y-2.5">
            {r.options.map((opt: any, i: number) => (
              <li key={i} className="border-l-2 border-accent/40 pl-3">
                <div className="text-small font-medium capitalize">{opt.name}</div>
                <div className="text-tiny text-muted mt-0.5">
                  {[
                    opt.km != null && `${opt.km} km`,
                    opt.warmup_km != null && `warmup ${opt.warmup_km} km`,
                    opt.sets != null && opt.interval_km != null && `${opt.sets} × ${opt.interval_km} km`,
                    opt.interval_pace_s_per_km && `@ ${fmtPaceSpk(opt.interval_pace_s_per_km)}/km`,
                    opt.pace_s_per_km && `@ ${fmtPaceSpk(opt.pace_s_per_km)}/km`,
                    opt.rest_s != null && `rest ${opt.rest_s}s`,
                    opt.cooldown_km != null && `cooldown ${opt.cooldown_km} km`,
                  ].filter(Boolean).join(' · ')}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {r.route && <p className="text-tiny text-muted">Route: {r.route}</p>}
      {r.notes && <p className="text-tiny italic text-muted leading-relaxed">{r.notes}</p>}
    </div>
  );
}

function BikeView({ b }: { b: BikeRx }) {
  const distance = b.km ?? b.distance_km;
  return (
    <Section title="Ride">
      <div className="space-y-1">
        <KV label="Distance" value={distance ? `${distance} km` : undefined} />
        <KV label="Duration" value={b.duration_min ? `${b.duration_min} min` : undefined} />
        <KV label="Power" value={b.avg_power_w ? `${b.avg_power_w} W avg` : undefined} />
        <KV label="Zone" value={b.zone} />
      </div>
      {b.notes && <p className="text-tiny italic text-muted mt-2">{b.notes}</p>}
    </Section>
  );
}

function SwimView({ s }: { s: SwimRx }) {
  return (
    <div className="space-y-2">
      <Section title="Swim">
        <div className="space-y-1">
          <KV label="Distance" value={s.distance_m ? `${s.distance_m} m` : undefined} />
          <KV label="Duration" value={s.duration_min ? `${s.duration_min} min` : undefined} />
          <KV label="Stroke" value={s.stroke} />
        </div>
      </Section>
      {s.sets && s.sets.length > 0 && (
        <Section title="Sets">
          <ul className="space-y-1">
            {s.sets.map((set: any, i: number) => (
              <li key={i} className="flex items-baseline justify-between gap-3 text-small">
                <span className="font-medium tabular-nums">{set.repeats ?? 1} × {set.distance_m ?? '?'} m</span>
                <span className="text-muted text-tiny">{[set.stroke, set.rest_s && `rest ${set.rest_s}s`, set.pace].filter(Boolean).join(' · ')}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {s.notes && <p className="text-tiny italic text-muted">{s.notes}</p>}
    </div>
  );
}

function YogaView({ y }: { y: YogaRx }) {
  return (
    <Section title="Yoga">
      <div className="space-y-1">
        <KV label="Duration" value={y.duration_min ? `${y.duration_min} min` : undefined} />
        <KV label="Style" value={y.style} />
        <KV label="Focus" value={y.focus} />
      </div>
      {y.notes && <p className="text-tiny italic text-muted mt-2">{y.notes}</p>}
    </Section>
  );
}

function ClimbView({ c }: { c: ClimbRx }) {
  return (
    <Section title="Climb">
      <div className="space-y-1">
        <KV label="Duration" value={c.duration_min ? `${c.duration_min} min` : undefined} />
        <KV label="Style" value={c.style} />
        <KV label="Grade target" value={c.grade_target} />
      </div>
      {c.notes && <p className="text-tiny italic text-muted mt-2">{c.notes}</p>}
    </Section>
  );
}

function MobilityView({ m }: { m: MobilityRx }) {
  // Seed shape: array of strings
  if (Array.isArray(m)) {
    return (
      <Section title="Routine">
        <ul className="space-y-1.5">
          {m.map((s, i) => (
            <li key={i} className="text-small flex items-start gap-2">
              <span className="text-muted tabular-nums shrink-0">{i + 1}.</span>
              <span className="min-w-0">{s}</span>
            </li>
          ))}
        </ul>
      </Section>
    );
  }
  // Object shape
  return (
    <div className="space-y-2">
      {(m.duration_min || m.focus) && (
        <Section title="Mobility">
          <div className="space-y-1">
            <KV label="Duration" value={m.duration_min ? `${m.duration_min} min` : undefined} />
            <KV label="Focus" value={m.focus} />
          </div>
        </Section>
      )}
      {m.routine && m.routine.length > 0 && (
        <Section title="Routine">
          <ul className="space-y-2">
            {m.routine.map((item, i) => (
              <li key={i} className="text-small">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">{item.exercise}</span>
                  <span className="text-tiny text-muted tabular-nums">
                    {item.duration_s ? `${item.duration_s}s` : item.reps ?? ''}
                  </span>
                </div>
                {item.notes && <div className="text-tiny italic text-muted mt-0.5">{item.notes}</div>}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function SaunaColdView({ s }: { s: SaunaColdRx }) {
  return (
    <Section title="Sauna + cold">
      <div className="space-y-1">
        <KV label="Rounds" value={s.rounds} />
        <KV label="Sauna" value={s.sauna_min_per_round ? `${s.sauna_min_per_round} min × ${s.rounds ?? 1}` : undefined} />
        <KV label="Cold" value={s.cold_min_per_round ? `${s.cold_min_per_round} min × ${s.rounds ?? 1}` : undefined} />
      </div>
      {s.notes && <p className="text-tiny italic text-muted mt-2">{s.notes}</p>}
    </Section>
  );
}

/* ───────────────────────── Gym blocks ───────────────────────── */

function BlockView({ b }: { b: Block }) {
  if (b.kind === 'single') {
    return (
      <div className="rounded-lg bg-panel-2 border border-border px-3.5 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <Link href={`/exercise/${b.exercise_id}`} className="text-small font-medium underline-offset-4 hover:underline">
            {exName(b.exercise_id)}
          </Link>
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
      </div>
    );
  }
  return (
    <div className="rounded-lg bg-panel-2 border border-border px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-micro uppercase tracking-wider text-accent">Superset · {b.rounds} rounds</div>
        {b.rest_between_s != null && <div className="text-tiny text-muted">rest {b.rest_between_s}s</div>}
      </div>
      <ul className="mt-1.5 space-y-1.5">
        {b.items.map((it, j) => (
          <li key={j} className="text-small flex items-baseline justify-between gap-3">
            <Link href={`/exercise/${it.exercise_id}`} className="min-w-0 truncate underline-offset-4 hover:underline">
              <span className="text-muted mr-1.5">{it.letter}.</span>
              {exName(it.exercise_id)}
            </Link>
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
    </div>
  );
}

/* ───────────────────────── Main export ───────────────────────── */

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

      {prescription.run && <RunView r={prescription.run} />}
      {prescription.bike && <BikeView b={prescription.bike} />}
      {prescription.swim && <SwimView s={prescription.swim} />}
      {prescription.yoga && <YogaView y={prescription.yoga} />}
      {prescription.climb && <ClimbView c={prescription.climb} />}
      {prescription.mobility && <MobilityView m={prescription.mobility} />}
      {prescription.sauna_cold && <SaunaColdView s={prescription.sauna_cold} />}

      {blocks.map((b, i) => <BlockView key={i} b={b} />)}

      {prescription.estimated_minutes && blocks.length > 0 && (
        <p className="text-micro text-muted text-right tabular-nums">≈ {prescription.estimated_minutes} min</p>
      )}
    </div>
  );
}
