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
  buildWindowPlanForDate,
  indexWindowsByDate,
  resolveWindowStrategy,
  resolvePatternForPhase,
  type ActiveWindow,
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

// -------- resolvePatternForPhase + per-phase patterns ----------------
// P1.1 introduces per-phase weekly patterns via a Map<phase_id, WeeklyPattern>
// resolver. The existing WeeklyPattern-shaped signature still works for
// legacy callers and tests above.

describe('resolvePatternForPhase', () => {
  it('returns the pattern for a matching phase id from a Map', () => {
    const map = new Map<string, WeeklyPattern>([
      ['p2', { MO: { type: 'gym', day_code: 'push' } }],
      ['p3', { MO: { type: 'run', day_code: 'easy_run' } }],
    ]);
    assert.deepEqual(resolvePatternForPhase(map, 'p2'), {
      MO: { type: 'gym', day_code: 'push' },
    });
    assert.deepEqual(resolvePatternForPhase(map, 'p3'), {
      MO: { type: 'run', day_code: 'easy_run' },
    });
  });

  it('returns null when the Map has no entry for the phase', () => {
    const map = new Map<string, WeeklyPattern>([
      ['p2', { MO: { type: 'gym', day_code: 'push' } }],
    ]);
    assert.equal(resolvePatternForPhase(map, 'p3'), null);
  });

  it('treats a plain WeeklyPattern object as a shared pattern', () => {
    const pattern: WeeklyPattern = { MO: { type: 'gym', day_code: 'push' } };
    assert.deepEqual(resolvePatternForPhase(pattern, 'any-phase'), pattern);
  });
});

describe('buildPlanForDate with per-phase map resolver', () => {
  const PATTERN_P2: WeeklyPattern = {
    MO: { type: 'gym', day_code: 'push' },
    SU: { type: 'rest', day_code: null },
  };
  const PATTERN_P3: WeeklyPattern = {
    MO: { type: 'run', day_code: 'easy_run' },
    SU: { type: 'rest', day_code: null },
  };
  const resolver = new Map<string, WeeklyPattern>([
    ['p2', PATTERN_P2],
    ['p3', PATTERN_P3],
  ]);

  const base = {
    userId: 'u1',
    phases: [PHASE_P2, PHASE_P3],
    eventsByPhaseDay: EVENTS,
  };

  it('uses the P2 pattern for dates inside P2', () => {
    // 2026-04-13 is a Monday inside P2 → gym push
    const row = buildPlanForDate({ ...base, iso: '2026-04-13', weeklyPattern: resolver });
    assert.ok(row);
    assert.equal(row!.type, 'gym');
    assert.equal(row!.day_code, 'push');
    assert.equal(row!.phase_id, 'p2');
  });

  it('uses the P3 pattern for dates inside P3', () => {
    // 2026-05-11 is a Monday inside P3 → run easy_run
    const row = buildPlanForDate({ ...base, iso: '2026-05-11', weeklyPattern: resolver });
    assert.ok(row);
    assert.equal(row!.type, 'run');
    assert.equal(row!.day_code, 'easy_run');
    assert.equal(row!.phase_id, 'p3');
  });

  it('returns null when the resolver has no entry for the active phase', () => {
    const sparseResolver = new Map<string, WeeklyPattern>([['p2', PATTERN_P2]]);
    // 2026-05-11 inside P3 — resolver only has p2 → null
    const row = buildPlanForDate({
      ...base,
      iso: '2026-05-11',
      weeklyPattern: sparseResolver,
    });
    assert.equal(row, null);
  });
});

