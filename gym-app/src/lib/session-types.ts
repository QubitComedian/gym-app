export const TYPE_LABEL: Record<string, string> = {
  gym: 'Gym',
  run: 'Run',
  bike: 'Bike',
  swim: 'Swim',
  yoga: 'Yoga',
  climb: 'Climb',
  sauna_cold: 'Sauna + Cold',
  mobility: 'Mobility',
  rest: 'Rest',
  other: 'Other',
};

export const TYPE_COLOR: Record<string, string> = {
  gym: '#d4ff3a',        // accent
  run: '#7cc3ff',        // blue
  bike: '#ffb870',       // orange
  swim: '#7cdcff',       // cyan
  yoga: '#c89bff',       // purple
  climb: '#ff9aa2',      // rose
  sauna_cold: '#6bd4c9', // teal
  mobility: '#b0b0b0',   // gray
  rest: '#3a3a3a',       // dim
  other: '#8a8a8a',
};

export type SessionType = keyof typeof TYPE_LABEL;

export function typeColor(t: string | undefined) {
  if (!t) return TYPE_COLOR.other;
  return TYPE_COLOR[t] ?? TYPE_COLOR.other;
}
