/**
 * Unit tests for the availability-window diff engine (P1.3 / PR-N).
 *
 * Run via:
 *   npx tsx --test src/lib/availability/diff.test.ts
 *   or: npm test
 *
 * Covers:
 *   - range primitives (rangesOverlap, findOverlappingWindows, enumerateDates)
 *   - preservation helper (preserveReasonFor)
 *   - buildCreateWindowDiff: all three kinds, every resolved strategy,
 *     overlap rejection, past clipping, preservation per source/status,
 *     idempotency, today rewriting, phase-less dates
 *   - buildCancelWindowDiff: template realignment, rest slots, orphan
 *     bindings, no-op when nothing is ours, preservation
 *   - buildModifyWindowDiff: extend / shrink / strategy changes (including
 *     through suppress), combined deltas, kind/id invariants, overlap
 *     rejection
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCancelWindowDiff,
  buildCreateWindowDiff,
  buildModifyWindowDiff,
  enumerateDates,
  findOverlappingWindows,
  preserveReasonFor,
  rangesOverlap,
  type ExistingPlan,
} from './diff.pure';
import type {
  ActiveWindow,
  CalendarEventRow,
  PhaseRow,
  WeeklyPattern,
} from '@/lib/reconcile/rollForward.pure';

// -------- fixtures ---------------------------------------------------

const TODAY = '2026-04-15'; // Wednesday

const PHASE: PhaseRow = {
  id: 'phase-1',
  code: 'P2',
  starts_on: '2026-03-30',
  target_ends_on: '2026-05-31',
};

const PATTERN: WeeklyPattern = {
  MO: { type: 'gym', day_code: 'push' },
  TU: { type: 'gym', day_code: 'pull' },
  WE: { type: 'run', day_code: 'easy_run' },
  TH: { type: 'gym', day_code: 'lower' },
  FR: { type: 'gym', day_code: 'upper_full' },
  SA: { type: 'run', day_code: 'quality_run' },
  SU: { type: 'rest', day_code: null },
};

const EVENTS = new Map<string, CalendarEventRow>([
  ['phase-1:push', { id: 'ev-push', phase_id: 'phase-1', day_code: 'push', summary: 'Push', prescription: { blocks: ['bench'] } }],
  ['phase-1:pull', { id: 'ev-pull', phase_id: 'phase-1', day_code: 'pull', summary: 'Pull', prescription: { blocks: ['row'] } }],
  ['phase-1:lower', { id: 'ev-lower', phase_id: 'phase-1', day_code: 'lower', summary: 'Lower', prescription: { blocks: ['squat'] } }],
  ['phase-1:upper_full', { id: 'ev-upper', phase_id: 'phase-1', day_code: 'upper_full', summary: 'Upper', prescription: { blocks: ['bench'] } }],
  ['phase-1:easy_run', { id: 'ev-easy', phase_id: 'phase-1', day_code: 'easy_run', summary: 'Easy run', prescription: { blocks: ['z2'] } }],
  ['phase-1:quality_run', { id: 'ev-quality', phase_id: 'phase-1', day_code: 'quality_run', summary: 'Quality run', prescription: { blocks: ['tempo'] } }],
]);

const USER = 'user-1';

function mkPlan(p: Partial<ExistingPlan> & { id: string; date: string }): ExistingPlan {
  // NB: use `in p` / explicit undefined checks so callers can pass `null`
  // for nullable fields (day_code, window_id, phase_id) without the default
  // coalescing back to a non-null value. A naive `??` would turn
  // `day_code: null` into `'push'`, breaking preservation-by-shape logic.
  return {
    id: p.id,
    date: p.date,
    type: p.type ?? 'gym',
    day_code: 'day_code' in p ? (p.day_code ?? null) : 'push',
    status: p.status ?? 'planned',
    source: p.source ?? 'template',
    phase_id: 'phase_id' in p ? (p.phase_id ?? null) : 'phase-1',
    window_id: 'window_id' in p ? (p.window_id ?? null) : null,
    prescription: p.prescription ?? { blocks: ['x'] },
    calendar_event_id: 'calendar_event_id' in p ? (p.calendar_event_id ?? null) : null,
  };
}

function plansByDate(rows: ExistingPlan[]): Map<string, ExistingPlan> {
  return new Map(rows.map(r => [r.date, r]));
}

function mkWindow(p: Partial<ActiveWindow> & { id: string }): ActiveWindow {
  return {
    id: p.id,
    starts_on: p.starts_on ?? '2026-04-20',
    ends_on: p.ends_on ?? '2026-04-24',
    kind: p.kind ?? 'travel',
    strategy: p.strategy ?? 'auto',
    note: p.note ?? null,
  };
}

// -------- rangesOverlap ----------------------------------------------

describe('rangesOverlap', () => {
  it('disjoint ranges do not overlap', () => {
    assert.equal(rangesOverlap('2026-04-01', '2026-04-05', '2026-04-10', '2026-04-12'), false);
  });

  it('ranges touching at a single boundary day overlap', () => {
    assert.equal(rangesOverlap('2026-04-01', '2026-04-10', '2026-04-10', '2026-04-15'), true);
  });

  it('fully contained range overlaps', () => {
    assert.equal(rangesOverlap('2026-04-01', '2026-04-30', '2026-04-10', '2026-04-12'), true);
  });

  it('partial overlap on the right', () => {
    assert.equal(rangesOverlap('2026-04-01', '2026-04-10', '2026-04-08', '2026-04-20'), true);
  });

  it('identical ranges overlap', () => {
    assert.equal(rangesOverlap('2026-04-01', '2026-04-05', '2026-04-01', '2026-04-05'), true);
  });
});

// -------- findOverlappingWindows ------------------------------------

describe('findOverlappingWindows', () => {
  it('returns empty when no other window intersects', () => {
    const others: ActiveWindow[] = [
      mkWindow({ id: 'w-past', starts_on: '2026-03-01', ends_on: '2026-03-10' }),
      mkWindow({ id: 'w-future', starts_on: '2026-06-01', ends_on: '2026-06-10' }),
    ];
    const conflicts = findOverlappingWindows({
      start: '2026-04-20',
      end: '2026-04-24',
      activeWindows: others,
    });
    assert.equal(conflicts.length, 0);
  });

  it('returns all intersecting windows', () => {
    const others: ActiveWindow[] = [
      mkWindow({ id: 'w-a', starts_on: '2026-04-18', ends_on: '2026-04-22' }),
      mkWindow({ id: 'w-b', starts_on: '2026-04-23', ends_on: '2026-04-25' }),
      mkWindow({ id: 'w-c', starts_on: '2026-05-01', ends_on: '2026-05-05' }),
    ];
    const conflicts = findOverlappingWindows({
      start: '2026-04-20',
      end: '2026-04-24',
      activeWindows: others,
    });
    assert.deepEqual(conflicts.map(c => c.id).sort(), ['w-a', 'w-b']);
  });

  it('excludeId filters itself out of the result', () => {
    const w = mkWindow({ id: 'self', starts_on: '2026-04-20', ends_on: '2026-04-24' });
    const conflicts = findOverlappingWindows({
      start: '2026-04-20',
      end: '2026-04-24',
      activeWindows: [w],
      excludeId: 'self',
    });
    assert.equal(conflicts.length, 0);
  });
});

// -------- enumerateDates --------------------------------------------

describe('enumerateDates', () => {
  it('returns a single-entry list when start === end', () => {
    assert.deepEqual(enumerateDates('2026-04-15', '2026-04-15'), ['2026-04-15']);
  });

  it('returns the inclusive range for multi-day windows', () => {
    assert.deepEqual(
      enumerateDates('2026-04-15', '2026-04-18'),
      ['2026-04-15', '2026-04-16', '2026-04-17', '2026-04-18']
    );
  });

  it('returns empty when start > end', () => {
    assert.deepEqual(enumerateDates('2026-04-20', '2026-04-15'), []);
  });
});

// -------- preserveReasonFor -----------------------------------------

describe('preserveReasonFor', () => {
  it("returns 'logged' for any non-planned status", () => {
    for (const status of ['done', 'missed', 'skipped', 'moved']) {
      const p = mkPlan({ id: 'p', date: '2026-04-20', status });
      assert.equal(preserveReasonFor(p, 'w-1'), 'logged');
    }
  });

  it("returns 'manual' for planned + manual source", () => {
    const p = mkPlan({ id: 'p', date: '2026-04-20', source: 'manual' });
    assert.equal(preserveReasonFor(p, 'w-1'), 'manual');
  });

  it("returns 'ai_proposed' for planned + ai_proposed source", () => {
    const p = mkPlan({ id: 'p', date: '2026-04-20', source: 'ai_proposed' });
    assert.equal(preserveReasonFor(p, 'w-1'), 'ai_proposed');
  });

  it("returns 'other_window' when row belongs to a different availability window", () => {
    const p = mkPlan({ id: 'p', date: '2026-04-20', source: 'availability_window', window_id: 'w-OTHER' });
    assert.equal(preserveReasonFor(p, 'w-1'), 'other_window');
  });

  it('returns null for planned template rows (replaceable)', () => {
    const p = mkPlan({ id: 'p', date: '2026-04-20', source: 'template' });
    assert.equal(preserveReasonFor(p, 'w-1'), null);
  });

  it('returns null for OUR own window rows (they are updatable, not preserved)', () => {
    const p = mkPlan({ id: 'p', date: '2026-04-20', source: 'availability_window', window_id: 'w-1' });
    assert.equal(preserveReasonFor(p, 'w-1'), null);
  });
});

// -------- buildCreateWindowDiff: happy paths ------------------------

describe('buildCreateWindowDiff — basic shaping', () => {
  const base = {
    userId: USER,
    todayIso: TODAY,
    otherActiveWindows: [] as ActiveWindow[],
    plansByDate: new Map<string, ExistingPlan>(),
    phases: [PHASE],
    weeklyPattern: PATTERN,
    eventsByPhaseDay: EVENTS,
  };

  it('travel window with strategy=auto → bodyweight creates', () => {
    const w = mkWindow({ id: 'w-travel', kind: 'travel', strategy: 'auto', starts_on: '2026-04-20', ends_on: '2026-04-22' });
    const r = buildCreateWindowDiff({ ...base, window: w });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.equal(r.creates.length, 3);
    for (const c of r.creates) {
      assert.equal(c.type, 'bodyweight');
      assert.equal(c.source, 'availability_window');
      assert.equal(c.window_id, 'w-travel');
      assert.equal(c.calendar_event_id, null);
      assert.equal(c.day_code, null);
      assert.deepEqual(c.prescription, {});
      assert.equal(c.phase_id, 'phase-1');
    }
    assert.equal(r.summary.added, 3);
    assert.equal(r.summary.changed, 0);
    assert.equal(r.summary.removed, 0);
  });

  it('injury window with strategy=auto → rest creates', () => {
    const w = mkWindow({ id: 'w-inj', kind: 'injury', strategy: 'auto', starts_on: '2026-04-20', ends_on: '2026-04-22' });
    const r = buildCreateWindowDiff({ ...base, window: w });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.equal(r.creates.length, 3);
    for (const c of r.creates) assert.equal(c.type, 'rest');
  });

  it('pause window with strategy=auto → rest creates', () => {
    const w = mkWindow({ id: 'w-p', kind: 'pause', strategy: 'auto', starts_on: '2026-04-20', ends_on: '2026-04-22' });
    const r = buildCreateWindowDiff({ ...base, window: w });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    for (const c of r.creates) assert.equal(c.type, 'rest');
  });

  it('explicit strategy=rest on a travel window produces rest rows', () => {
    const w = mkWindow({ id: 'w', kind: 'travel', strategy: 'rest', starts_on: '2026-04-20', ends_on: '2026-04-21' });
    const r = buildCreateWindowDiff({ ...base, window: w });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    for (const c of r.creates) assert.equal(c.type, 'rest');
  });

  it('explicit strategy=bodyweight on an injury window produces bodyweight rows', () => {
    const w = mkWindow({ id: 'w', kind: 'injury', strategy: 'bodyweight', starts_on: '2026-04-20', ends_on: '2026-04-21' });
    const r = buildCreateWindowDiff({ ...base, window: w });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    for (const c of r.creates) assert.equal(c.type, 'bodyweight');
  });

  it('strategy=suppress on empty dates emits NO creates and NO deletes', () => {
    const w = mkWindow({ id: 'w', kind: 'pause', strategy: 'suppress', starts_on: '2026-04-20', ends_on: '2026-04-22' });
    const r = buildCreateWindowDiff({ ...base, window: w });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.equal(r.creates.length, 0);
    assert.equal(r.deletes.length, 0);
    assert.equal(r.summary.added, 0);
  });

  it('strategy=suppress deletes replaceable template rows in range', () => {
    const plans = plansByDate([
      mkPlan({ id: 'p1', date: '2026-04-20', type: 'gym', day_code: 'lower' }),
      mkPlan({ id: 'p2', date: '2026-04-21', type: 'gym', day_code: 'upper_full' }),
    ]);
    const w = mkWindow({ id: 'w', kind: 'pause', strategy: 'suppress', starts_on: '2026-04-20', ends_on: '2026-04-21' });
    const r = buildCreateWindowDiff({ ...base, plansByDate: plans, window: w });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.equal(r.deletes.length, 2);
    assert.equal(r.summary.removed, 2);
  });
});

describe('buildCreateWindowDiff — against existing plans', () => {
  const base = {
    userId: USER,
    todayIso: TODAY,
    otherActiveWindows: [] as ActiveWindow[],
    phases: [PHASE],
    weeklyPattern: PATTERN,
    eventsByPhaseDay: EVENTS,
  };

  it('rewrites a template row into a window row via update (keeps plan_id)', () => {
    const plans = plansByDate([
      mkPlan({ id: 'p-keep', date: '2026-04-20', type: 'gym', day_code: 'lower' }),
    ]);
    const w = mkWindow({ id: 'w', kind: 'travel', strategy: 'auto', starts_on: '2026-04-20', ends_on: '2026-04-20' });
    const r = buildCreateWindowDiff({ ...base, plansByDate: plans, window: w });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.equal(r.updates.length, 1);
    assert.equal(r.creates.length, 0);
    assert.equal(r.updates[0].plan_id, 'p-keep');
    assert.equal(r.updates[0].patch.type, 'bodyweight');
    assert.equal(r.updates[0].patch.source, 'availability_window');
    assert.equal(r.updates[0].patch.window_id, 'w');
    assert.equal(r.updates[0].patch.day_code, null);
    assert.equal(r.summary.changed, 1);
  });

  it("preserves status='done' rows and counts them as skipped_logged", () => {
    const plans = plansByDate([
      mkPlan({ id: 'p-done', date: '2026-04-20', status: 'done' }),
    ]);
    const w = mkWindow({ id: 'w', kind: 'travel', starts_on: '2026-04-20', ends_on: '2026-04-20' });
    const r = buildCreateWindowDiff({ ...base, plansByDate: plans, window: w });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.equal(r.creates.length, 0);
    assert.equal(r.updates.length, 0);
    assert.equal(r.deletes.length, 0);
    assert.equal(r.summary.skipped_logged, 1);
  });

  it('preserves source=manual rows', () => {
    const plans = plansByDate([
      mkPlan({ id: 'p-man', date: '2026-04-20', source: 'manual' }),
    ]);
    const w = mkWindow({ id: 'w', kind: 'travel', starts_on: '2026-04-20', ends_on: '2026-04-20' });
    const r = buildCreateWindowDiff({ ...base, plansByDate: plans, window: w });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.equal(r.summary.skipped_manual, 1);
    assert.equal(r.creates.length, 0);
    assert.equal(r.updates.length, 0);
  });

  it('preserves source=ai_proposed rows', () => {
    const plans = plansByDate([
      mkPlan({ id: 'p-ai', date: '2026-04-20', source: 'ai_proposed' }),
    ]);
    const w = mkWindow({ id: 'w', kind: 'travel', starts_on: '2026-04-20', ends_on: '2026-04-20' });
    const r = buildCreateWindowDiff({ ...base, plansByDate: plans, window: w });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.equal(r.summary.skipped_ai_proposed, 1);
  });

  it('preserves rows from a different availability window', () => {
    const plans = plansByDate([
      mkPlan({ id: 'p-other', date: '2026-04-20', source: 'availability_window', window_id: 'w-OTHER', type: 'rest' }),
    ]);
    const w = mkWindow({ id: 'w-NEW', kind: 'travel', starts_on: '2026-04-20', ends_on: '2026-04-20' });
    const r = buildCreateWindowDiff({
      ...base,
      plansByDate: plans,
      window: w,
      // Note: we do NOT include w-OTHER in otherActiveWindows here — we're
      // testing per-row preservation, not the overlap gate.
    });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.equal(r.summary.skipped_other_window, 1);
    assert.equal(r.updates.length, 0);
  });

  it('today is rewritten when it falls inside the window', () => {
    const plans = plansByDate([
      mkPlan({ id: 'p-today', date: TODAY, type: 'run', day_code: 'easy_run' }),
    ]);
    const w = mkWindow({ id: 'w', kind: 'injury', starts_on: TODAY, ends_on: '2026-04-16' });
    const r = buildCreateWindowDiff({ ...base, plansByDate: plans, window: w });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    const todayUpdate = r.updates.find(u => u.date === TODAY);
    assert.ok(todayUpdate, 'today should be updated');
    assert.equal(todayUpdate!.plan_id, 'p-today');
    assert.equal(todayUpdate!.patch.type, 'rest');
  });

  it('idempotent: a second diff against the applied world produces zero ops', () => {
    const w = mkWindow({ id: 'w', kind: 'travel', starts_on: '2026-04-20', ends_on: '2026-04-21' });
    const plans = plansByDate([
      {
        id: 'existing-1',
        date: '2026-04-20',
        type: 'bodyweight',
        day_code: null,
        status: 'planned',
        source: 'availability_window',
        phase_id: 'phase-1',
        window_id: 'w',
        prescription: {},
        calendar_event_id: null,
      },
      {
        id: 'existing-2',
        date: '2026-04-21',
        type: 'bodyweight',
        day_code: null,
        status: 'planned',
        source: 'availability_window',
        phase_id: 'phase-1',
        window_id: 'w',
        prescription: {},
        calendar_event_id: null,
      },
    ]);
    const r = buildCreateWindowDiff({ ...base, plansByDate: plans, window: w });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.equal(r.creates.length, 0);
    assert.equal(r.updates.length, 0);
    assert.equal(r.deletes.length, 0);
  });
});

describe('buildCreateWindowDiff — clipping + edge cases', () => {
  const base = {
    userId: USER,
    todayIso: TODAY,
    otherActiveWindows: [] as ActiveWindow[],
    plansByDate: new Map<string, ExistingPlan>(),
    phases: [PHASE],
    weeklyPattern: PATTERN,
    eventsByPhaseDay: EVENTS,
  };

  it('clips start to today when window begins in the past', () => {
    const w = mkWindow({ id: 'w', kind: 'travel', starts_on: '2026-04-01', ends_on: '2026-04-17' });
    const r = buildCreateWindowDiff({ ...base, window: w });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.deepEqual(r.range, { start: TODAY, end: '2026-04-17' });
    assert.equal(r.creates.length, 3); // 15,16,17
  });

  it('returns empty ok when entire window is in the past', () => {
    const w = mkWindow({ id: 'w', kind: 'pause', starts_on: '2026-03-01', ends_on: '2026-03-10' });
    const r = buildCreateWindowDiff({ ...base, window: w });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.equal(r.range, null);
    assert.equal(r.creates.length, 0);
  });

  it('emits window rows even for dates outside any phase (phase_id: null)', () => {
    const w = mkWindow({ id: 'w', kind: 'pause', starts_on: '2026-06-10', ends_on: '2026-06-11' });
    // PHASE ends on 2026-05-31, so both dates are phase-less.
    const r = buildCreateWindowDiff({ ...base, window: w });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.equal(r.creates.length, 2);
    for (const c of r.creates) assert.equal(c.phase_id, null);
  });
});

describe('buildCreateWindowDiff — overlap rejection', () => {
  const base = {
    userId: USER,
    todayIso: TODAY,
    plansByDate: new Map<string, ExistingPlan>(),
    phases: [PHASE],
    weeklyPattern: PATTERN,
    eventsByPhaseDay: EVENTS,
  };

  it('rejects when the proposed range intersects another active window', () => {
    const other = mkWindow({ id: 'w-other', kind: 'injury', starts_on: '2026-04-22', ends_on: '2026-04-25' });
    const w = mkWindow({ id: 'w-new', kind: 'travel', starts_on: '2026-04-20', ends_on: '2026-04-23' });
    const r = buildCreateWindowDiff({
      ...base,
      otherActiveWindows: [other],
      window: w,
    });
    assert.equal(r.kind, 'error');
    if (r.kind !== 'error') return;
    assert.equal(r.error, 'overlaps_existing');
    assert.equal(r.conflicts.length, 1);
    assert.equal(r.conflicts[0].id, 'w-other');
    assert.equal(r.conflicts[0].kind, 'injury');
  });

  it('reports all conflicting windows, not just the first', () => {
    const a = mkWindow({ id: 'w-a', starts_on: '2026-04-18', ends_on: '2026-04-20' });
    const b = mkWindow({ id: 'w-b', starts_on: '2026-04-23', ends_on: '2026-04-25' });
    const w = mkWindow({ id: 'w-new', starts_on: '2026-04-19', ends_on: '2026-04-24' });
    const r = buildCreateWindowDiff({
      ...base,
      otherActiveWindows: [a, b],
      window: w,
    });
    assert.equal(r.kind, 'error');
    if (r.kind !== 'error') return;
    assert.deepEqual(r.conflicts.map(c => c.id).sort(), ['w-a', 'w-b']);
  });

  it('no conflict when other window is strictly before today (clipped out)', () => {
    // Other window is in the past but effective-range-wise irrelevant for
    // our create. Current logic still checks overlap with the RAW other
    // window; document that here (the caller is expected to pass only
    // active windows, which in practice won't include past ones).
    const other = mkWindow({ id: 'w-past', starts_on: '2026-03-01', ends_on: '2026-03-10' });
    const w = mkWindow({ id: 'w', starts_on: '2026-04-20', ends_on: '2026-04-22' });
    const r = buildCreateWindowDiff({
      ...base,
      otherActiveWindows: [other],
      window: w,
    });
    assert.equal(r.kind, 'ok');
  });
});

// -------- buildCancelWindowDiff -------------------------------------

describe('buildCancelWindowDiff', () => {
  const base = {
    userId: USER,
    todayIso: TODAY,
    phases: [PHASE],
    weeklyPattern: PATTERN,
    eventsByPhaseDay: EVENTS,
  };

  it('realigns our window rows back to the template (updates)', () => {
    const w = mkWindow({ id: 'w', kind: 'travel', strategy: 'auto', starts_on: '2026-04-20', ends_on: '2026-04-21' });
    // Window had rewritten 04-20 (MO=push) and 04-21 (TU=pull) into bodyweight.
    const plans = plansByDate([
      mkPlan({
        id: 'p-20', date: '2026-04-20',
        type: 'bodyweight', day_code: null,
        source: 'availability_window', window_id: 'w',
        prescription: {},
      }),
      mkPlan({
        id: 'p-21', date: '2026-04-21',
        type: 'bodyweight', day_code: null,
        source: 'availability_window', window_id: 'w',
        prescription: {},
      }),
    ]);
    const r = buildCancelWindowDiff({ ...base, plansByDate: plans, window: w });
    assert.equal(r.creates.length, 0);
    assert.equal(r.updates.length, 2);
    assert.equal(r.deletes.length, 0);
    const byDate = new Map(r.updates.map(u => [u.date, u]));
    assert.equal(byDate.get('2026-04-20')!.patch.type, 'gym');
    assert.equal(byDate.get('2026-04-20')!.patch.day_code, 'push');
    assert.equal(byDate.get('2026-04-20')!.patch.source, 'template');
    assert.equal(byDate.get('2026-04-20')!.patch.window_id, null);
    assert.equal(byDate.get('2026-04-20')!.patch.calendar_event_id, 'ev-push');
    assert.equal(byDate.get('2026-04-21')!.patch.day_code, 'pull');
    assert.equal(r.summary.changed, 2);
  });

  it('emits creates for dates where no row existed but template now calls for one', () => {
    const w = mkWindow({ id: 'w', kind: 'pause', strategy: 'suppress', starts_on: '2026-04-20', ends_on: '2026-04-21' });
    // Suppress window left both dates empty; cancel should recreate template rows.
    const plans = plansByDate([]);
    const r = buildCancelWindowDiff({ ...base, plansByDate: plans, window: w });
    assert.equal(r.creates.length, 2);
    assert.equal(r.updates.length, 0);
    assert.equal(r.summary.added, 2);
    const byDate = new Map(r.creates.map(c => [c.date, c]));
    assert.equal(byDate.get('2026-04-20')!.type, 'gym');
    assert.equal(byDate.get('2026-04-20')!.day_code, 'push');
    assert.equal(byDate.get('2026-04-20')!.source, 'template');
    assert.equal(byDate.get('2026-04-20')!.window_id, null);
  });

  it('deletes our window rows on DOW that the template has no slot for', () => {
    // Synthetic pattern that skips Mondays entirely.
    const partialPattern: WeeklyPattern = {
      TU: { type: 'gym', day_code: 'pull' },
      WE: { type: 'run', day_code: 'easy_run' },
    };
    const w = mkWindow({ id: 'w', kind: 'travel', strategy: 'rest', starts_on: '2026-04-20', ends_on: '2026-04-20' });
    const plans = plansByDate([
      mkPlan({
        id: 'p-20', date: '2026-04-20',
        type: 'rest', day_code: null,
        source: 'availability_window', window_id: 'w',
        prescription: {},
      }),
    ]);
    const r = buildCancelWindowDiff({
      ...base,
      weeklyPattern: partialPattern,
      plansByDate: plans,
      window: w,
    });
    assert.equal(r.deletes.length, 1);
    assert.equal(r.updates.length, 0);
    assert.equal(r.creates.length, 0);
    assert.equal(r.summary.removed, 1);
  });

  it('restores a rest slot as a template rest row (not just deletes)', () => {
    // A Sunday (04-19) falls in this window. Pattern says SU = rest.
    const w = mkWindow({ id: 'w', kind: 'injury', strategy: 'rest', starts_on: '2026-04-19', ends_on: '2026-04-19' });
    const plans = plansByDate([
      mkPlan({
        id: 'p-19', date: '2026-04-19',
        type: 'rest', day_code: null,
        source: 'availability_window', window_id: 'w',
        prescription: {},
      }),
    ]);
    const r = buildCancelWindowDiff({ ...base, plansByDate: plans, window: w });
    assert.equal(r.updates.length, 1);
    assert.equal(r.updates[0].patch.type, 'rest');
    assert.equal(r.updates[0].patch.source, 'template');
    assert.equal(r.updates[0].patch.day_code, null);
  });

  it('preserves logged / manual / ai_proposed rows', () => {
    const w = mkWindow({ id: 'w', kind: 'travel', starts_on: '2026-04-20', ends_on: '2026-04-22' });
    const plans = plansByDate([
      mkPlan({ id: 'p-20', date: '2026-04-20', status: 'done' }),
      mkPlan({ id: 'p-21', date: '2026-04-21', source: 'manual', status: 'planned' }),
      mkPlan({ id: 'p-22', date: '2026-04-22', source: 'ai_proposed', status: 'planned' }),
    ]);
    const r = buildCancelWindowDiff({ ...base, plansByDate: plans, window: w });
    assert.equal(r.summary.skipped_logged, 1);
    assert.equal(r.summary.skipped_manual, 1);
    assert.equal(r.summary.skipped_ai_proposed, 1);
    assert.equal(r.updates.length, 0);
    assert.equal(r.creates.length, 0);
    assert.equal(r.deletes.length, 0);
  });

  it('preserves rows from a different window', () => {
    const w = mkWindow({ id: 'w', kind: 'travel', starts_on: '2026-04-20', ends_on: '2026-04-20' });
    const plans = plansByDate([
      mkPlan({
        id: 'p-20', date: '2026-04-20',
        type: 'rest', day_code: null,
        source: 'availability_window', window_id: 'w-OTHER',
        prescription: {},
      }),
    ]);
    const r = buildCancelWindowDiff({ ...base, plansByDate: plans, window: w });
    assert.equal(r.summary.skipped_other_window, 1);
    assert.equal(r.updates.length, 0);
  });

  it('leaves unrelated template rows alone (no op)', () => {
    // Covered date has a bare template row (not ours). Should not touch.
    const w = mkWindow({ id: 'w', kind: 'travel', starts_on: '2026-04-20', ends_on: '2026-04-20' });
    const plans = plansByDate([
      mkPlan({ id: 'p-20', date: '2026-04-20', type: 'gym', day_code: 'push', source: 'template' }),
    ]);
    const r = buildCancelWindowDiff({ ...base, plansByDate: plans, window: w });
    assert.equal(r.updates.length, 0);
    assert.equal(r.creates.length, 0);
    assert.equal(r.deletes.length, 0);
  });

  it('whole window in the past → empty ok', () => {
    const w = mkWindow({ id: 'w', kind: 'pause', starts_on: '2026-03-01', ends_on: '2026-03-10' });
    const plans = plansByDate([]);
    const r = buildCancelWindowDiff({ ...base, plansByDate: plans, window: w });
    assert.equal(r.range, null);
    assert.equal(r.creates.length, 0);
    assert.equal(r.updates.length, 0);
    assert.equal(r.deletes.length, 0);
  });

  it('idempotent: cancelling an already-rolled-back range is a no-op', () => {
    const w = mkWindow({ id: 'w', kind: 'pause', starts_on: '2026-04-20', ends_on: '2026-04-21' });
    // World already reflects template state — no window rows remain.
    const plans = plansByDate([
      mkPlan({ id: 'p-20', date: '2026-04-20', type: 'gym', day_code: 'push', source: 'template', calendar_event_id: 'ev-push', prescription: { blocks: ['bench'] } }),
      mkPlan({ id: 'p-21', date: '2026-04-21', type: 'gym', day_code: 'pull', source: 'template', calendar_event_id: 'ev-pull', prescription: { blocks: ['row'] } }),
    ]);
    const r = buildCancelWindowDiff({ ...base, plansByDate: plans, window: w });
    assert.equal(r.creates.length, 0);
    assert.equal(r.updates.length, 0);
    assert.equal(r.deletes.length, 0);
  });
});

// -------- buildModifyWindowDiff -------------------------------------

describe('buildModifyWindowDiff', () => {
  const base = {
    userId: USER,
    todayIso: TODAY,
    otherActiveWindows: [] as ActiveWindow[],
    phases: [PHASE],
    weeklyPattern: PATTERN,
    eventsByPhaseDay: EVENTS,
  };

  it('extend (end moves forward): new dates get window rows applied', () => {
    const oldW = mkWindow({ id: 'w', kind: 'travel', strategy: 'auto', starts_on: '2026-04-20', ends_on: '2026-04-21' });
    const newW = mkWindow({ id: 'w', kind: 'travel', strategy: 'auto', starts_on: '2026-04-20', ends_on: '2026-04-23' });
    const plans = plansByDate([
      // old coverage already applied
      mkPlan({ id: 'p-20', date: '2026-04-20', type: 'bodyweight', day_code: null, source: 'availability_window', window_id: 'w', prescription: {} }),
      mkPlan({ id: 'p-21', date: '2026-04-21', type: 'bodyweight', day_code: null, source: 'availability_window', window_id: 'w', prescription: {} }),
      // new dates still have template rows
      mkPlan({ id: 'p-22', date: '2026-04-22', type: 'gym', day_code: 'upper_full', source: 'template' }),
      mkPlan({ id: 'p-23', date: '2026-04-23', type: 'run', day_code: 'quality_run', source: 'template' }),
    ]);
    const r = buildModifyWindowDiff({ ...base, plansByDate: plans, oldWindow: oldW, newWindow: newW });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.equal(r.updates.length, 2);
    const dates = r.updates.map(u => u.date).sort();
    assert.deepEqual(dates, ['2026-04-22', '2026-04-23']);
    assert.equal(r.creates.length, 0);
    assert.equal(r.deletes.length, 0);
  });

  it('shrink (end moves back): trailing dates roll back to template', () => {
    const oldW = mkWindow({ id: 'w', kind: 'travel', strategy: 'auto', starts_on: '2026-04-20', ends_on: '2026-04-23' });
    const newW = mkWindow({ id: 'w', kind: 'travel', strategy: 'auto', starts_on: '2026-04-20', ends_on: '2026-04-21' });
    const plans = plansByDate([
      mkPlan({ id: 'p-20', date: '2026-04-20', type: 'bodyweight', day_code: null, source: 'availability_window', window_id: 'w', prescription: {} }),
      mkPlan({ id: 'p-21', date: '2026-04-21', type: 'bodyweight', day_code: null, source: 'availability_window', window_id: 'w', prescription: {} }),
      mkPlan({ id: 'p-22', date: '2026-04-22', type: 'bodyweight', day_code: null, source: 'availability_window', window_id: 'w', prescription: {} }),
      mkPlan({ id: 'p-23', date: '2026-04-23', type: 'bodyweight', day_code: null, source: 'availability_window', window_id: 'w', prescription: {} }),
    ]);
    const r = buildModifyWindowDiff({ ...base, plansByDate: plans, oldWindow: oldW, newWindow: newW });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.equal(r.updates.length, 2);
    const byDate = new Map(r.updates.map(u => [u.date, u]));
    // 04-22 is Wednesday (run/easy_run), 04-23 is Thursday (gym/lower).
    assert.equal(byDate.get('2026-04-22')!.patch.source, 'template');
    assert.equal(byDate.get('2026-04-22')!.patch.type, 'run');
    assert.equal(byDate.get('2026-04-22')!.patch.day_code, 'easy_run');
    assert.equal(byDate.get('2026-04-23')!.patch.type, 'gym');
    assert.equal(byDate.get('2026-04-23')!.patch.day_code, 'lower');
  });

  it('strategy change (rest → bodyweight): all covered rows reshape', () => {
    const oldW = mkWindow({ id: 'w', kind: 'injury', strategy: 'rest', starts_on: '2026-04-20', ends_on: '2026-04-22' });
    const newW = mkWindow({ id: 'w', kind: 'injury', strategy: 'bodyweight', starts_on: '2026-04-20', ends_on: '2026-04-22' });
    const plans = plansByDate([
      mkPlan({ id: 'p-20', date: '2026-04-20', type: 'rest', day_code: null, source: 'availability_window', window_id: 'w', prescription: {} }),
      mkPlan({ id: 'p-21', date: '2026-04-21', type: 'rest', day_code: null, source: 'availability_window', window_id: 'w', prescription: {} }),
      mkPlan({ id: 'p-22', date: '2026-04-22', type: 'rest', day_code: null, source: 'availability_window', window_id: 'w', prescription: {} }),
    ]);
    const r = buildModifyWindowDiff({ ...base, plansByDate: plans, oldWindow: oldW, newWindow: newW });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.equal(r.updates.length, 3);
    for (const u of r.updates) assert.equal(u.patch.type, 'bodyweight');
  });

  it('strategy change (bodyweight → suppress): covered rows are deleted', () => {
    const oldW = mkWindow({ id: 'w', kind: 'travel', strategy: 'bodyweight', starts_on: '2026-04-20', ends_on: '2026-04-21' });
    const newW = mkWindow({ id: 'w', kind: 'travel', strategy: 'suppress', starts_on: '2026-04-20', ends_on: '2026-04-21' });
    const plans = plansByDate([
      mkPlan({ id: 'p-20', date: '2026-04-20', type: 'bodyweight', day_code: null, source: 'availability_window', window_id: 'w', prescription: {} }),
      mkPlan({ id: 'p-21', date: '2026-04-21', type: 'bodyweight', day_code: null, source: 'availability_window', window_id: 'w', prescription: {} }),
    ]);
    const r = buildModifyWindowDiff({ ...base, plansByDate: plans, oldWindow: oldW, newWindow: newW });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.equal(r.deletes.length, 2);
    assert.equal(r.updates.length, 0);
    assert.equal(r.creates.length, 0);
  });

  it('strategy change (suppress → rest): covered dates get new rest rows', () => {
    const oldW = mkWindow({ id: 'w', kind: 'pause', strategy: 'suppress', starts_on: '2026-04-20', ends_on: '2026-04-21' });
    const newW = mkWindow({ id: 'w', kind: 'pause', strategy: 'rest', starts_on: '2026-04-20', ends_on: '2026-04-21' });
    // Suppress left these dates empty.
    const plans = plansByDate([]);
    const r = buildModifyWindowDiff({ ...base, plansByDate: plans, oldWindow: oldW, newWindow: newW });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.equal(r.creates.length, 2);
    for (const c of r.creates) {
      assert.equal(c.type, 'rest');
      assert.equal(c.source, 'availability_window');
      assert.equal(c.window_id, 'w');
    }
  });

  it('combined extend + strategy change: old dates reshape, new dates apply', () => {
    const oldW = mkWindow({ id: 'w', kind: 'injury', strategy: 'rest', starts_on: '2026-04-20', ends_on: '2026-04-21' });
    const newW = mkWindow({ id: 'w', kind: 'injury', strategy: 'bodyweight', starts_on: '2026-04-20', ends_on: '2026-04-23' });
    const plans = plansByDate([
      mkPlan({ id: 'p-20', date: '2026-04-20', type: 'rest', day_code: null, source: 'availability_window', window_id: 'w', prescription: {} }),
      mkPlan({ id: 'p-21', date: '2026-04-21', type: 'rest', day_code: null, source: 'availability_window', window_id: 'w', prescription: {} }),
      // 04-22 and 04-23 are template placeholders
      mkPlan({ id: 'p-22', date: '2026-04-22', type: 'gym', day_code: 'upper_full', source: 'template' }),
      mkPlan({ id: 'p-23', date: '2026-04-23', type: 'run', day_code: 'quality_run', source: 'template' }),
    ]);
    const r = buildModifyWindowDiff({ ...base, plansByDate: plans, oldWindow: oldW, newWindow: newW });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    // All four covered dates should now be bodyweight rows via update.
    assert.equal(r.updates.length, 4);
    for (const u of r.updates) assert.equal(u.patch.type, 'bodyweight');
    assert.equal(r.creates.length, 0);
    assert.equal(r.deletes.length, 0);
  });

  it('idempotent: no-op modify (same old == new) produces zero ops', () => {
    const w = mkWindow({ id: 'w', kind: 'travel', strategy: 'auto', starts_on: '2026-04-20', ends_on: '2026-04-21' });
    const plans = plansByDate([
      mkPlan({ id: 'p-20', date: '2026-04-20', type: 'bodyweight', day_code: null, source: 'availability_window', window_id: 'w', prescription: {} }),
      mkPlan({ id: 'p-21', date: '2026-04-21', type: 'bodyweight', day_code: null, source: 'availability_window', window_id: 'w', prescription: {} }),
    ]);
    const r = buildModifyWindowDiff({ ...base, plansByDate: plans, oldWindow: w, newWindow: w });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.equal(r.creates.length, 0);
    assert.equal(r.updates.length, 0);
    assert.equal(r.deletes.length, 0);
  });

  it('kind change throws (change-kind requires cancel + create)', () => {
    const oldW = mkWindow({ id: 'w', kind: 'travel', starts_on: '2026-04-20', ends_on: '2026-04-21' });
    const newW = mkWindow({ id: 'w', kind: 'injury', starts_on: '2026-04-20', ends_on: '2026-04-21' });
    assert.throws(() =>
      buildModifyWindowDiff({
        ...base,
        plansByDate: new Map(),
        oldWindow: oldW,
        newWindow: newW,
      })
    );
  });

  it('id mismatch throws', () => {
    const oldW = mkWindow({ id: 'w-1', starts_on: '2026-04-20', ends_on: '2026-04-21' });
    const newW = mkWindow({ id: 'w-2', starts_on: '2026-04-20', ends_on: '2026-04-21' });
    assert.throws(() =>
      buildModifyWindowDiff({
        ...base,
        plansByDate: new Map(),
        oldWindow: oldW,
        newWindow: newW,
      })
    );
  });

  it('rejects overlap with another active window (by new range)', () => {
    const other = mkWindow({ id: 'w-other', kind: 'injury', starts_on: '2026-04-24', ends_on: '2026-04-26' });
    const oldW = mkWindow({ id: 'w', starts_on: '2026-04-20', ends_on: '2026-04-22' });
    const newW = mkWindow({ id: 'w', starts_on: '2026-04-20', ends_on: '2026-04-25' });
    const r = buildModifyWindowDiff({
      ...base,
      otherActiveWindows: [other],
      plansByDate: new Map(),
      oldWindow: oldW,
      newWindow: newW,
    });
    assert.equal(r.kind, 'error');
    if (r.kind !== 'error') return;
    assert.equal(r.conflicts[0].id, 'w-other');
  });

  it('whole window in past → empty ok', () => {
    const oldW = mkWindow({ id: 'w', starts_on: '2026-03-01', ends_on: '2026-03-03' });
    const newW = mkWindow({ id: 'w', starts_on: '2026-03-01', ends_on: '2026-03-05' });
    const r = buildModifyWindowDiff({
      ...base,
      plansByDate: new Map(),
      oldWindow: oldW,
      newWindow: newW,
    });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.equal(r.range, null);
    assert.equal(r.creates.length, 0);
    assert.equal(r.updates.length, 0);
    assert.equal(r.deletes.length, 0);
  });

  it('preserves logged rows in the union range', () => {
    const oldW = mkWindow({ id: 'w', kind: 'travel', strategy: 'bodyweight', starts_on: '2026-04-20', ends_on: '2026-04-22' });
    const newW = mkWindow({ id: 'w', kind: 'travel', strategy: 'rest', starts_on: '2026-04-20', ends_on: '2026-04-22' });
    const plans = plansByDate([
      mkPlan({
        id: 'p-20', date: '2026-04-20',
        type: 'bodyweight', day_code: null,
        source: 'availability_window', window_id: 'w',
        status: 'done', prescription: {},
      }),
    ]);
    const r = buildModifyWindowDiff({ ...base, plansByDate: plans, oldWindow: oldW, newWindow: newW });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.equal(r.summary.skipped_logged, 1);
  });

  it('shrink that starts later: leading days roll back even if end unchanged', () => {
    const oldW = mkWindow({ id: 'w', kind: 'pause', strategy: 'rest', starts_on: '2026-04-20', ends_on: '2026-04-23' });
    const newW = mkWindow({ id: 'w', kind: 'pause', strategy: 'rest', starts_on: '2026-04-22', ends_on: '2026-04-23' });
    const plans = plansByDate([
      mkPlan({ id: 'p-20', date: '2026-04-20', type: 'rest', day_code: null, source: 'availability_window', window_id: 'w', prescription: {} }),
      mkPlan({ id: 'p-21', date: '2026-04-21', type: 'rest', day_code: null, source: 'availability_window', window_id: 'w', prescription: {} }),
      mkPlan({ id: 'p-22', date: '2026-04-22', type: 'rest', day_code: null, source: 'availability_window', window_id: 'w', prescription: {} }),
      mkPlan({ id: 'p-23', date: '2026-04-23', type: 'rest', day_code: null, source: 'availability_window', window_id: 'w', prescription: {} }),
    ]);
    const r = buildModifyWindowDiff({ ...base, plansByDate: plans, oldWindow: oldW, newWindow: newW });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    // 04-20 (MO=push), 04-21 (TU=pull) roll back to template.
    const rolledBack = r.updates.map(u => u.date).sort();
    assert.deepEqual(rolledBack, ['2026-04-20', '2026-04-21']);
    for (const u of r.updates) assert.equal(u.patch.source, 'template');
  });
});