describe('buildPlansForWindow with per-phase map resolver', () => {
  const PATTERN_P2: WeeklyPattern = {
    MO: { type: 'gym', day_code: 'push' },
    TU: { type: 'gym', day_code: 'pull' },
    WE: { type: 'run', day_code: 'easy_run' },
    TH: { type: 'gym', day_code: 'lower' },
    FR: { type: 'gym', day_code: 'upper_full' },
    SA: { type: 'run', day_code: 'quality_run' },
    SU: { type: 'rest', day_code: null },
  };
  // P3 is a cut phase — fewer gym days, more rest.
  const PATTERN_P3: WeeklyPattern = {
    MO: { type: 'gym', day_code: 'push' },
    WE: { type: 'rest', day_code: null },
    FR: { type: 'gym', day_code: 'lower' },
    SU: { type: 'rest', day_code: null },
  };
  const resolver = new Map<string, WeeklyPattern>([
    ['p2', PATTERN_P2],
    ['p3', PATTERN_P3],
  ]);

  it('emits rows per phase using the right pattern at the boundary', () => {
    // Start 2026-04-30 Thu through 2026-05-08 Fri.
    // P2 covers through 2026-05-02, P3 starts 2026-05-04.
    const rows = buildPlansForWindow({
      userId: 'u1',
      startIso: '2026-04-30',
      windowDays: 9,
      occupied: new Set(),
      weeklyPattern: resolver,
      phases: [PHASE_P2, PHASE_P3],
      eventsByPhaseDay: EVENTS,
    });
    // P2 days: 04-30 TH (gym lower), 05-01 FR (gym upper_full), 05-02 SA (run)
    // P3 days: 05-04 MO (gym push), 05-06 WE (rest), 05-08 FR (gym lower)
    // Missing: 05-03 SU in no phase; 05-05 TU no slot in P3; 05-07 TH no slot in P3
    const dates = rows.map((r) => r.date);
    assert.ok(dates.includes('2026-04-30'), 'expected P2 TH');
    assert.ok(dates.includes('2026-05-02'), 'expected P2 SA');
    assert.ok(!dates.includes('2026-05-03'), 'gap day excluded');
    assert.ok(dates.includes('2026-05-04'), 'expected P3 MO');
    assert.ok(!dates.includes('2026-05-05'), 'P3 has no TU slot');
    assert.ok(dates.includes('2026-05-06'), 'expected P3 WE rest');
    assert.ok(!dates.includes('2026-05-07'), 'P3 has no TH slot');
    assert.ok(dates.includes('2026-05-08'), 'expected P3 FR');
    const p3Mon = rows.find((r) => r.date === '2026-05-04')!;
    assert.equal(p3Mon.type, 'gym');
    assert.equal(p3Mon.day_code, 'push');
    const p2Thu = rows.find((r) => r.date === '2026-04-30')!;
    assert.equal(p2Thu.day_code, 'lower');
  });
});

// -------- availability windows (P1.3) --------------------------------

describe('resolveWindowStrategy', () => {
  it('travel + auto → bodyweight', () => {
    assert.equal(resolveWindowStrategy('travel', 'auto'), 'bodyweight');
  });
  it('injury + auto → rest', () => {
    assert.equal(resolveWindowStrategy('injury', 'auto'), 'rest');
  });
  it('pause + auto → rest', () => {
    assert.equal(resolveWindowStrategy('pause', 'auto'), 'rest');
  });
  it('explicit strategies override the default', () => {
    assert.equal(resolveWindowStrategy('travel', 'rest'), 'rest');
    assert.equal(resolveWindowStrategy('injury', 'bodyweight'), 'bodyweight');
    assert.equal(resolveWindowStrategy('pause', 'suppress'), 'suppress');
  });
});

