/**
 * Pure plan → Google Calendar event projection (P1.4 / PR-T).
 *
 * Takes a plan row, the user's training preferences, and their
 * timezone, and returns the Google Calendar event resource body that
 * the worker will send to `events.insert` / `events.update`.
 *
 * Pure — no I/O, no Supabase, no googleapis import. The worker calls
 * this, then hands the result to the Google client.
 *
 * The projection is deterministic given the same inputs, which lets
 * the checksum (SHA-1 of the projected body) serve as a change-
 * detection gate: if the checksum hasn't changed since the last sync,
 * the worker can skip the Google round-trip entirely.
 */

import crypto from 'crypto';

// =====================================================================
// Types
// =====================================================================

export type PlanRow = {
  id: string;
  date: string; // ISO date 'YYYY-MM-DD'
  type: string;
  day_code: string | null;
  status: string;
  prescription: any; // jsonb
};

export type TrainingPreferences = {
  session_start_time: string; // HH:MM:SS or HH:MM
  session_duration_minutes: number;
  day_overrides: Record<string, { start?: string; minutes?: number }>;
  color_scheme: string | null;
};

/** Defaults when the user has no training_preferences row yet. */
export const DEFAULT_PREFERENCES: TrainingPreferences = {
  session_start_time: '07:00:00',
  session_duration_minutes: 60,
  day_overrides: {},
  color_scheme: null,
};

export type GoogleEventBody = {
  summary: string;
  description: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  colorId?: string;
};

// =====================================================================
// Projection
// =====================================================================

/**
 * Project a plan row into a Google Calendar event resource body.
 *
 * The `timezone` comes from `profiles.timezone` (IANA, e.g.
 * 'Europe/Paris'). Google Calendar uses it to anchor the dateTime
 * offset — the worker sends a wall-clock time + timezone and Google
 * resolves DST.
 */
export function projectPlanToEvent(
  plan: PlanRow,
  prefs: TrainingPreferences,
  timezone: string,
): GoogleEventBody {
  const { startTime, durationMinutes } = resolveSessionTiming(plan.date, prefs);

  const startDT = `${plan.date}T${startTime}`;
  const endDT = `${plan.date}T${addMinutesToTime(startTime, durationMinutes)}`;

  const summary = buildSummary(plan);
  const description = descFromPrescription(plan.prescription);

  const body: GoogleEventBody = {
    summary,
    description,
    start: { dateTime: startDT, timeZone: timezone },
    end: { dateTime: endDT, timeZone: timezone },
  };

  if (prefs.color_scheme) {
    body.colorId = prefs.color_scheme;
  }

  return body;
}

/**
 * SHA-1 checksum of the projected event body. Used for change
 * detection: if the checksum matches what's stored in
 * `calendar_links.checksum`, the Google round-trip is skipped.
 *
 * The hash covers the full projected body (summary, description,
 * start, end, colorId) so any field change triggers a sync.
 */
export function checksumEvent(body: GoogleEventBody): string {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify(body))
    .digest('hex');
}

// =====================================================================
// Helpers (exported for tests)
// =====================================================================

/**
 * Resolve the session start time and duration for a specific date,
 * applying day_overrides when present.
 */
export function resolveSessionTiming(
  dateIso: string,
  prefs: TrainingPreferences,
): { startTime: string; durationMinutes: number } {
  // ISO weekday: 1=Monday … 7=Sunday (same as the day_overrides keys).
  const dow = isoWeekday(dateIso);
  const override = prefs.day_overrides[String(dow)];

  const startTime = normalizeTime(override?.start ?? prefs.session_start_time);
  const durationMinutes = override?.minutes ?? prefs.session_duration_minutes;

  return { startTime, durationMinutes };
}

/**
 * Build the event summary line.
 *
 * Format: `🏋️ Push` or `🏋️ Gym` or `🏃 Run · quality_run`
 *
 * The emoji is a quick visual anchor when scanning a calendar; the
 * type + day_code give enough context without opening the event.
 */
export function buildSummary(plan: PlanRow): string {
  const emoji = TYPE_EMOJI[plan.type] ?? '🏋️';
  const label = plan.day_code
    ? formatDayCode(plan.day_code)
    : formatType(plan.type);
  return `${emoji} ${label}`;
}

