/**
 * Unit tests for the pure pieces of the drop-off pass.
 *
 * Run via:
 *   npm test
 *   or: npx tsx --test src/lib/reconcile/dropOff.test.ts
 *
 * Covers the gap math, tier classification, pattern rotation, deload
 * decoration, and all four option diff builders plus the main composer.
 * The DB-facing detectDropOff is covered by integration tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DROP_OFF_THRESHOLD_DAYS,
  HARD_GAP_MAX_DAYS,
  REENTRY_FULL_DAYS,
  REENTRY_SOFT_DAYS,
  SHIFT_WEEK_DAYS,
  SOFT_GAP_MAX_DAYS,
  buildJumpBackInDiff,
  buildReassessDiff,
  buildReentryDiff,
  buildReturnFromGapDiff,
  buildShiftWeekDiff,
  classifyGap,
  computeGapDays,
  daysBetweenIso,
  decorateWithDeload,
  rotateWeeklyPattern,
} from './dropOff.pure';
import type {
  CalendarEventRow,
  PhaseRow,
  WeeklyPattern,
} from './rollForward.pure';

// -------- fixtures ---------------------------------------------------

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
  target_ends_on: '2026-05-31',
};

const EVENTS = new Map<string, CalendarEventRow>([
  [
    'p2:push',
    {
      id: 'ev-push',
      phase_id: 'p2',
      day_code: 'push',
      summary: 'P2 Push',
      prescription: { blocks: ['incline_db_press'] },
    },
  ],
  [
    'p2:pull',
    {
      id: 'ev-pull',
      phase_id: 'p2',
      day_code: 'pull',
      summary: 'P2 Pull',
      prescription: { blocks: ['row'] },
    },
  ],
  [
    'p2:lower',
    {
      id: 'ev-lower',
      phase_id: 'p2',
      day_code: 'lower',
      summary: 'P2 Lower',
      prescription: { blocks: ['squat'] },
    },
  ],
]);

const makeCtx = (overrides: Partial<Parameters<typeof buildShiftWeekDiff>[0]> = {}) => ({
  userId: 'u1',
  todayIso: '2026-04-15', // Wednesday
  weeklyPattern: WEEKLY_PATTERN,
  phases: [PHASE_P2],
  eventsByPhaseDay: EVENTS,
  plansByDate: new Map<string, { id: string; status: string }>(),
  ...overrides,
});

// -------- daysBetweenIso --------------------------------------------

describe('daysBetweenIso', () => {
  it('returns 0 for same day', () => {
    assert.equal(daysBetweenIso('2026-04-15', '2026-04-15'), 0);
  });

  it('returns positive when b is later', () => {
    assert.equal(daysBetweenIso('2026-04-10', '2026-04-15'), 5);
  });

  it('returns negative when b is earlier', () => {
    assert.equal(daysBetweenIso('2026-04-15', '2026-04-10'), -5);
  });

  it('handles month boundaries', () => {
    assert.equal(daysBetweenIso('2026-04-28', '2026-05-03'), 5);
  });

  it('handles year boundaries', () => {
    assert.equal(daysBetweenIso('2026-12-28', '2027-01-04'), 7);
  });

  it('handles leap years (2028)', () => {
    assert.equal(daysBetweenIso('2028-02-27', '2028-03-01'), 3);
  });

  it('throws on malformed input', () => {
    assert.throws(() => daysBetweenIso('bogus', '2026-04-15'));
    assert.throws(() => daysBetweenIso('2026-04-15', ''));
  });
});

// -------- computeGapDays --------------------------------------------

describe('computeGapDays', () => {
  it('returns null when no last-done date', () => {
    assert.equal(computeGapDays('2026-04-15', null), null);
  });

  it('returns positive gap in normal case', () => {
    assert.equal(computeGapDays('2026-04-15', '2026-04-10'), 5);
  });

  it('clamps future last-done (clock skew) to 0', () => {
    // Activity logged "in the future" — treat as no gap.
    assert.equal(computeGapDays('2026-04-15', '2026-04-20'), 0);
  });

  it('returns 0 when last-done is today', () => {
    assert.equal(computeGapDays('2026-04-15', '2026-04-15'), 0);
  });
});

// -------- classifyGap ------------------------------------------------

describe('classifyGap', () => {
  it('null → none', () => {
    assert.equal(classifyGap(null), 'none');
  });

  it('below threshold → none', () => {
    assert.equal(classifyGap(0), 'none');
    assert.equal(classifyGap(1), 'none');
    assert.equal(classifyGap(DROP_OFF_THRESHOLD_DAYS - 1), 'none');
  });

  it('at threshold → soft', () => {
    assert.equal(classifyGap(DROP_OFF_THRESHOLD_DAYS), 'soft');
  });

  it('throughout soft window → soft', () => {
    assert.equal(classifyGap(3), 'soft');
    assert.equal(classifyGap(4), 'soft');
    assert.equal(classifyGap(5), 'soft');
    assert.equal(classifyGap(SOFT_GAP_MAX_DAYS), 'soft');
  });

  it('just past soft → hard', () => {
    assert.equal(classifyGap(SOFT_GAP_MAX_DAYS + 1), 'hard');
  });

  it('throughout hard window → hard', () => {
    assert.equal(classifyGap(7), 'hard');
    assert.equal(classifyGap(10), 'hard');
    assert.equal(classifyGap(HARD_GAP_MAX_DAYS), 'hard');
  });

  it('just past hard → hard_extended', () => {
    assert.equal(classifyGap(HARD_GAP_MAX_DAYS + 1), 'hard_extended');
  });

  it('very long gaps → hard_extended', () => {
    assert.equal(classifyGap(30), 'hard_extended');
    assert.equal(classifyGap(365), 'hard_extended');
  });
});

// -------- rotateWeeklyPattern ---------------------------------------

describe('rotateWeeklyPattern', () => {
  it('rotates so startDow plays Monday slot', () => {
    // startDow=FR → FR gets MO's slot (push), SA gets TU's (pull), etc.
    const rotated = rotateWeeklyPattern('FR', WEEKLY_PATTERN);
    assert.deepEqual(rotated.FR, WEEKLY_PATTERN.MO);
    assert.deepEqual(rotated.SA, WEEKLY_PATTERN.TU);
    assert.deepEqual(rotated.SU, WEEKLY_PATTERN.WE);
    assert.deepEqual(rotated.MO, WEEKLY_PATTERN.TH);
    assert.deepEqual(rotated.TU, WEEKLY_PATTERN.FR);
    assert.deepEqual(rotated.WE, WEEKLY_PATTERN.SA);
    assert.deepEqual(rotated.TH, WEEKLY_PATTERN.SU);
  });

  it('is identity when startDow is MO', () => {
    const rotated = rotateWeeklyPattern('MO', WEEKLY_PATTERN);
    assert.deepEqual(rotated, WEEKLY_PATTERN);
  });

  it('preserves null / missing pattern slots', () => {
    const sparse: WeeklyPattern = {
      MO: { type: 'gym', day_code: 'push' },
      WE: { type: 'rest', day_code: null },
    };
    const rotated = rotateWeeklyPattern('WE', sparse);
    // WE takes MO's slot (push), FR takes WE's (rest), the rest are empty.
    assert.deepEqual(rotated.WE, { type: 'gym', day_code: 'push' });
    assert.deepEqual(rotated.FR, { type: 'rest', day_code: null });
    assert.equal(rotated.MO, undefined);
    assert.equal(rotated.TU, undefined);
  });
});

// -------- decorateWithDeload ----------------------------------------

describe('decorateWithDeload', () => {
  it('adds soft deload to an object prescription without mutating it', () => {
    const original = { blocks: ['bench', 'row'] };
    const decorated = decorateWithDeload(original, 'soft') as Record<string, unknown>;
    assert.deepEqual(original, { blocks: ['bench', 'row'] }); // unchanged
    assert.deepEqual(decorated.blocks, ['bench', 'row']);
    assert.equal((decorated.deload as { kind: string }).kind, 'soft');
    assert.match((decorated.deload as { rule: string }).rule, /10|15/);
  });

  it('adds full deload with a different rule text', () => {
    const decorated = decorateWithDeload({ x: 1 }, 'full') as Record<string, unknown>;
    assert.equal((decorated.deload as { kind: string }).kind, 'full');
    assert.match((decorated.deload as { rule: string }).rule, /20|25/);
  });

  it('handles null / non-object prescriptions', () => {
    const decorated = decorateWithDeload(null, 'soft') as Record<string, unknown>;
    assert.equal((decorated.deload as { kind: string }).kind, 'soft');
  });
});

// -------- buildShiftWeekDiff ----------------------------------------

describe('buildShiftWeekDiff', () => {
  it('creates SHIFT_WEEK_DAYS rows starting today', () => {
    const diff = buildShiftWeekDiff(makeCtx());
    // 7 days starting 2026-04-15 WE, all inside P2 → 7 rows.
    assert.equal(diff.creates.length, SHIFT_WEEK_DAYS);
    assert.equal(diff.updates.length, 0);
    assert.equal(diff.deletes.length, 0);
  });

  it('queues deletes for existing planned rows on overlapping dates', () => {
    const plansByDate = new Map<string, { id: string; status: string }>([
      ['2026-04-15', { id: 'p-a', status: 'planned' }],
      ['2026-04-17', { id: 'p-b', status: 'planned' }],
      ['2026-04-18', { id: 'p-c', status: 'missed' }], // not 'planned' — leave alone
    ]);
    const diff = buildShiftWeekDiff(makeCtx({ plansByDate }));
    assert.deepEqual(diff.deletes.sort(), ['p-a', 'p-b']);
    assert.ok(!diff.deletes.includes('p-c'));
  });

  it('creates rows whose date order starts at today', () => {
    const diff = buildShiftWeekDiff(makeCtx());
    assert.equal(diff.creates[0]!.date, '2026-04-15');
    assert.equal(diff.creates[6]!.date, '2026-04-21');
  });

  it('first created row plays the Monday slot (gym push)', () => {
    // startDow=WE for today=2026-04-15 → WE plays MO's slot.
    const diff = buildShiftWeekDiff(makeCtx());
    assert.equal(diff.creates[0]!.type, 'gym');
    assert.equal(diff.creates[0]!.day_code, 'push');
  });

  it('stops at phase boundaries (rows dropped when outside any phase)', () => {
    // P2 ends 2026-05-31. Starting 2026-05-29 means 3 days in P2 + 4 outside.
    const diff = buildShiftWeekDiff(makeCtx({ todayIso: '2026-05-29' }));
    // At most the 3 in-phase dates survive; may be fewer if pattern slot missing.
    assert.ok(diff.creates.length <= 3);
  });

  it('empties creates when today is outside any phase', () => {
    const diff = buildShiftWeekDiff(makeCtx({ todayIso: '2027-01-01' }));
    assert.equal(diff.creates.length, 0);
  });
});

// -------- buildReentryDiff ------------------------------------------

describe('buildReentryDiff', () => {
  it('soft variant creates REENTRY_SOFT_DAYS rows starting tomorrow', () => {
    const diff = buildReentryDiff(makeCtx(), 'soft');
    assert.equal(diff.creates.length, REENTRY_SOFT_DAYS);
    assert.equal(diff.creates[0]!.date, '2026-04-16');
  });

  it('full variant creates REENTRY_FULL_DAYS rows', () => {
    const diff = buildReentryDiff(makeCtx(), 'full');
    assert.equal(diff.creates.length, REENTRY_FULL_DAYS);
    assert.equal(diff.creates[0]!.date, '2026-04-16');
  });

  it('decorates prescriptions with deload', () => {
    const diff = buildReentryDiff(makeCtx(), 'soft');
    // First row from today+1 = 2026-04-16 Thursday. In rotated pattern
    // starting Thu, TH plays MO's slot → gym push → has prescription blocks.
    const first = diff.creates[0]!;
    const presc = first.prescription as Record<string, unknown>;
    assert.ok(presc.deload, 'deload field expected');
    assert.equal((presc.deload as { kind: string }).kind, 'soft');
  });

  it('queues deletes for planned rows in the window (starting tomorrow)', () => {
    const plansByDate = new Map<string, { id: string; status: string }>([
      ['2026-04-15', { id: 'today-row', status: 'planned' }], // today — not touched
      ['2026-04-16', { id: 'tomorrow-row', status: 'planned' }],
      ['2026-04-20', { id: 'later-row', status: 'planned' }],
    ]);
    const diff = buildReentryDiff(makeCtx({ plansByDate }), 'soft');
    assert.ok(!diff.deletes.includes('today-row'));
    assert.ok(diff.deletes.includes('tomorrow-row'));
    assert.ok(diff.deletes.includes('later-row'));
  });
});

// -------- buildJumpBackInDiff + buildReassessDiff --------------------

describe('buildJumpBackInDiff', () => {
  it('returns an empty diff', () => {
    const diff = buildJumpBackInDiff();
    assert.equal(diff.creates.length, 0);
    assert.equal(diff.updates.length, 0);
    assert.equal(diff.deletes.length, 0);
    assert.ok(typeof diff.rationale === 'string');
  });
});

describe('buildReassessDiff', () => {
  it('returns an empty diff', () => {
    const diff = buildReassessDiff();
    assert.equal(diff.creates.length, 0);
    assert.equal(diff.updates.length, 0);
    assert.equal(diff.deletes.length, 0);
    assert.match(diff.rationale, /check-in|reassess/i);
  });
});

// -------- buildReturnFromGapDiff ------------------------------------

describe('buildReturnFromGapDiff', () => {
  const ctx = makeCtx();

  it('returns null when tier is none', () => {
    const got = buildReturnFromGapDiff({
      ctx,
      gapDays: 1,
      lastDoneIso: '2026-04-14',
      tier: 'none',
    });
    assert.equal(got, null);
  });

  it('soft tier: 2 options (shift_week, jump_back_in), default shift_week', () => {
    const got = buildReturnFromGapDiff({
      ctx,
      gapDays: 4,
      lastDoneIso: '2026-04-11',
      tier: 'soft',
    });
    assert.ok(got);
    assert.equal(got!.kind, 'return_from_gap');
    assert.equal(got!.tier, 'soft');
    assert.equal(got!.gap_days, 4);
    assert.equal(got!.default_option_id, 'shift_week');
    assert.equal(got!.options.length, 2);
    const ids = got!.options.map((o) => o.id);
    assert.deepEqual(ids.sort(), ['jump_back_in', 'shift_week']);
    const shiftOpt = got!.options.find((o) => o.id === 'shift_week')!;
    assert.equal(shiftOpt.recommended, true);
    const jumpOpt = got!.options.find((o) => o.id === 'jump_back_in')!;
    assert.equal(jumpOpt.recommended, false);
  });

  it('hard tier: 3 options, default reentry_soft, reassess has action', () => {
    const got = buildReturnFromGapDiff({
      ctx,
      gapDays: 10,
      lastDoneIso: '2026-04-05',
      tier: 'hard',
    });
    assert.ok(got);
    assert.equal(got!.tier, 'hard');
    assert.equal(got!.default_option_id, 'reentry_soft');
    assert.equal(got!.options.length, 3);
    const ids = got!.options.map((o) => o.id).sort();
    assert.deepEqual(ids, ['jump_back_in', 'reassess', 'reentry_soft']);
    const reentry = got!.options.find((o) => o.id === 'reentry_soft')!;
    assert.equal(reentry.recommended, true);
    const reassess = got!.options.find((o) => o.id === 'reassess')!;
    assert.equal(reassess.action, 'reassess');
  });

  it('hard_extended tier: 3 options, default reassess, uses reentry_full', () => {
    const got = buildReturnFromGapDiff({
      ctx,
      gapDays: 21,
      lastDoneIso: '2026-03-25',
      tier: 'hard_extended',
    });
    assert.ok(got);
    assert.equal(got!.tier, 'hard_extended');
    assert.equal(got!.default_option_id, 'reassess');
    assert.equal(got!.options.length, 3);
    const ids = got!.options.map((o) => o.id).sort();
    assert.deepEqual(ids, ['jump_back_in', 'reassess', 'reentry_full']);
    const reentry = got!.options.find((o) => o.id === 'reentry_full')!;
    // For hard_extended, reassess (not reentry) is the recommended option.
    assert.equal(reentry.recommended, false);
    const reassess = got!.options.find((o) => o.id === 'reassess')!;
    assert.equal(reassess.recommended, true);
    // reentry_full should produce 14 creates when in-phase.
    assert.equal(reentry.diff.creates.length, REENTRY_FULL_DAYS);
  });

  it('records gap_days, last_done_date, today in the diff header', () => {
    const got = buildReturnFromGapDiff({
      ctx,
      gapDays: 5,
      lastDoneIso: '2026-04-10',
      tier: 'soft',
    });
    assert.ok(got);
    assert.equal(got!.gap_days, 5);
    assert.equal(got!.last_done_date, '2026-04-10');
    assert.equal(got!.today, '2026-04-15');
  });

  it('rationale includes a Headline: line', () => {
    const soft = buildReturnFromGapDiff({
      ctx,
      gapDays: 4,
      lastDoneIso: '2026-04-11',
      tier: 'soft',
    });
    assert.match(soft!.rationale, /^Headline:/m);
    const hard = buildReturnFromGapDiff({
      ctx,
      gapDays: 10,
      lastDoneIso: '2026-04-05',
      tier: 'hard',
    });
    assert.match(hard!.rationale, /^Headline:/m);
    const ext = buildReturnFromGapDiff({
      ctx,
      gapDays: 30,
      lastDoneIso: '2026-03-16',
      tier: 'hard_extended',
    });
    assert.match(ext!.rationale, /^Headline:/m);
  });
});
