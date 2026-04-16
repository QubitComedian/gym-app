/**
 * Unit tests for the phase-transition diff engine (P1.2 / PR-I).
 *
 * Run via:
 *   npx tsx --test src/lib/phase/transition.test.ts
 *   or: npm test
 *
 * Covers:
 *   - tier classification (soft/hard/none, overdue, open-ended, completed)
 *   - window construction (exclusive of today, clipped to new phase end)
 *   - transition diff: creates + deletes, rest handling, orphan detection
 *   - preservation: logged / manual / ai_proposed / other-phase plans
 *   - extend diffs: 1w / 2w / 4w, fills gaps, respects already-planned rows
 *   - end_phase diff: deletes replaceable future, preserves history
 *   - default option selection (transition vs extend_2w)
 *   - options set varies with nextPhase availability
 *   - reassess option has no diff
 *   - today never rewritten
 *   - idempotency (run twice → same shape)
 *   - rationale smoke-tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPhaseTransitionProposal,
  classifyPhaseTransition,
  shouldPreserveExistingPlan,
  PHASE_TRANSITION_WINDOW_DAYS,
  SOFT_TIER_WINDOW_DAYS,
  type BuildPhaseTransitionArgs,
  type ExistingPlan,
} from './transition.pure';
import type {
  CalendarEventRow,
  PhaseRow,
  WeeklyPattern,
} from '@/lib/reconcile/rollForward.pure';

// -------- fixtures ---------------------------------------------------

const TODAY = '2026-04-15'; // Wednesday
const USER = 'user-1';

// P2: current, ends in a few days → exact ends_on set per test.
const P2_BASE: PhaseRow & { name?: string | null } = {
  id: 'p2',
  code: 'P2',
  starts_on: '2026-03-15',
  target_ends_on: '2026-04-20', // 5 days out → soft
};

const P3_BASE: PhaseRow & { name?: string | null } = {
  id: 'p3',
  code: 'P3',
  name: 'Intensification',
  starts_on: '2026-04-21',
  target_ends_on: '2026-06-15',
};

const OLD_PATTERN: WeeklyPattern = {
  MO: { type: 'gym', day_code: 'push' },
  TU: { type: 'gym', day_code: 'pull' },
  WE: { type: 'run', day_code: 'easy' },
  TH: { type: 'gym', day_code: 'lower' },
  FR: { type: 'gym', day_code: 'upper' },
  SA: { type: 'run', day_code: 'quality' },
  SU: { type: 'rest', day_code: null },
};

const NEW_PATTERN: WeeklyPattern = {
  MO: { type: 'gym', day_code: 'heavy_upper' },
  TU: { type: 'run', day_code: 'tempo' },
  WE: { type: 'gym', day_code: 'heavy_lower' },
  TH: { type: 'rest', day_code: null },
  FR: { type: 'gym', day_code: 'power' },
  SA: { type: 'run', day_code: 'long' },
  SU: { type: 'rest', day_code: null },
};

const OLD_EVENTS = new Map<string, CalendarEventRow>([
  ['p2:push', { id: 'ev-p2-push', phase_id: 'p2', day_code: 'push', summary: 'P2 Push', prescription: { block: 'bench' } }],
  ['p2:pull', { id: 'ev-p2-pull', phase_id: 'p2', day_code: 'pull', summary: 'P2 Pull', prescription: { block: 'row' } }],
  ['p2:easy', { id: 'ev-p2-easy', phase_id: 'p2', day_code: 'easy', summary: 'P2 Easy', prescription: { block: 'z2' } }],
  ['p2:lower', { id: 'ev-p2-lower', phase_id: 'p2', day_code: 'lower', summary: 'P2 Lower', prescription: { block: 'squat' } }],
  ['p2:upper', { id: 'ev-p2-upper', phase_id: 'p2', day_code: 'upper', summary: 'P2 Upper', prescription: { block: 'ohp' } }],
  ['p2:quality', { id: 'ev-p2-quality', phase_id: 'p2', day_code: 'quality', summary: 'P2 Quality', prescription: { block: 'tempo' } }],
]);

const NEW_EVENTS = new Map<string, CalendarEventRow>([
  ['p3:heavy_upper', { id: 'ev-p3-hu', phase_id: 'p3', day_code: 'heavy_upper', summary: 'P3 Heavy Upper', prescription: { block: 'hu' } }],
  ['p3:tempo', { id: 'ev-p3-tempo', phase_id: 'p3', day_code: 'tempo', summary: 'P3 Tempo', prescription: { block: 'tempo' } }],
  ['p3:heavy_lower', { id: 'ev-p3-hl', phase_id: 'p3', day_code: 'heavy_lower', summary: 'P3 Heavy Lower', prescription: { block: 'hl' } }],
  ['p3:power', { id: 'ev-p3-pwr', phase_id: 'p3', day_code: 'power', summary: 'P3 Power', prescription: { block: 'pwr' } }],
  ['p3:long', { id: 'ev-p3-long', phase_id: 'p3', day_code: 'long', summary: 'P3 Long', prescription: { block: 'long' } }],
]);

function baseArgs(overrides: Partial<BuildPhaseTransitionArgs> = {}): BuildPhaseTransitionArgs {
  return {
    userId: USER,
    todayIso: TODAY,
    phase: P2_BASE,
    nextPhase: P3_BASE,
    oldPattern: OLD_PATTERN,
    nextPattern: NEW_PATTERN,
    oldEventsByPhaseDay: OLD_EVENTS,
    nextEventsByPhaseDay: NEW_EVENTS,
    plansByDate: new Map(),
    ...overrides,
  };
}

function mkPlan(overrides: Partial<ExistingPlan> & { id: string; date: string }): ExistingPlan {
  return {
    id: overrides.id,
    date: overrides.date,
    type: overrides.type ?? 'gym',
    day_code: overrides.day_code ?? 'push',
    phase_id: overrides.phase_id ?? 'p2',
    status: overrides.status ?? 'planned',
    source: overrides.source ?? 'template',
  };
}

// -------- classify ---------------------------------------------------

describe('classifyPhaseTransition', () => {
  it('returns null for open-ended phase', () => {
    assert.equal(
      classifyPhaseTransition({ todayIso: TODAY, phase: { target_ends_on: null } }),
      null
    );
  });

  it('returns null when target is beyond soft window', () => {
    assert.equal(
      classifyPhaseTransition({
        todayIso: TODAY,
        phase: { target_ends_on: '2026-04-30' }, // 15 days out
      }),
      null
    );
  });

  it('returns soft when target is exactly at SOFT_TIER_WINDOW_DAYS', () => {
    const isoInWindow = '2026-04-22'; // 7 days out
    const r = classifyPhaseTransition({ todayIso: TODAY, phase: { target_ends_on: isoInWindow } });
    assert.equal(r?.tier, 'soft');
    assert.equal(r?.days_until, 7);
    assert.equal(r?.days_overdue, 0);
  });

  it('returns soft one day before boundary', () => {
    const r = classifyPhaseTransition({ todayIso: TODAY, phase: { target_ends_on: '2026-04-16' } });
    assert.equal(r?.tier, 'soft');
    assert.equal(r?.days_until, 1);
  });

  it('returns null one day past soft boundary', () => {
    const r = classifyPhaseTransition({ todayIso: TODAY, phase: { target_ends_on: '2026-04-23' } });
    assert.equal(r, null);
  });

  it('returns hard when target is today', () => {
    const r = classifyPhaseTransition({ todayIso: TODAY, phase: { target_ends_on: TODAY } });
    assert.equal(r?.tier, 'hard');
    assert.equal(r?.days_until, 0);
    assert.equal(r?.days_overdue, 0);
  });

  it('returns hard when overdue', () => {
    const r = classifyPhaseTransition({ todayIso: TODAY, phase: { target_ends_on: '2026-04-10' } });
    assert.equal(r?.tier, 'hard');
    assert.equal(r?.days_overdue, 5);
    assert.equal(r?.days_until, 0);
  });

  it('returns null when phase is not active', () => {
    const r = classifyPhaseTransition({
      todayIso: TODAY,
      phase: { target_ends_on: TODAY, status: 'completed' },
    });
    assert.equal(r, null);
  });
});

// -------- shouldPreserveExistingPlan ---------------------------------

describe('shouldPreserveExistingPlan', () => {
  it('does not preserve a planned, template row from this phase', () => {
    const r = shouldPreserveExistingPlan(
      mkPlan({ id: 'a', date: '2026-04-16', status: 'planned', source: 'template', phase_id: 'p2' }),
      'p2'
    );
    assert.equal(r.preserve, false);
  });

  it('preserves done rows as logged', () => {
    const r = shouldPreserveExistingPlan(
      mkPlan({ id: 'a', date: '2026-04-16', status: 'done' }),
      'p2'
    );
    assert.equal(r.preserve, true);
    assert.equal(r.reason, 'logged');
  });

  it('preserves manual rows', () => {
    const r = shouldPreserveExistingPlan(
      mkPlan({ id: 'a', date: '2026-04-16', source: 'manual' }),
      'p2'
    );
    assert.equal(r.preserve, true);
    assert.equal(r.reason, 'manual');
  });

  it('preserves ai_proposed rows', () => {
    const r = shouldPreserveExistingPlan(
      mkPlan({ id: 'a', date: '2026-04-16', source: 'ai_proposed' }),
      'p2'
    );
    assert.equal(r.preserve, true);
    assert.equal(r.reason, 'ai_proposed');
  });

  it('preserves rows already claimed by another phase', () => {
    const r = shouldPreserveExistingPlan(
      mkPlan({ id: 'a', date: '2026-04-16', phase_id: 'p3' }),
      'p2'
    );
    assert.equal(r.preserve, true);
    assert.equal(r.reason, 'other_phase');
  });

  it('does not preserve a row with null phase_id (unassigned template)', () => {
    const r = shouldPreserveExistingPlan(
      mkPlan({ id: 'a', date: '2026-04-16', phase_id: null }),
      'p2'
    );
    assert.equal(r.preserve, false);
  });

  it('preserves availability_window rows (P1.3 travel/injury/pause)', () => {
    const r = shouldPreserveExistingPlan(
      mkPlan({
        id: 'a',
        date: '2026-04-16',
        status: 'planned',
        source: 'availability_window',
        phase_id: 'p2',
      }),
      'p2'
    );
    assert.equal(r.preserve, true);
    assert.equal(r.reason, 'availability_window');
  });
});

// -------- main proposal: viability ----------------------------------

describe('buildPhaseTransitionProposal — viability', () => {
  it('returns null when phase is not within the trigger window', () => {
    const r = buildPhaseTransitionProposal(
      baseArgs({ phase: { ...P2_BASE, target_ends_on: '2026-05-15' } })
    );
    assert.equal(r, null);
  });

  it('returns a soft proposal when target_ends_on is 5 days out', () => {
    const r = buildPhaseTransitionProposal(baseArgs());
    assert.ok(r);
    assert.equal(r!.tier, 'soft');
    assert.equal(r!.days_until, 5);
  });

  it('returns a hard proposal when overdue', () => {
    const r = buildPhaseTransitionProposal(
      baseArgs({ phase: { ...P2_BASE, target_ends_on: '2026-04-10' } })
    );
    assert.ok(r);
    assert.equal(r!.tier, 'hard');
    assert.equal(r!.days_overdue, 5);
  });

  it('default is transition when next phase is fully bound', () => {
    const r = buildPhaseTransitionProposal(baseArgs())!;
    assert.equal(r.default_option_id, 'transition');
    assert.ok(r.options.some(o => o.id === 'transition'));
  });

  it('default is extend_2w when next phase has no bound training days', () => {
    const r = buildPhaseTransitionProposal(
      baseArgs({ nextEventsByPhaseDay: new Map() })
    )!;
    assert.equal(r.default_option_id, 'extend_2w');
    assert.ok(!r.options.some(o => o.id === 'transition'));
  });

  it('default is extend_2w when next phase is missing entirely', () => {
    const r = buildPhaseTransitionProposal(
      baseArgs({ nextPhase: null, nextPattern: null })
    )!;
    assert.equal(r.default_option_id, 'extend_2w');
    assert.ok(!r.options.some(o => o.id === 'transition'));
    assert.ok(r.options.some(o => o.id === 'end_phase'));
  });

  it('default is extend_2w when next phase exists but pattern is empty', () => {
    const r = buildPhaseTransitionProposal(
      baseArgs({ nextPattern: {} })
    )!;
    assert.equal(r.default_option_id, 'extend_2w');
    assert.ok(!r.options.some(o => o.id === 'transition'));
  });

  it('omits end_phase when a next phase exists', () => {
    const r = buildPhaseTransitionProposal(baseArgs())!;
    assert.ok(!r.options.some(o => o.id === 'end_phase'));
  });

  it('includes all extend options + reassess regardless of tier', () => {
    const r = buildPhaseTransitionProposal(baseArgs())!;
    assert.ok(r.options.some(o => o.id === 'extend_1w'));
    assert.ok(r.options.some(o => o.id === 'extend_2w'));
    assert.ok(r.options.some(o => o.id === 'extend_4w'));
    assert.ok(r.options.some(o => o.id === 'reassess'));
  });
});

// -------- transition option diff -------------------------------------

describe('buildPhaseTransitionProposal — transition diff', () => {
  it('creates new-phase plans for every day in (today, today+21]', () => {
    const r = buildPhaseTransitionProposal(baseArgs())!;
    const opt = r.options.find(o => o.id === 'transition')!;

    // 21 days forward. 3 rest days per week → approx. 3*3 = 9 rest in 21 days.
    // All 21 days should have a plan (rest counts).
    // Any skipped would be because NEW_PATTERN has a slot for every DOW.
    assert.equal(opt.plan_diff.creates.length, 21);
    // No deletes (plansByDate was empty).
    assert.equal(opt.plan_diff.deletes.length, 0);
  });

  it('never creates or deletes anything on today', () => {
    const r = buildPhaseTransitionProposal(baseArgs({
      plansByDate: new Map([[TODAY, mkPlan({ id: 'today', date: TODAY })]]),
    }))!;
    const opt = r.options.find(o => o.id === 'transition')!;
    assert.equal(opt.plan_diff.creates.some(c => c.date === TODAY), false);
    assert.equal(opt.plan_diff.deletes.some(d => d.date === TODAY), false);
  });

  it('deletes replaceable old-phase planned rows and creates fresh rows', () => {
    const tomorrow = '2026-04-16';
    const r = buildPhaseTransitionProposal(baseArgs({
      plansByDate: new Map([[
        tomorrow,
        mkPlan({ id: 'old-1', date: tomorrow, type: 'gym', day_code: 'upper', phase_id: 'p2', source: 'template', status: 'planned' }),
      ]]),
    }))!;
    const opt = r.options.find(o => o.id === 'transition')!;
    assert.ok(opt.plan_diff.deletes.some(d => d.plan_id === 'old-1' && d.date === tomorrow));
    assert.ok(opt.plan_diff.creates.some(c => c.date === tomorrow && c.phase_id === 'p3'));
  });

  it('preserves logged rows, counts them in skipped_logged', () => {
    const tomorrow = '2026-04-16';
    const r = buildPhaseTransitionProposal(baseArgs({
      plansByDate: new Map([[
        tomorrow,
        mkPlan({ id: 'done-1', date: tomorrow, status: 'done', source: 'template', phase_id: 'p2' }),
      ]]),
    }))!;
    const opt = r.options.find(o => o.id === 'transition')!;
    assert.ok(!opt.plan_diff.deletes.some(d => d.plan_id === 'done-1'));
    assert.ok(!opt.plan_diff.creates.some(c => c.date === tomorrow));
    assert.equal(opt.summary.skipped_logged, 1);
  });

  it('preserves manual rows', () => {
    const tomorrow = '2026-04-16';
    const r = buildPhaseTransitionProposal(baseArgs({
      plansByDate: new Map([[
        tomorrow,
        mkPlan({ id: 'man-1', date: tomorrow, source: 'manual', status: 'planned' }),
      ]]),
    }))!;
    const opt = r.options.find(o => o.id === 'transition')!;
    assert.ok(!opt.plan_diff.deletes.some(d => d.plan_id === 'man-1'));
    assert.ok(!opt.plan_diff.creates.some(c => c.date === tomorrow));
    assert.equal(opt.summary.skipped_manual, 1);
  });

  it('preserves ai_proposed rows', () => {
    const tomorrow = '2026-04-16';
    const r = buildPhaseTransitionProposal(baseArgs({
      plansByDate: new Map([[
        tomorrow,
        mkPlan({ id: 'ai-1', date: tomorrow, source: 'ai_proposed' }),
      ]]),
    }))!;
    const opt = r.options.find(o => o.id === 'transition')!;
    assert.ok(!opt.plan_diff.deletes.some(d => d.plan_id === 'ai-1'));
    assert.equal(opt.summary.skipped_ai_proposed, 1);
  });

  it('preserves rows already claimed by another phase', () => {
    const tomorrow = '2026-04-16';
    const r = buildPhaseTransitionProposal(baseArgs({
      plansByDate: new Map([[
        tomorrow,
        mkPlan({ id: 'p3-1', date: tomorrow, phase_id: 'p3' }),
      ]]),
    }))!;
    const opt = r.options.find(o => o.id === 'transition')!;
    // "other_phase" isn't counted in skipped_* but it's preserved:
    assert.ok(!opt.plan_diff.deletes.some(d => d.plan_id === 'p3-1'));
    assert.ok(!opt.plan_diff.creates.some(c => c.date === tomorrow));
  });

  it('preserves availability_window rows and counts them (P1.3)', () => {
    const tomorrow = '2026-04-16';
    const r = buildPhaseTransitionProposal(baseArgs({
      plansByDate: new Map([[
        tomorrow,
        mkPlan({
          id: 'win-1',
          date: tomorrow,
          source: 'availability_window',
          status: 'planned',
          phase_id: 'p2',
          type: 'bodyweight',
        }),
      ]]),
    }))!;
    const opt = r.options.find(o => o.id === 'transition')!;
    // Window row is NOT deleted, and NOT overwritten by a new-phase create.
    assert.ok(!opt.plan_diff.deletes.some(d => d.plan_id === 'win-1'));
    assert.ok(!opt.plan_diff.creates.some(c => c.date === tomorrow));
    assert.equal(opt.summary.skipped_availability_window, 1);
  });

  it('clips creates at next phase target_ends_on', () => {
    const r = buildPhaseTransitionProposal(baseArgs({
      nextPhase: { ...P3_BASE, target_ends_on: '2026-04-20' }, // only 5 days of new phase
    }))!;
    const opt = r.options.find(o => o.id === 'transition')!;
    // Forward window (today, today+21] clipped to <= 2026-04-20 → 5 days.
    assert.ok(opt.plan_diff.creates.every(c => c.date <= '2026-04-20'));
    assert.equal(opt.plan_diff.creates.length, 5);
  });

  it('flags orphan day_codes when a new-phase slot has no calendar_event', () => {
    // Strip one event from NEW_EVENTS so slot.heavy_upper is orphaned.
    const partialEvents = new Map(NEW_EVENTS);
    partialEvents.delete('p3:heavy_upper');
    const r = buildPhaseTransitionProposal(baseArgs({
      nextEventsByPhaseDay: partialEvents,
    }))!;
    const opt = r.options.find(o => o.id === 'transition')!;
    assert.ok(opt.summary.orphan_day_codes.length > 0);
    assert.ok(opt.summary.orphan_day_codes.every(o => o.day_code === 'heavy_upper'));
    // The orphan still creates a plan row with empty prescription.
    const orphanCreate = opt.plan_diff.creates.find(c => c.day_code === 'heavy_upper');
    assert.ok(orphanCreate?.is_orphan);
    assert.deepEqual(orphanCreate?.prescription, {});
  });

  it('rest slots create placeholder plans (not orphan)', () => {
    const r = buildPhaseTransitionProposal(baseArgs())!;
    const opt = r.options.find(o => o.id === 'transition')!;
    const rest = opt.plan_diff.creates.find(c => c.type === 'rest');
    assert.ok(rest);
    assert.equal(rest!.is_orphan, false);
    assert.deepEqual(rest!.prescription, {});
  });

  it('binds prescription from calendar_event for training slots', () => {
    const r = buildPhaseTransitionProposal(baseArgs())!;
    const opt = r.options.find(o => o.id === 'transition')!;
    const hu = opt.plan_diff.creates.find(c => c.day_code === 'heavy_upper');
    assert.ok(hu);
    assert.equal(hu!.calendar_event_id, 'ev-p3-hu');
    assert.deepEqual(hu!.prescription, { block: 'hu' });
  });

  it('deletes old-phase planned row on DOW where new pattern has no slot', () => {
    // Build a pattern missing MO, then check: existing MO planned row → deleted,
    // no replacement created.
    const patternNoMo: WeeklyPattern = { ...NEW_PATTERN };
    delete patternNoMo.MO;
    const tomorrowMon = '2026-04-20'; // Monday
    const r = buildPhaseTransitionProposal(baseArgs({
      nextPattern: patternNoMo,
      plansByDate: new Map([[
        tomorrowMon,
        mkPlan({ id: 'mon-1', date: tomorrowMon, type: 'gym', day_code: 'push', phase_id: 'p2', source: 'template' }),
      ]]),
    }))!;
    const opt = r.options.find(o => o.id === 'transition')!;
    assert.ok(opt.plan_diff.deletes.some(d => d.plan_id === 'mon-1'));
    assert.ok(!opt.plan_diff.creates.some(c => c.date === tomorrowMon));
  });

  it('sets phase_updates on both phases for transition', () => {
    const r = buildPhaseTransitionProposal(baseArgs())!;
    const opt = r.options.find(o => o.id === 'transition')!;
    assert.equal(opt.phase_updates.length, 2);
    const oldUp = opt.phase_updates.find(u => u.phase_id === 'p2')!;
    assert.equal(oldUp.patch.status, 'completed');
    assert.equal(oldUp.patch.target_ends_on, TODAY);
    assert.equal(oldUp.patch.actual_ends_on, TODAY);
    const newUp = opt.phase_updates.find(u => u.phase_id === 'p3')!;
    assert.equal(newUp.patch.status, 'active');
    assert.equal(newUp.patch.starts_on, '2026-04-16');
  });
});

// -------- extend options ---------------------------------------------

describe('buildPhaseTransitionProposal — extend diffs', () => {
  it('extend_1w sets target_ends_on to today+7', () => {
    const r = buildPhaseTransitionProposal(baseArgs())!;
    const opt = r.options.find(o => o.id === 'extend_1w')!;
    assert.equal(opt.phase_updates[0].patch.target_ends_on, '2026-04-22');
  });

  it('extend_2w sets target_ends_on to today+14', () => {
    const r = buildPhaseTransitionProposal(baseArgs())!;
    const opt = r.options.find(o => o.id === 'extend_2w')!;
    assert.equal(opt.phase_updates[0].patch.target_ends_on, '2026-04-29');
  });

  it('extend_4w sets target_ends_on to today+28', () => {
    const r = buildPhaseTransitionProposal(baseArgs())!;
    const opt = r.options.find(o => o.id === 'extend_4w')!;
    assert.equal(opt.phase_updates[0].patch.target_ends_on, '2026-05-13');
  });

  it('extend fills plan rows in the stretched window using the old pattern', () => {
    // Old target was 2026-04-20; extend_2w → 2026-04-29 (9 new days).
    const r = buildPhaseTransitionProposal(baseArgs())!;
    const opt = r.options.find(o => o.id === 'extend_2w')!;
    // With empty plansByDate, we fill (today, today+14] = 14 days.
    assert.equal(opt.plan_diff.creates.length, 14);
    assert.equal(opt.plan_diff.deletes.length, 0);
    // All bound to p2.
    assert.ok(opt.plan_diff.creates.every(c => c.phase_id === 'p2'));
  });

  it('extend does not create plans for dates that already have any plan', () => {
    const tomorrow = '2026-04-16';
    const r = buildPhaseTransitionProposal(baseArgs({
      plansByDate: new Map([[
        tomorrow,
        mkPlan({ id: 'existing', date: tomorrow, status: 'planned' }),
      ]]),
    }))!;
    const opt = r.options.find(o => o.id === 'extend_2w')!;
    assert.ok(!opt.plan_diff.creates.some(c => c.date === tomorrow));
  });

  it('extend recommended when no transition is available', () => {
    const r = buildPhaseTransitionProposal(baseArgs({ nextPhase: null, nextPattern: null }))!;
    const opt = r.options.find(o => o.id === 'extend_2w')!;
    assert.equal(opt.recommended, true);
  });

  it('extend not recommended when transition is available', () => {
    const r = buildPhaseTransitionProposal(baseArgs())!;
    assert.ok(r.options.filter(o => o.id.startsWith('extend_')).every(o => !o.recommended));
  });

  it('extend with no old pattern → still bumps target, no creates', () => {
    const r = buildPhaseTransitionProposal(baseArgs({ oldPattern: null }))!;
    const opt = r.options.find(o => o.id === 'extend_2w')!;
    assert.equal(opt.phase_updates[0].patch.target_ends_on, '2026-04-29');
    assert.equal(opt.plan_diff.creates.length, 0);
  });
});

// -------- end_phase --------------------------------------------------

describe('buildPhaseTransitionProposal — end_phase', () => {
  it('end_phase deletes replaceable future planned rows', () => {
    const tomorrow = '2026-04-16';
    const r = buildPhaseTransitionProposal(baseArgs({
      nextPhase: null,
      nextPattern: null,
      plansByDate: new Map([[
        tomorrow,
        mkPlan({ id: 'fut-1', date: tomorrow, phase_id: 'p2', status: 'planned', source: 'template' }),
      ]]),
    }))!;
    const opt = r.options.find(o => o.id === 'end_phase')!;
    assert.ok(opt.plan_diff.deletes.some(d => d.plan_id === 'fut-1'));
    assert.equal(opt.plan_diff.creates.length, 0);
  });

  it('end_phase preserves done / manual / ai_proposed rows', () => {
    const r = buildPhaseTransitionProposal(baseArgs({
      nextPhase: null,
      nextPattern: null,
      plansByDate: new Map([
        ['2026-04-16', mkPlan({ id: 'd', date: '2026-04-16', status: 'done' })],
        ['2026-04-17', mkPlan({ id: 'm', date: '2026-04-17', source: 'manual' })],
        ['2026-04-18', mkPlan({ id: 'a', date: '2026-04-18', source: 'ai_proposed' })],
      ]),
    }))!;
    const opt = r.options.find(o => o.id === 'end_phase')!;
    assert.ok(!opt.plan_diff.deletes.some(d => d.plan_id === 'd'));
    assert.ok(!opt.plan_diff.deletes.some(d => d.plan_id === 'm'));
    assert.ok(!opt.plan_diff.deletes.some(d => d.plan_id === 'a'));
    assert.equal(opt.summary.skipped_logged, 1);
    assert.equal(opt.summary.skipped_manual, 1);
    assert.equal(opt.summary.skipped_ai_proposed, 1);
  });

  it('end_phase has action=end and updates phase to completed/today', () => {
    const r = buildPhaseTransitionProposal(baseArgs({ nextPhase: null, nextPattern: null }))!;
    const opt = r.options.find(o => o.id === 'end_phase')!;
    assert.equal(opt.action, 'end');
    assert.equal(opt.phase_updates[0].patch.status, 'completed');
    assert.equal(opt.phase_updates[0].patch.target_ends_on, TODAY);
    assert.equal(opt.phase_updates[0].patch.actual_ends_on, TODAY);
  });
});

// -------- reassess --------------------------------------------------

describe('buildPhaseTransitionProposal — reassess', () => {
  it('reassess has no phase_updates and no plan_diff', () => {
    const r = buildPhaseTransitionProposal(baseArgs())!;
    const opt = r.options.find(o => o.id === 'reassess')!;
    assert.equal(opt.phase_updates.length, 0);
    assert.equal(opt.plan_diff.creates.length, 0);
    assert.equal(opt.plan_diff.deletes.length, 0);
    assert.equal(opt.action, 'reassess');
  });
});

// -------- window & today-never-touched -------------------------------

describe('buildPhaseTransitionProposal — window semantics', () => {
  it('window is (today, today+21] by default', () => {
    const r = buildPhaseTransitionProposal(baseArgs())!;
    assert.equal(r.window.start, '2026-04-16');
    assert.equal(r.window.end, '2026-05-06');
    const opt = r.options.find(o => o.id === 'transition')!;
    // No creates on or before today
    assert.ok(opt.plan_diff.creates.every(c => c.date > TODAY));
    assert.ok(opt.plan_diff.creates.every(c => c.date <= '2026-05-06'));
  });

  it('respects windowDays override', () => {
    const r = buildPhaseTransitionProposal(baseArgs({ windowDays: 7 }))!;
    assert.equal(r.window.end, '2026-04-22');
    const opt = r.options.find(o => o.id === 'transition')!;
    assert.equal(opt.plan_diff.creates.length, 7);
  });
});

// -------- idempotency ------------------------------------------------

describe('buildPhaseTransitionProposal — idempotency', () => {
  it('running twice with identical inputs yields identical outputs', () => {
    const a = buildPhaseTransitionProposal(baseArgs())!;
    const b = buildPhaseTransitionProposal(baseArgs())!;
    assert.deepEqual(a, b);
  });

  it('after applying the transition diff (simulated), re-running with those plans preserves them', () => {
    const first = buildPhaseTransitionProposal(baseArgs())!;
    const tOpt = first.options.find(o => o.id === 'transition')!;

    // Simulate: apply produces plans with the new phase_id.
    const applied = new Map<string, ExistingPlan>();
    for (const c of tOpt.plan_diff.creates) {
      applied.set(c.date, {
        id: `new-${c.date}`,
        date: c.date,
        type: c.type,
        day_code: c.day_code,
        phase_id: c.phase_id, // 'p3' for transition creates
        status: 'planned',
        source: 'template',
      });
    }

    // Re-run — but simulate phase having transitioned: old is no longer
    // in trigger window (end moved to today), new phase becomes active.
    // The rerun should not see transition as viable anymore because
    // the phase passed is the same p2; however the transition option
    // will find existing p3 plans in the window and preserve them
    // (other_phase) — so creates/deletes shrink to 0.
    const second = buildPhaseTransitionProposal(baseArgs({ plansByDate: applied }))!;
    const tOpt2 = second.options.find(o => o.id === 'transition')!;
    assert.equal(tOpt2.plan_diff.creates.length, 0);
    assert.equal(tOpt2.plan_diff.deletes.length, 0);
  });
});

// -------- rationale smoke tests --------------------------------------

describe('buildPhaseTransitionProposal — rationale strings', () => {
  it('soft rationale mentions days remaining', () => {
    const r = buildPhaseTransitionProposal(baseArgs())!;
    assert.match(r.rationale, /5 days|ends in 5/);
  });

  it('hard/today rationale mentions "ends today"', () => {
    const r = buildPhaseTransitionProposal(
      baseArgs({ phase: { ...P2_BASE, target_ends_on: TODAY } })
    )!;
    assert.match(r.rationale, /ends today/i);
  });

  it('overdue rationale mentions wrapped', () => {
    const r = buildPhaseTransitionProposal(
      baseArgs({ phase: { ...P2_BASE, target_ends_on: '2026-04-10' } })
    )!;
    assert.match(r.rationale, /wrapped 5 days ago/i);
  });

  it('tomorrow rationale is singular', () => {
    const r = buildPhaseTransitionProposal(
      baseArgs({ phase: { ...P2_BASE, target_ends_on: '2026-04-16' } })
    )!;
    assert.match(r.rationale, /ends tomorrow/i);
  });

  it('mentions next phase code when transitioning', () => {
    const r = buildPhaseTransitionProposal(baseArgs())!;
    const opt = r.options.find(o => o.id === 'transition')!;
    assert.match(opt.label, /P3/);
    assert.match(opt.rationale, /P3/);
  });
});

// -------- constants sanity -------------------------------------------

describe('constants', () => {
  it('PHASE_TRANSITION_WINDOW_DAYS is 21', () => {
    assert.equal(PHASE_TRANSITION_WINDOW_DAYS, 21);
  });
  it('SOFT_TIER_WINDOW_DAYS is 7', () => {
    assert.equal(SOFT_TIER_WINDOW_DAYS, 7);
  });
});