describe('buildWindowPlanForDate', () => {
  const PHASE: PhaseRow = {
    id: 'p2',
    code: 'P2',
    starts_on: '2026-03-30',
    target_ends_on: '2026-05-02',
  };

  it('travel + auto → bodyweight plan row with window_id', () => {
    const w: ActiveWindow = {
      id: 'w1',
      starts_on: '2026-04-20',
      ends_on: '2026-04-27',
      kind: 'travel',
      strategy: 'auto',
      note: 'Tokyo trip',
    };
    const row = buildWindowPlanForDate({
      userId: 'u1',
      iso: '2026-04-22',
      window: w,
      phase: PHASE,
    });
    assert.ok(row);
    assert.equal(row!.type, 'bodyweight');
    assert.equal(row!.source, 'availability_window');
    assert.equal(row!.window_id, 'w1');
    assert.equal(row!.phase_id, 'p2');
    assert.equal(row!.calendar_event_id, null);
    assert.ok(row!.ai_rationale?.includes('Tokyo trip'));
  });

  it('injury + auto → rest plan row', () => {
    const w: ActiveWindow = {
      id: 'w2',
      starts_on: '2026-04-20',
      ends_on: '2026-04-27',
      kind: 'injury',
      strategy: 'auto',
      note: 'achilles',
    };
    const row = buildWindowPlanForDate({
      userId: 'u1',
      iso: '2026-04-22',
      window: w,
      phase: PHASE,
    });
    assert.ok(row);
    assert.equal(row!.type, 'rest');
    assert.equal(row!.source, 'availability_window');
  });

  it('pause + suppress → null (no row emitted)', () => {
    const w: ActiveWindow = {
      id: 'w3',
      starts_on: '2026-04-20',
      ends_on: '2026-04-27',
      kind: 'pause',
      strategy: 'suppress',
      note: null,
    };
    const row = buildWindowPlanForDate({
      userId: 'u1',
      iso: '2026-04-22',
      window: w,
      phase: PHASE,
    });
    assert.equal(row, null);
  });

  it('works with a null phase (window outside any phase)', () => {
    const w: ActiveWindow = {
      id: 'w4',
      starts_on: '2026-04-20',
      ends_on: '2026-04-27',
      kind: 'travel',
      strategy: 'auto',
      note: null,
    };
    const row = buildWindowPlanForDate({
      userId: 'u1',
      iso: '2026-04-22',
      window: w,
      phase: null,
    });
    assert.ok(row);
    assert.equal(row!.phase_id, null);
  });
});

describe('indexWindowsByDate', () => {
  it('populates every covered date inside the requested range', () => {
    const w: ActiveWindow = {
      id: 'w1',
      starts_on: '2026-04-20',
      ends_on: '2026-04-22',
      kind: 'travel',
      strategy: 'auto',
      note: null,
    };
    const map = indexWindowsByDate({
      windows: [w],
      rangeStart: '2026-04-15',
      rangeEnd: '2026-05-05',
    });
    assert.equal(map.size, 3);
    assert.ok(map.has('2026-04-20'));
    assert.ok(map.has('2026-04-21'));
    assert.ok(map.has('2026-04-22'));
    assert.ok(!map.has('2026-04-19'));
    assert.ok(!map.has('2026-04-23'));
  });

  it('clips to the requested range', () => {
    const w: ActiveWindow = {
      id: 'w1',
      starts_on: '2026-04-10',
      ends_on: '2026-04-30',
      kind: 'pause',
      strategy: 'auto',
      note: null,
    };
    const map = indexWindowsByDate({
      windows: [w],
      rangeStart: '2026-04-15',
      rangeEnd: '2026-04-20',
    });
    assert.equal(map.size, 6);
    assert.ok(!map.has('2026-04-14'));
    assert.ok(!map.has('2026-04-21'));
  });

  it('skips windows that do not overlap the range', () => {
    const w: ActiveWindow = {
      id: 'w1',
      starts_on: '2026-04-01',
      ends_on: '2026-04-05',
      kind: 'travel',
      strategy: 'auto',
      note: null,
    };
    const map = indexWindowsByDate({
      windows: [w],
      rangeStart: '2026-04-15',
      rangeEnd: '2026-04-20',
    });
    assert.equal(map.size, 0);
  });

  it('precedence: pause beats injury beats travel', () => {
    const travel: ActiveWindow = {
      id: 'wt', starts_on: '2026-04-20', ends_on: '2026-04-25',
      kind: 'travel', strategy: 'auto', note: null,
    };
    const injury: ActiveWindow = {
      id: 'wi', starts_on: '2026-04-22', ends_on: '2026-04-27',
      kind: 'injury', strategy: 'auto', note: null,
    };
    const pause: ActiveWindow = {
      id: 'wp', starts_on: '2026-04-24', ends_on: '2026-04-26',
      kind: 'pause', strategy: 'auto', note: null,
    };
    const map = indexWindowsByDate({
      windows: [travel, injury, pause],
      rangeStart: '2026-04-20',
      rangeEnd: '2026-04-27',
    });
    // Overlap day covered by all three → pause wins.
    assert.equal(map.get('2026-04-24')?.id, 'wp');
    assert.equal(map.get('2026-04-25')?.id, 'wp');
    // Injury only (travel ends Apr 25, pause starts Apr 24): Apr 26, 27
    assert.equal(map.get('2026-04-26')?.id, 'wp');
    assert.equal(map.get('2026-04-27')?.id, 'wi');
    // Travel only: Apr 20, 21
    assert.equal(map.get('2026-04-20')?.id, 'wt');
    assert.equal(map.get('2026-04-21')?.id, 'wt');
  });

  it('same-kind tie: rest beats bodyweight beats suppress', () => {
    const a: ActiveWindow = {
      id: 'a', starts_on: '2026-04-20', ends_on: '2026-04-22',
      kind: 'travel', strategy: 'bodyweight', note: null,
    };
    const b: ActiveWindow = {
      id: 'b', starts_on: '2026-04-20', ends_on: '2026-04-22',
      kind: 'travel', strategy: 'rest', note: null,
    };
    const map = indexWindowsByDate({
      windows: [a, b],
      rangeStart: '2026-04-20',
      rangeEnd: '2026-04-22',
    });
    assert.equal(map.get('2026-04-21')?.id, 'b');
  });
});

