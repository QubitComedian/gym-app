/**
 * Unit tests for the plan → Google Calendar event projection
 * (P1.4 / PR-T).
 *
 * Run via:
 *   npx tsx --test src/lib/google/project.test.ts
 *
 * These are all pure — no I/O, no mocks needed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  addMinutesToTime,
  buildSummary,
  checksumEvent,
  DEFAULT_PREFERENCES,
  descFromPrescription,
  isoWeekday,
  normalizeTime,
  projectPlanToEvent,
  resolveSessionTiming,
  type GoogleEventBody,
  type PlanRow,
  type TrainingPreferences,
} from './project';

// =====================================================================
// isoWeekday
// =====================================================================

describe('isoWeekday', () => {
  it('returns 1 for Monday', () => {
    // 2026-04-13 is a Monday
    assert.equal(isoWeekday('2026-04-13'), 1);
  });

  it('returns 7 for Sunday', () => {
    // 2026-04-19 is a Sunday
    assert.equal(isoWeekday('2026-04-19'), 7);
  });

  it('returns 3 for Wednesday', () => {
    // 2026-04-15 is a Wednesday
    assert.equal(isoWeekday('2026-04-15'), 3);
  });

  it('returns 4 for Thursday (today)', () => {
    // 2026-04-16 is a Thursday
    assert.equal(isoWeekday('2026-04-16'), 4);
  });

  it('returns 6 for Saturday', () => {
    // 2026-04-18 is a Saturday
    assert.equal(isoWeekday('2026-04-18'), 6);
  });
});

// =====================================================================
// normalizeTime
// =====================================================================

describe('normalizeTime', () => {
  it('passes through HH:MM:SS unchanged', () => {
    assert.equal(normalizeTime('07:00:00'), '07:00:00');
    assert.equal(normalizeTime('18:30:00'), '18:30:00');
  });

  it('appends :00 to HH:MM', () => {
    assert.equal(normalizeTime('07:00'), '07:00:00');
    assert.equal(normalizeTime('18:30'), '18:30:00');
  });

  it('pads single-digit hour', () => {
    assert.equal(normalizeTime('7:00'), '07:00:00');
  });
});

// =====================================================================
// addMinutesToTime
// =====================================================================

describe('addMinutesToTime', () => {
  it('adds minutes normally', () => {
    assert.equal(addMinutesToTime('07:00:00', 60), '08:00:00');
    assert.equal(addMinutesToTime('07:00:00', 90), '08:30:00');
    assert.equal(addMinutesToTime('18:30:00', 45), '19:15:00');
  });

  it('clamps to 23:59 when result would exceed midnight', () => {
    assert.equal(addMinutesToTime('23:00:00', 120), '23:59:00');
  });

  it('preserves seconds from input', () => {
    assert.equal(addMinutesToTime('07:00:30', 60), '08:00:30');
  });
});

// =====================================================================
// resolveSessionTiming
// =====================================================================

describe('resolveSessionTiming', () => {
  const prefs: TrainingPreferences = {
    session_start_time: '07:00:00',
    session_duration_minutes: 60,
    day_overrides: {
      '1': { start: '06:30', minutes: 45 },
      '6': { start: '09:00' },
    },
    color_scheme: null,
  };

  it('uses defaults for a day without override', () => {
    // 2026-04-15 = Wednesday (3)
    const r = resolveSessionTiming('2026-04-15', prefs);
    assert.equal(r.startTime, '07:00:00');
    assert.equal(r.durationMinutes, 60);
  });

  it('applies full override (start + minutes)', () => {
    // 2026-04-13 = Monday (1)
    const r = resolveSessionTiming('2026-04-13', prefs);
    assert.equal(r.startTime, '06:30:00');
    assert.equal(r.durationMinutes, 45);
  });

  it('applies partial override (start only, duration falls back)', () => {
    // 2026-04-18 = Saturday (6)
    const r = resolveSessionTiming('2026-04-18', prefs);
    assert.equal(r.startTime, '09:00:00');
    assert.equal(r.durationMinutes, 60);
  });

  it('uses DEFAULT_PREFERENCES when no prefs exist', () => {
    const r = resolveSessionTiming('2026-04-15', DEFAULT_PREFERENCES);
    assert.equal(r.startTime, '07:00:00');
    assert.equal(r.durationMinutes, 60);
  });
});

// =====================================================================
// buildSummary
// =====================================================================

describe('buildSummary', () => {
  const base: PlanRow = {
    id: 'p1',
    date: '2026-04-16',
    type: 'gym',
    day_code: null,
    status: 'planned',
    prescription: {},
  };

  it('uses day_code when present, title-cased', () => {
    const s = buildSummary({ ...base, day_code: 'push' });
    assert.equal(s, '🏋️ Push');
  });

  it('handles multi-word day_code', () => {
    const s = buildSummary({ ...base, day_code: 'upper_full' });
    assert.equal(s, '🏋️ Upper Full');
  });

  it('falls back to type when no day_code', () => {
    const s = buildSummary({ ...base, type: 'gym', day_code: null });
    assert.equal(s, '🏋️ Gym');
  });

  it('uses type-specific emoji', () => {
    assert.ok(buildSummary({ ...base, type: 'run', day_code: null }).startsWith('🏃'));
    assert.ok(buildSummary({ ...base, type: 'swim', day_code: null }).startsWith('🏊'));
    assert.ok(buildSummary({ ...base, type: 'yoga', day_code: null }).startsWith('🧘'));
    assert.ok(buildSummary({ ...base, type: 'bike', day_code: null }).startsWith('🚴'));
    assert.ok(buildSummary({ ...base, type: 'rest', day_code: null }).startsWith('😴'));
  });

  it('falls back to 🏋️ for unknown types', () => {
    assert.ok(buildSummary({ ...base, type: 'unknown' as any, day_code: null }).startsWith('🏋️'));
  });
});

// =====================================================================
// descFromPrescription
// =====================================================================

describe('descFromPrescription', () => {
  it('returns empty string for null/undefined prescription', () => {
    assert.equal(descFromPrescription(null), '');
    assert.equal(descFromPrescription(undefined), '');
  });

  it('formats notes_top', () => {
    const desc = descFromPrescription({ notes_top: 'Go heavy today.' });
    assert.ok(desc.startsWith('Go heavy today.'));
  });

  it('formats a single block with standard set scheme', () => {
    const desc = descFromPrescription({
      blocks: [
        {
          kind: 'single',
          exercise_id: 'bench_press',
          set_scheme: { type: 'standard', sets: 4, reps: '8-10' },
          weight_hint: '135 lb',
          rir_target: 2,
        },
      ],
    });
    assert.ok(desc.includes('bench press'));
    assert.ok(desc.includes('4 × 8-10'));
    assert.ok(desc.includes('@ 135 lb'));
    assert.ok(desc.includes('RIR 2'));
  });

  it('formats EMOM set scheme', () => {
    const desc = descFromPrescription({
      blocks: [
        {
          kind: 'single',
          exercise_id: 'pull_ups_emom',
          set_scheme: { type: 'emom', minutes: 10, reps_per_min: 2 },
        },
      ],
    });
    assert.ok(desc.includes('EMOM 10′'));
    assert.ok(desc.includes('2/min'));
  });

  it('formats superset block', () => {
    const desc = descFromPrescription({
      blocks: [
        {
          kind: 'superset',
          rounds: 4,
          rest_between_s: 75,
          items: [
            { letter: 'A', exercise_id: 'incline_db_press', set_scheme: { type: 'standard', reps: '8-10' }, weight_hint: '30 lb' },
            { letter: 'B', exercise_id: 'cable_row', set_scheme: { type: 'standard', reps: '10' } },
          ],
        },
      ],
    });
    assert.ok(desc.includes('Superset · 4 rounds'));
    assert.ok(desc.includes('rest 75s'));
    assert.ok(desc.includes('A. incline db press'));
    assert.ok(desc.includes('B. cable row'));
  });

  it('formats estimated_minutes at the end', () => {
    const desc = descFromPrescription({ estimated_minutes: 50 });
    assert.ok(desc.includes('≈ 50 min'));
  });
});

// =====================================================================
// projectPlanToEvent (integration of the above)
// =====================================================================

describe('projectPlanToEvent', () => {
  const plan: PlanRow = {
    id: 'plan-1',
    date: '2026-04-16',
    type: 'gym',
    day_code: 'push',
    status: 'planned',
    prescription: {
      notes_top: 'Beat last week.',
      blocks: [
        {
          kind: 'single',
          exercise_id: 'bench_press',
          set_scheme: { type: 'standard', sets: 4, reps: '8-10' },
          weight_hint: '135 lb',
        },
      ],
      estimated_minutes: 55,
    },
  };

  const prefs: TrainingPreferences = {
    session_start_time: '07:00:00',
    session_duration_minutes: 60,
    day_overrides: {},
    color_scheme: '9',
  };

  const tz = 'Europe/Paris';

  it('produces a complete event body', () => {
    const ev = projectPlanToEvent(plan, prefs, tz);
    assert.equal(ev.summary, '🏋️ Push');
    assert.ok(ev.description.includes('bench press'));
    assert.equal(ev.start.dateTime, '2026-04-16T07:00:00');
    assert.equal(ev.start.timeZone, 'Europe/Paris');
    assert.equal(ev.end.dateTime, '2026-04-16T08:00:00');
    assert.equal(ev.end.timeZone, 'Europe/Paris');
    assert.equal(ev.colorId, '9');
  });

  it('omits colorId when color_scheme is null', () => {
    const ev = projectPlanToEvent(plan, { ...prefs, color_scheme: null }, tz);
    assert.equal(ev.colorId, undefined);
  });

  it('applies day_overrides to start time and duration', () => {
    // 2026-04-13 = Monday (1)
    const mondayPlan = { ...plan, date: '2026-04-13' };
    const prefsWithOverride: TrainingPreferences = {
      ...prefs,
      day_overrides: { '1': { start: '06:00', minutes: 90 } },
    };
    const ev = projectPlanToEvent(mondayPlan, prefsWithOverride, tz);
    assert.equal(ev.start.dateTime, '2026-04-13T06:00:00');
    assert.equal(ev.end.dateTime, '2026-04-13T07:30:00');
  });
});

// =====================================================================
// checksumEvent
// =====================================================================

describe('checksumEvent', () => {
  const body: GoogleEventBody = {
    summary: '🏋️ Push',
    description: 'bench press',
    start: { dateTime: '2026-04-16T07:00:00', timeZone: 'UTC' },
    end: { dateTime: '2026-04-16T08:00:00', timeZone: 'UTC' },
  };

  it('returns a 40-char hex SHA-1', () => {
    const h = checksumEvent(body);
    assert.equal(h.length, 40);
    assert.ok(/^[0-9a-f]+$/.test(h));
  });

  it('is deterministic', () => {
    assert.equal(checksumEvent(body), checksumEvent(body));
  });

  it('changes when any field changes', () => {
    const h1 = checksumEvent(body);
    const h2 = checksumEvent({ ...body, summary: '🏋️ Pull' });
    assert.notEqual(h1, h2);

    const h3 = checksumEvent({ ...body, colorId: '5' });
    assert.notEqual(h1, h3);
  });
});
