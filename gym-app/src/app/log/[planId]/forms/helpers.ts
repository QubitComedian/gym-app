/**
 * Pure helpers for non-gym log forms: pace derive, grade scales, mobility normalize.
 */

/* ──────────── Pace ──────────── */

export function derivePace(type: 'run' | 'bike' | 'swim', distance?: number, minutes?: number): string {
  if (!minutes || !distance) return '';
  if (type === 'swim') {
    // distance is meters → pace per 100m
    const spH = minutes * 60 / (distance / 100);
    return `${Math.floor(spH / 60)}:${String(Math.round(spH % 60)).padStart(2, '0')}/100m`;
  }
  // run / bike → pace per km
  const spk = minutes * 60 / distance;
  return `${Math.floor(spk / 60)}:${String(Math.round(spk % 60)).padStart(2, '0')}/km`;
}

/* ──────────── Climb grade scales ──────────── */

export const V_SCALE = ['V0', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10', 'V11', 'V12'];
export const FRENCH = [
  '4a', '4b', '4c', '5a', '5b', '5c',
  '6a', '6a+', '6b', '6b+', '6c', '6c+',
  '7a', '7a+', '7b', '7b+', '7c', '7c+',
  '8a', '8a+', '8b', '8b+',
];

export type GradeScale = 'v' | 'french';

export function detectGradeScale(target?: string | null): GradeScale {
  if (!target) return 'v';
  if (/^v\d/i.test(target)) return 'v';
  if (/^\d[abc]/i.test(target)) return 'french';
  return 'v';
}

export function gradesForScale(scale: GradeScale): string[] {
  return scale === 'v' ? V_SCALE : FRENCH;
}

export function gradeRank(scale: GradeScale, g: string): number {
  const list = gradesForScale(scale);
  const i = list.findIndex(x => x.toLowerCase() === g.toLowerCase());
  return i < 0 ? -1 : i;
}

export type Tick = { grade: string; sent: number; flashed: number; worked: number };

export function hardestSendOf(ticks: Tick[], scale: GradeScale): string | null {
  const completed = ticks.filter(t => (t.sent ?? 0) + (t.flashed ?? 0) > 0);
  if (completed.length === 0) return null;
  return completed.reduce((max, t) =>
    gradeRank(scale, t.grade) > gradeRank(scale, max.grade) ? t : max
  ).grade;
}

/* ──────────── Mobility normalize ──────────── */

export type NormalizedMobilityItem = {
  exercise: string;
  duration_s?: number;
  reps?: string;
  notes?: string;
};

export type NormalizedMobility = {
  duration_min?: number;
  focus?: string;
  routine: NormalizedMobilityItem[];
};

export function normalizeMobility(m: any): NormalizedMobility {
  if (!m) return { routine: [] };
  if (Array.isArray(m)) {
    return { routine: m.map((s: any) => ({ exercise: String(s) })) };
  }
  return {
    duration_min: m.duration_min,
    focus: m.focus,
    routine: Array.isArray(m.routine)
      ? m.routine.map((r: any) => ({
          exercise: String(r.exercise ?? ''),
          duration_s: r.duration_s,
          reps: r.reps,
          notes: r.notes,
        }))
      : [],
  };
}

/* ──────────── Prescription summaries (for Log-as-planned pill) ──────────── */

export function summarizeYoga(y: any): string {
  if (!y) return '';
  const bits: string[] = [];
  if (y.duration_min) bits.push(`${y.duration_min} min`);
  if (y.style) bits.push(y.style);
  if (y.focus) bits.push(y.focus);
  return bits.join(' · ');
}

export function summarizeClimb(c: any): string {
  if (!c) return '';
  const bits: string[] = [];
  if (c.duration_min) bits.push(`${c.duration_min} min`);
  if (c.style) bits.push(c.style);
  if (c.grade_target) bits.push(c.grade_target);
  return bits.join(' · ');
}

export function summarizeMobility(m: any): string {
  if (!m) return '';
  if (Array.isArray(m)) return `${m.length} stretches`;
  const bits: string[] = [];
  if (m.duration_min) bits.push(`${m.duration_min} min`);
  if (m.routine?.length) bits.push(`${m.routine.length} moves`);
  if (m.focus) bits.push(m.focus);
  return bits.join(' · ');
}

export function summarizeSaunaCold(s: any): string {
  if (!s) return '';
  const bits: string[] = [];
  if (s.rounds) bits.push(`${s.rounds} rounds`);
  if (s.sauna_min_per_round) bits.push(`${s.sauna_min_per_round}m sauna`);
  if (s.cold_min_per_round) bits.push(`${s.cold_min_per_round}m cold`);
  return bits.join(' · ');
}

export function summarizeCardio(type: 'run' | 'bike' | 'swim', p: any): string {
  const block = p?.[type];
  if (!block) return '';
  const bits: string[] = [];
  if (type === 'run') {
    const km = block.km ?? block.distance_km;
    if (km) bits.push(`${km} km`);
    if (block.duration_min) bits.push(`${block.duration_min} min`);
    if (block.pace) bits.push(block.pace);
  } else if (type === 'bike') {
    const km = block.km ?? block.distance_km;
    if (km) bits.push(`${km} km`);
    if (block.duration_min) bits.push(`${block.duration_min} min`);
    if (block.zone) bits.push(block.zone);
  } else {
    if (block.distance_m) bits.push(`${block.distance_m} m`);
    if (block.duration_min) bits.push(`${block.duration_min} min`);
    if (block.stroke) bits.push(block.stroke);
  }
  return bits.join(' · ');
}