const TYPE_EMOJI: Record<string, string> = {
  gym: '🏋️',
  run: '🏃',
  bike: '🚴',
  swim: '🏊',
  yoga: '🧘',
  climb: '🧗',
  sauna_cold: '🧊',
  mobility: '🤸',
  rest: '😴',
  other: '💪',
};

function formatDayCode(code: string): string {
  return code
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatType(type: string): string {
  return type
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Format prescription blocks into a multi-line event description.
 *
 * Ported from the demo `/api/calendar/push` route — same output so
 * existing users see no change when the worker takes over.
 */
export function descFromPrescription(p: any): string {
  if (!p) return '';
  const lines: string[] = [];
  if (p.notes_top) {
    lines.push(p.notes_top, '');
  }
  for (const b of p.blocks ?? []) {
    if (b.kind === 'single') {
      const sch = b.set_scheme || {};
      const schStr =
        sch.type === 'standard'
          ? `${sch.sets ?? '?'} × ${sch.reps ?? '?'}`
          : sch.type === 'emom'
            ? `EMOM ${sch.minutes}′ · ${sch.reps_per_min}/min`
            : sch.type === 'time'
              ? `${sch.sets ?? 1} × ${sch.seconds_per_side ?? sch.seconds}s`
              : '';
      lines.push(
        `• ${b.exercise_id.replace(/_/g, ' ')} — ${schStr}${b.weight_hint ? ` @ ${b.weight_hint}` : ''}${b.rir_target != null ? ` (RIR ${b.rir_target})` : ''}`
      );
      if (b.notes) lines.push(`    ${b.notes}`);
    } else if (b.kind === 'superset') {
      lines.push(
        `Superset · ${b.rounds} rounds (rest ${b.rest_between_s ?? 60}s)`
      );
      for (const it of b.items) {
        const sch = it.set_scheme || {};
        const schStr = sch.type === 'standard' ? `${sch.reps ?? '?'}` : '';
        lines.push(
          `  ${it.letter}. ${it.exercise_id.replace(/_/g, ' ')} — ${schStr}${it.weight_hint ? ` @ ${it.weight_hint}` : ''}`
        );
      }
      if (b.drop_set_on_last) {
        lines.push(
          `  Drop set last round${b.drop_set_on_last.drop_pct ? ` -${b.drop_set_on_last.drop_pct}%` : ''}`
        );
      }
    }
  }
  if (p.estimated_minutes) lines.push('', `≈ ${p.estimated_minutes} min`);
  return lines.join('\n');
}

// =====================================================================
// Time utilities (exported for tests)
// =====================================================================

/**
 * ISO weekday for a YYYY-MM-DD date string. 1=Monday, 7=Sunday.
 * Pure — no Date timezone concerns because we only need the day-of-week
 * of the date value itself (not "what day is it in the user's TZ").
 */
export function isoWeekday(dateIso: string): number {
  // new Date('YYYY-MM-DD') parses as UTC midnight — getUTCDay gives
  // 0=Sunday … 6=Saturday. Map to ISO: Mon=1 … Sun=7.
  const jsDay = new Date(dateIso + 'T00:00:00Z').getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}

/**
 * Normalize a time string to `HH:MM:SS`. Accepts `HH:MM:SS`, `HH:MM`,
 * or even `H:MM` and pads to the canonical 8-char form.
 */
export function normalizeTime(raw: string): string {
  const parts = raw.split(':');
  const h = (parts[0] ?? '07').padStart(2, '0');
  const m = (parts[1] ?? '00').padStart(2, '0');
  const s = (parts[2] ?? '00').padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/**
 * Add minutes to a `HH:MM:SS` time string, returning `HH:MM:SS`.
 * Clamps to 23:59:59 (a session can't roll past midnight in our
 * model — the plan date is the session date).
 */
export function addMinutesToTime(time: string, minutes: number): string {
  const [h, m, s] = time.split(':').map(Number);
  let totalMin = h * 60 + m + minutes;
  if (totalMin >= 24 * 60) totalMin = 24 * 60 - 1; // 23:59
  const newH = Math.floor(totalMin / 60);
  const newM = totalMin % 60;
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}:${String(s ?? 0).padStart(2, '0')}`;
}