describe('buildPlanForDate with windows', () => {
  const PHASE_P2: PhaseRow = {
    id: 'p2', code: 'P2',
    starts_on: '2026-03-30', target_ends_on: '2026-05-02',
  };
  const PATTERN: WeeklyPattern = {
    MO: { type: 'gym', day_code: 'push' },
    TU: { type: 'gym', day_code: 'pull' },
  };
  const EV = new Map<string, CalendarEventRow>([
    ['p2:push', { id: 'ev1', phase_id: 'p2', day_code: 'push', summary: 'Push', prescription: {} }],
  ]);

  it('window override beats the template on a covered date', () => {
    // 2026-04-20 is a Monday — would normally be a "push" gym day.
    const w: ActiveWindow = {
      id: 'w1', starts_on: '2026-04-20', ends_on: '2026-04-22',
      kind: 'travel', strategy: 'auto', note: 'trip',
    };
    const windowsByDate = indexWindowsByDate({
      windows: [w], rangeStart: '2026-04-15', rangeEnd: '2026-05-05',
    });
    const row = buildPlanForDate({
      userId: 'u1',
      iso: '2026-04-20',
      weeklyPattern: PATTERN,
      phases: [PHASE_P2],
      eventsByPhaseDay: EV,
      windowsByDate,
    });
    assert.ok(row);
    assert.equal(row!.type, 'bodyweight');
    assert.equal(row!.source, 'availability_window');
    assert.equal(row!.day_code, null);
    assert.equal(row!.window_id, 'w1');
  });

  it('template is used when the date is not covered', () => {
    const windowsByDate = indexWindowsByDate({
      windows: [],
      rangeStart: '2026-04-15', rangeEnd: '2026-05-05',
    });
    const row = buildPlanForDate({
      userId: 'u1',
      iso: '2026-04-20', // Monday
      weeklyPattern: PATTERN,
      phases: [PHASE_P2],
      eventsByPhaseDay: EV,
      windowsByDate,
    });
    assert.ok(row);
    assert.equal(row!.type, 'gym');
    assert.equal(row!.source, 'template');
  });

  it('suppress strategy → null on covered date (no row written)', () => {
    const w: ActiveWindow = {
      id: 'w1', starts_on: '2026-04-20', ends_on: '2026-04-22',
      kind: 'pause', strategy: 'suppress', note: null,
    };
    const windowsByDate = indexWindowsByDate({
      windows: [w], rangeStart: '2026-04-15', rangeEnd: '2026-05-05',
    });
    const row = buildPlanForDate({
      userId: 'u1',
      iso: '2026-04-20',
      weeklyPattern: PATTERN,
      phases: [PHASE_P2],
      eventsByPhaseDay: EV,
      windowsByDate,
    });
    assert.equal(row, null);
  });

  it('window can emit outside any phase (user-level declaration)', () => {
    const w: ActiveWindow = {
      id: 'w1', starts_on: '2026-06-01', ends_on: '2026-06-05',
      kind: 'travel', strategy: 'auto', note: null,
    };
    const windowsByDate = indexWindowsByDate({
      windows: [w], rangeStart: '2026-05-20', rangeEnd: '2026-06-20',
    });
    // 2026-06-02 is outside P2 (which ends 2026-05-02).
    const row = buildPlanForDate({
      userId: 'u1',
      iso: '2026-06-02',
      weeklyPattern: PATTERN,
      phases: [PHASE_P2],
      eventsByPhaseDay: EV,
      windowsByDate,
    });
    assert.ok(row, 'window should emit even with no active phase');
    assert.equal(row!.type, 'bodyweight');
    assert.equal(row!.phase_id, null);
  });
});

