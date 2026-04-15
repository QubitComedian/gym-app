/**
 * Unit tests for the pure pieces of the roll-forward pass.
 *
 * Run via:
 *   npx tsx --test src/lib/reconcile/rollForward.test.ts
 *
 * The DB-facing wrapper in rollForward.ts is covered by integration
 * tests (PR-D). Here we exercise the date math and plan-row construction
 * in isolation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DOW_CODES,
  dowCodeOf,
  addDaysIso,
  datesFrom,
  activePhaseFor,
  buildPlanForDate,
  buildPlansForWindow,
  type CalendarEventRow,
  type PhaseRow,
  type WeeklyPattern,
} from './rollForward.pure';

// -------- pattern + phases (shared fixtures) -------------------------

const WEEKLY_PATTERN: WeeklyPattern = {
  MO: { type: 'gym', day_code: 'push' },
  TU: { type: 'gym', day_code: 'pull' },
  WE: { type: 'run', day_code: 'easy_run' },
  TH: { type: 'gym', day_code: 'lower' },
  FR: { type: 'gym', day_code: 'upper_full' },
  SA: { type: 'run', day_code: 'quality_run' },
  SU: { type: 'rest', day_code: null },
};

const PHASE_P2: PhaseRow = {
  id: 'p2',
  code: 'P2',
  starts_on: '2026-03-30',
  target_ends_on: '2026-05-02',
};
const PHASE_P3: PhaseRow = {
  id: 'p3',
  code: 'P3',
  starts_on: '2026-05-04',
  target_ends_on: '2026-06-28',
};

const EVENTS = new Map<string, CalendarEventRow>([
  [
    'p2:push',
    {
      id: 'ev-p2-push',
      phase_id: 'p2',
      day_code: 'push',
      summary: 'P2 Push',
      prescription: { blocks: ['incline_db_press'] },
    },
  ],
  [
    'p3:push',
    {
      id: 'ev-p3-push',
      phase_id: 'p3',
      day_code: 'push',
      summary: 'P3 Push',
      prescription: { blocks: ['superset_push'] },
    },
  ],
]);

// -------- DOW_CODES + dowCodeOf --------------------------------------

describe('DOW_CODES', () => {
  it('matches JS getUTCDay() indices', () => {
    assert.equal(DOW_CODES[0], 'SU');
    assert.equal(DOW_CODES[6], 'SA');
    assert.equal(DOW_CODES.length, 7);
  });
});

describe('dowCodeOf', () => {
  it('returns WE for 2026-04-15', () => {
    assert.equal(dowCodeOf('2026-04-15'), 'WE');
  });

  it('covers every day of a week correctly', () => {
    // 2026-04-13 Mon → 2026-04-19 Sun
    assert.equal(dowCodeOf('2026-04-13'), 'MO');
    assert.equal(dowCodeOf('2026-04-14'), 'TU');
    assert.equal(dowCodeOf('2026-04-15'), 'WE');
    assert.equal(dowCodeOf('2026-04-16'), 'TH');
    assert.equal(dowCodeOf('2026-04-17'), 'FR');
    assert.equal(dowCodeOf('2026-04-18'), 'SA');
    assert.equal(dowCodeOf('2026-04-19'), 'SU');
  });

  it('throws on malformed input', () => {
    assert.throws(() => dowCodeOf('garbage'));
    assert.throws(() => dowCodeOf(''));
  });
});

// -------- addDaysIso + datesFrom -------------------------------------

describe('addDaysIso', () => {
  it('handles positive offsets', () => {
    assert.equal(addDaysIso('2026-04-15', 1), '2026-04-16');
    assert.equal(addDaysIso('2026-04-15', 21), '2026-05-06');
  });

  it('handles zero', () => {
    assert.equal(addDaysIso('2026-04-15', 0), '2026-04-15');
  });

  it('handles negative offsets', () => {
    assert.equal(addDaysIso('2026-04-15', -1), '2026-04-14');
  });

  it('rolls over month boundaries', () => {
    assert.equal(addDaysIso('2026-04-30', 1), '2026-05-01');
    assert.equal(addDaysIso('2026-01-31', 1), '2026-02-01');
  });

  it('rolls over year boundaries', () => {
    assert.equal(addDaysIso('2026-12-31', 1), '2027-01-01');
  });

  it('handles leap-year Feb 29', () => {
    // 2028 is a leap year.
    assert.equal(addDaysIso('2028-02-28', 1), '2028-02-29');
    assert.equal(addDaysIso('2028-02-29', 1), '2028-03-01');
    // 2026 is not a leap year.
    assert.equal(addDaysIso('2026-02-28', 1), '2026-03-01');
  });
});

describe('datesFrom', () => {
  it('returns exactly windowDays entries starting at start', () => {
    const got = datesFrom('2026-04-15', 21);
    assert.equal(got.length, 21);
    assert.equal(got[0], '2026-04-15');
    assert.equal(got[20], '2026-05-05');
  });

  it('returns empty for windowDays=0', () => {
    assert.deepEqual(datesFrom('2026-04-15', 0), []);
  });
});

// -------- activePhaseFor ---------------------------------------------

describe('activePhaseFor', () => {
  const phases = [PHASE_P2, PHASE_P3];

  it('finds P2 for dates inside P2', () => {
    assert.equal(activePhaseFor('2026-04-15', phases)?.code, 'P2');
    assert.equal(activePhaseFor('2026-03-30', phases)?.code, 'P2'); // starts_on inclusive
    assert.equal(activePhaseFor('2026-05-02', phases)?.code, 'P2'); // target_ends_on inclusive
  });

  it('finds P3 for dates inside P3', () => {
    assert.equal(activePhaseFor('2026-05-04', phases)?.code, 'P3');
    assert.equal(activePhaseFor('2026-06-28', phases)?.code, 'P3');
  });

  it('returns null for dates before any phase', () => {
    assert.equal(activePhaseFor('2026-01-01', phases), null);
  });

  it('returns null for dates in the P2→P3 gap (2026-05-03)', () => {
    assert.equal(activePhaseFor('2026-05-03', phases), null);
  });

  it('returns null for dates after the last phase', () => {
    assert.equal(activePhaseFor('2026-06-29', phases), null);
  });

  it('handles open-ended phases (null target_ends_on)', () => {
    const openPhase: PhaseRow = {
      id: 'p4',
      code: 'P4',
      starts_on: '2026-07-01',
      target_ends_on: null,
    };
    assert.equal(activePhaseFor('2027-01-01', [openPhase])?.code, 'P4');
  });
});

// -------- buildPlanForDate -------------------------------------------

describe('buildPlanForDate', () => {
  const base = {
    userId: 'u1',
    weeklyPattern: WEEKLY_PATTERN,
    phases: [PHASE_P2, PHASE_P3],
    eventsByPhaseDay: EVENTS,
  };

  it('builds a training plan with prescription when the event exists', () => {
    const row = buildPlanForDate({ ...base, iso: '2026-04-13' }); // MO in P2
    assert.ok(row);
    assert.equal(row!.type, 'gym');
    assert.equal(row!.day_code, 'push');
    assert.equal(row!.phase_id, 'p2');
    assert.equal(row!.calendar_event_id, 'ev-p2-push');
    assert.equal(row!.status, 'planned');
    assert.equal(row!.source, 'template');
    assert.deepEqual(row!.prescription, { blocks: ['incline_db_press'] });
    assert.match(row!.ai_rationale!, /P2/);
  });

  it('builds a placeholder when no event matches (phase, day_code)', () => {
    // TU in P2 → day_code='pull'. No event seeded for 'p2:pull'.
    const row = buildPlanForDate({ ...base, iso: '2026-04-14' });
    assert.ok(row);
    assert.equal(row!.calendar_event_id, null);
    assert.deepEqual(row!.prescription, {});
    assert.match(row!.ai_rationale!, /no calendar template/i);
  });

  it('builds a rest plan for Sunday', () => {
    // SU → slot.type='rest', day_code=null
    const row = buildPlanForDate({ ...base, iso: '2026-04-19' });
    assert.ok(row);
    assert.equal(row!.type, 'rest');
    assert.equal(row!.day_code, null);
    assert.deepEqual(row!.prescription, {});
    assert.equal(row!.calendar_event_id, null);
  });

  it('returns null when the date is outside any phase', () => {
    const row = buildPlanForDate({ ...base, iso: '2026-05-03' }); // gap
    assert.equal(row, null);
  });

  it('returns null when the weekly pattern has no slot for that DOW', () => {
    const sparse: WeeklyPattern = { MO: { type: 'gym', day_code: 'push' } };
    const row = buildPlanForDate({
      ...base,
      weeklyPattern: sparse,
      iso: '2026-04-15', // WE — not in sparse pattern
    });
    assert.equal(row, null);
  });

  it('picks the correct event when the same day_code exists in multiple phases', () => {
    // 2026-05-11 is Monday, inside P3 → should pick p3:push.
    const row = buildPlanForDate({ ...base, iso: '2026-05-11' });
    assert.ok(row);
    assert.equal(row!.phase_id, 'p3');
    assert.equal(row!.calendar_event_id, 'ev-p3-push');
    assert.deepEqual(row!.prescription, { blocks: ['superset_push'] });
  });
});

// -------- buildPlansForWindow ----------------------------------------

describe('buildPlansForWindow', () => {
  const base = {
    userId: 'u1',
    weeklyPattern: WEEKLY_PATTERN,
    phases: [PHASE_P2, PHASE_P3],
    eventsByPhaseDay: EVENTS,
  };

  it('produces one row per day in the window when all dates are free', () => {
    const rows = buildPlansForWindow({
      ...base,
      startIso: '2026-04-15',
      windowDays: 7,
      occupied: new Set(),
    });
    // WE→TU — 7 days, all inside P2, all slots covered → 7 rows.
    assert.equal(rows.length, 7);
    assert.equal(rows[0]!.date, '2026-04-15');
    assert.equal(rows[6]!.date, '2026-04-21');
  });

  it('skips occupied dates', () => {
    const rows = buildPlansForWindow({
      ...base,
      startIso: '2026-04-15',
      windowDays: 7,
      occupied: new Set(['2026-04-15', '2026-04-17']),
    });
    assert.equal(rows.length, 5);
    assert.ok(!rows.some((r) => r.date === '2026-04-15'));
    assert.ok(!rows.some((r) => r.date === '2026-04-17'));
  });

  it('stops at phase boundaries (skips dates outside any phase)', () => {
    // Start just before the P2→P3 gap. 2026-05-01 Fri through 2026-05-07 Thu.
    // P2 ends 2026-05-02, P3 starts 2026-05-04 → 2026-05-03 is a gap day.
    const rows = buildPlansForWindow({
      ...base,
      startIso: '2026-05-01',
      windowDays: 7,
      occupied: new Set(),
    });
    assert.ok(!rows.some((r) => r.date === '2026-05-03'));
    // The other 6 days should all be covered.
    assert.equal(rows.length, 6);
  });

  it('returns empty when every date is occupied', () => {
    const occupied = new Set(
      Array.from({ length: 21 }, (_, i) => addDaysIso('2026-04-15', i))
    );
    const rows = buildPlansForWindow({
      ...base,
      startIso: '2026-04-15',
      windowDays: 21,
      occupied,
    });
    assert.equal(rows.length, 0);
  });

  it('returns empty when no phase covers the window', () => {
    const rows = buildPlansForWindow({
      ...base,
      startIso: '2027-01-01',
      windowDays: 21,
      occupied: new Set(),
    });
    assert.equal(rows.length, 0);
  });

  it('assigns phase_id on every returned row', () => {
    const rows = buildPlansForWindow({
      ...base,
      startIso: '2026-04-15',
      windowDays: 21,
      occupied: new Set(),
    });
    for (const r of rows) {
      assert.ok(r.phase_id, `row for ${r.date} missing phase_id`);
    }
  });

  it('marks every row with source=template and status=planned', () => {
    const rows = buildPlansForWindow({
      ...base,
      startIso: '2026-04-15',
      windowDays: 14,
      occupied: new Set(),
    });
    for (const r of rows) {
      assert.equal(r.source, 'template');
      assert.equal(r.status, 'planned');
    }
  });
});