describe('buildPlansForWindow with availability windows', () => {
  const PHASE: PhaseRow = {
    id: 'p2', code: 'P2',
    starts_on: '2026-03-30', target_ends_on: '2026-05-02',
  };
  const PATTERN: WeeklyPattern = {
    MO: { type: 'gym', day_code: 'push' },
    WE: { type: 'gym', day_code: 'pull' },
    SU: { type: 'rest', day_code: null },
  };

  it('rewrites plans inside the window and leaves others as template', () => {
    const w: ActiveWindow = {
      id: 'trip', starts_on: '2026-04-20', ends_on: '2026-04-24',
      kind: 'travel', strategy: 'auto', note: 'Berlin',
    };
    const windowsByDate = indexWindowsByDate({
      windows: [w], rangeStart: '2026-04-15', rangeEnd: '2026-05-06',
    });
    const rows = buildPlansForWindow({
      userId: 'u1',
      startIso: '2026-04-15', // Wednesday
      windowDays: 21,
      occupied: new Set(),
      weeklyPattern: PATTERN,
      phases: [PHASE],
      eventsByPhaseDay: new Map(),
      windowsByDate,
    });
    // Apr 20-24 covered by window → bodyweight, 5 rows (one per day) regardless of DOW.
    const windowRows = rows.filter(r => r.source === 'availability_window');
    assert.equal(windowRows.length, 5);
    for (const r of windowRows) {
      assert.equal(r.type, 'bodyweight');
      assert.equal(r.window_id, 'trip');
    }
    // Template rows only on MO/WE/SU (per PATTERN) outside Apr 20-24.
    const tmplRows = rows.filter(r => r.source === 'template');
    for (const r of tmplRows) {
      assert.ok(r.date < '2026-04-20' || r.date > '2026-04-24');
    }
    // Apr 22 (Wed, normally 'pull') is inside the window → bodyweight, not gym.
    const apr22 = rows.find(r => r.date === '2026-04-22');
    assert.ok(apr22);
    assert.equal(apr22!.type, 'bodyweight');
  });

  it('respects occupied set — no duplicate when a plan already exists', () => {
    const w: ActiveWindow = {
      id: 'w1', starts_on: '2026-04-20', ends_on: '2026-04-22',
      kind: 'travel', strategy: 'auto', note: null,
    };
    const windowsByDate = indexWindowsByDate({
      windows: [w], rangeStart: '2026-04-15', rangeEnd: '2026-05-06',
    });
    const rows = buildPlansForWindow({
      userId: 'u1',
      startIso: '2026-04-15',
      windowDays: 21,
      occupied: new Set(['2026-04-20']),
      weeklyPattern: PATTERN,
      phases: [PHASE],
      eventsByPhaseDay: new Map(),
      windowsByDate,
    });
    assert.ok(!rows.some(r => r.date === '2026-04-20'));
  });

  it('suppress strategy writes no rows inside the window', () => {
    const w: ActiveWindow = {
      id: 'w1', starts_on: '2026-04-20', ends_on: '2026-04-22',
      kind: 'pause', strategy: 'suppress', note: null,
    };
    const windowsByDate = indexWindowsByDate({
      windows: [w], rangeStart: '2026-04-15', rangeEnd: '2026-05-06',
    });
    const rows = buildPlansForWindow({
      userId: 'u1',
      startIso: '2026-04-15',
      windowDays: 21,
      occupied: new Set(),
      weeklyPattern: PATTERN,
      phases: [PHASE],
      eventsByPhaseDay: new Map(),
      windowsByDate,
    });
    for (const r of rows) {
      assert.ok(r.date < '2026-04-20' || r.date > '2026-04-22',
        `no row inside suppress window, got ${r.date}`);
    }
  });
});
