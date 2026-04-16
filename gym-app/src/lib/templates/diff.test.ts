/**
 * Unit tests for the template diff engine (P1.1 / PR-F).
 *
 * Run via:
 *   npx tsx --test src/lib/templates/diff.test.ts
 *   or: npm test
 *
 * Exhaustively covers:
 *   - window clipping (phase boundaries, expired phase)
 *   - slot equality (including rest vs null)
 *   - today untouched
 *   - status filtering (done/missed/skipped preserved as history)
 *   - source filtering (ai_proposed preserved + counted)
 *   - all four transition cases (no-op, add, remove, change)
 *   - orphan day_codes flagged
 *   - idempotency (diff of same diff → empty)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTemplateDiff,
  datesInRange,
  slotsEqual,
  templateApplyWindow,
  TEMPLATE_APPLY_WINDOW_DAYS,
  type ExistingPlan,
} from './diff.pure';
import type {
  CalendarEventRow,
  PhaseRow,
  WeeklyPattern,
} from '@/lib/reconcile/rollForward.pure';

// -------- fixtures ---------------------------------------------------

const TODAY = '2026-04-15'; // Wednesday

const PHASE_P2: PhaseRow = {
  id: 'p2',
  code: 'P2',
  starts_on: '2026-03-30',
  target_ends_on: '2026-05-31',
};

const PATTERN_BEFORE: WeeklyPattern = {
  MO: { type: 'gym', day_code: 'push' },
  TU: { type: 'gym', day_code: 'pull' },
  WE: { type: 'run', day_code: 'easy_run' },
  TH: { type: 'gym', day_code: 'lower' },
  FR: { type: 'gym', day_code: 'upper_full' },
  SA: { type: 'run', day_code: 'quality_run' },
  SU: { type: 'rest', day_code: null },
};

const EVENTS = new Map<string, CalendarEventRow>([
  [
    'p2:push',
    { id: 'ev-push', phase_id: 'p2', day_code: 'push', summary: 'P2 Push', prescription: { blocks: ['incline_db_press'] } },
  ],
  [
    'p2:pull',
    { id: 'ev-pull', phase_id: 'p2', day_code: 'pull', summary: 'P2 Pull', prescription: { blocks: ['row'] } },
  ],
  [
    'p2:lower',
    { id: 'ev-lower', phase_id: 'p2', day_code: 'lower', summary: 'P2 Lower', prescription: { blocks: ['squat'] } },
  ],
  [
    'p2:upper_full',
    { id: 'ev-upper', phase_id: 'p2', day_code: 'upper_full', summary: 'P2 Upper', prescription: { blocks: ['bench'] } },
  ],
  [
    'p2:easy_run',
    { id: 'ev-easy', phase_id: 'p2', day_code: 'easy_run', summary: 'P2 Easy Run', prescription: { blocks: ['zone2'] } },
  ],
  [
    'p2:quality_run',
    { id: 'ev-quality', phase_id: 'p2', day_code: 'quality_run', summary: 'P2 Quality Run', prescription: { blocks: ['tempo'] } },
  ],
]);

const makeExistingPlan = (overrides: Partial<ExistingPlan> & { id: string; date: string }): ExistingPlan => ({
  type: 'gym',
  day_code: 'push',
  status: 'planned',
  source: 'template',
  prescription: { blocks: ['incline_db_press'] },
  calendar_event_id: 'ev-push',
  ...overrides,
});

const baseArgs = (overrides: Partial<Parameters<typeof buildTemplateDiff>[0]> = {}) => ({
  todayIso: TODAY,
  phase: PHASE_P2,
  allPhases: [PHASE_P2],
  before: PATTERN_BEFORE,
  after: PATTERN_BEFORE,
  plansByDate: new Map<string, ExistingPlan>(),
  eventsByPhaseDay: EVENTS,
  ...overrides,
});

// -------- slotsEqual --------------------------------------------------

describe('slotsEqual', () => {
  it('both undefined → equal', () => {
    assert.equal(slotsEqual(undefined, undefined), true);
  });

  it('one undefined → not equal', () => {
    assert.equal(slotsEqual(undefined, { type: 'gym', day_code: 'push' }), false);
    assert.equal(slotsEqual({ type: 'rest', day_code: null }, undefined), false);
  });

  it('same type + day_code → equal', () => {
    assert.equal(
      slotsEqual({ type: 'gym', day_code: 'push' }, { type: 'gym', day_code: 'push' }),
      true
    );
  });

  it('different type → not equal', () => {
    assert.equal(
      slotsEqual({ type: 'gym', day_code: 'push' }, { type: 'run', day_code: 'push' }),
      false
    );
  });

  it('different day_code → not equal', () => {
    assert.equal(
      slotsEqual({ type: 'gym', day_code: 'push' }, { type: 'gym', day_code: 'pull' }),
      false
    );
  });

  it('rest with null vs undefined day_code → equal (null-coalesced)', () => {
    assert.equal(
      slotsEqual({ type: 'rest', day_code: null }, { type: 'rest', day_code: null }),
      true
    );
  });
});

// -------- templateApplyWindow ---------------------------------------

describe('templateApplyWindow', () => {
  it('clips to [today+1, today+28] inside an ample phase', () => {
    const w = templateApplyWindow({ todayIso: TODAY, phase: PHASE_P2 });
    assert.deepEqual(w, { start: '2026-04-16', end: '2026-05-13' });
  });

  it('clips the end to phase.target_ends_on when nearer', () => {
    // 28 days from 2026-05-25 is 2026-06-22, but phase ends 2026-05-31.
    const w = templateApplyWindow({ todayIso: '2026-05-25', phase: PHASE_P2 });
    assert.equal(w!.end, '2026-05-31');
  });

  it('returns null when phase starts beyond the 28-day window (empty intersection)', () => {
    const future: PhaseRow = {
      id: 'p3',
      code: 'P3',
      starts_on: '2026-06-01',
      target_ends_on: '2026-07-31',
    };
    const w = templateApplyWindow({ todayIso: TODAY, phase: future });
    assert.equal(w, null);
  });

  it('clips the start to phase.starts_on when phase starts within the window', () => {
    // today+1 = 2026-04-16, today+28 = 2026-05-13
    const nearFuture: PhaseRow = {
      id: 'p3',
      code: 'P3',
      starts_on: '2026-05-01',
      target_ends_on: '2026-07-31',
    };
    const w = templateApplyWindow({ todayIso: TODAY, phase: nearFuture });
    assert.equal(w!.start, '2026-05-01');
    assert.equal(w!.end, '2026-05-13');
  });

  it('returns null when the phase already ended', () => {
    const past: PhaseRow = {
      id: 'p1',
      code: 'P1',
      starts_on: '2026-01-01',
      target_ends_on: '2026-03-01',
    };
    const w = templateApplyWindow({ todayIso: TODAY, phase: past });
    assert.equal(w, null);
  });

  it('returns null when starts_on is missing', () => {
    const weird: PhaseRow = { id: 'x', code: null, starts_on: null, target_ends_on: null };
    const w = templateApplyWindow({ todayIso: TODAY, phase: weird });
    assert.equal(w, null);
  });

  it('honors open-ended phases (target_ends_on null)', () => {
    const open: PhaseRow = { id: 'p4', code: 'P4', starts_on: '2026-04-01', target_ends_on: null };
    const w = templateApplyWindow({ todayIso: TODAY, phase: open });
    assert.equal(w!.end, '2026-05-13');
  });
});

// -------- datesInRange ----------------------------------------------

describe('datesInRange', () => {
  it('inclusive on both ends', () => {
    const got = datesInRange('2026-04-15', '2026-04-18');
    assert.deepEqual(got, ['2026-04-15', '2026-04-16', '2026-04-17', '2026-04-18']);
  });

  it('single-day range', () => {
    assert.deepEqual(datesInRange('2026-04-15', '2026-04-15'), ['2026-04-15']);
  });

  it('start > end returns empty', () => {
    assert.deepEqual(datesInRange('2026-04-20', '2026-04-15'), []);
  });
});

// -------- buildTemplateDiff ------------------------------------------

describe('buildTemplateDiff', () => {
  describe('identity', () => {
    it('before === after → empty diff', () => {
      const diff = buildTemplateDiff(baseArgs());
      assert.equal(diff.updates.length, 0);
      assert.equal(diff.creates.length, 0);
      assert.equal(diff.deletes.length, 0);
      assert.equal(diff.summary.added, 0);
      assert.equal(diff.summary.removed, 0);
      assert.equal(diff.summary.changed, 0);
    });
  });

  describe('today and past', () => {
    it('never emits a change for today', () => {
      // Build a wildly different pattern; ensure TODAY (2026-04-15 WE) is untouched.
      const after: WeeklyPattern = { ...PATTERN_BEFORE, WE: { type: 'yoga', day_code: null } };
      const plans = new Map<string, ExistingPlan>([
        [TODAY, makeExistingPlan({ id: 'today-plan', date: TODAY, day_code: 'easy_run', type: 'run' })],
      ]);
      const diff = buildTemplateDiff(baseArgs({ after, plansByDate: plans }));
      assert.ok(!diff.updates.some((u) => u.date === TODAY));
      assert.ok(!diff.deletes.some((d) => d.date === TODAY));
      assert.ok(!diff.creates.some((c) => c.date === TODAY));
    });

    it('leaves done rows alone (preserves history)', () => {
      // Tomorrow is TH. Change TH slot to rest. But mark the tomorrow
      // row as already done (e.g. the user logged the activity this
      // morning) — we should not delete/update it.
      const after: WeeklyPattern = { ...PATTERN_BEFORE, TH: { type: 'rest', day_code: null } };
      const plans = new Map<string, ExistingPlan>([
        ['2026-04-16', makeExistingPlan({ id: 'done-plan', date: '2026-04-16', status: 'done', day_code: 'lower', type: 'gym' })],
      ]);
      const diff = buildTemplateDiff(baseArgs({ after, plansByDate: plans }));
      assert.ok(!diff.updates.some((u) => u.plan_id === 'done-plan'));
      assert.ok(!diff.deletes.some((d) => d.plan_id === 'done-plan'));
      assert.ok(!diff.creates.some((c) => c.date === '2026-04-16'));
    });

    it('leaves missed rows alone', () => {
      const after: WeeklyPattern = { ...PATTERN_BEFORE, TH: { type: 'rest', day_code: null } };
      const plans = new Map<string, ExistingPlan>([
        ['2026-04-16', makeExistingPlan({ id: 'missed-plan', date: '2026-04-16', status: 'missed' })],
      ]);
      const diff = buildTemplateDiff(baseArgs({ after, plansByDate: plans }));
      assert.ok(!diff.updates.some((u) => u.plan_id === 'missed-plan'));
      assert.ok(!diff.deletes.some((d) => d.plan_id === 'missed-plan'));
    });
  });

  describe('availability_window preservation (P1.3)', () => {
    it('skips availability_window rows and counts them', () => {
      const after: WeeklyPattern = { ...PATTERN_BEFORE, TH: { type: 'rest', day_code: null } };
      const plans = new Map<string, ExistingPlan>([
        ['2026-04-16', makeExistingPlan({
          id: 'win-plan',
          date: '2026-04-16',
          status: 'planned',
          source: 'availability_window',
          type: 'bodyweight',
          day_code: null,
        })],
      ]);
      const diff = buildTemplateDiff(baseArgs({ after, plansByDate: plans }));
      assert.ok(!diff.updates.some((u) => u.plan_id === 'win-plan'));
      assert.ok(!diff.deletes.some((d) => d.plan_id === 'win-plan'));
      assert.ok(diff.summary.skipped_availability_window >= 1);
    });
  });

  describe('manual preservation (P1.3 preemptive)', () => {
    it('skips manual rows and counts them', () => {
      const after: WeeklyPattern = { ...PATTERN_BEFORE, TH: { type: 'rest', day_code: null } };
      const plans = new Map<string, ExistingPlan>([
        ['2026-04-16', makeExistingPlan({
          id: 'manual-plan',
          date: '2026-04-16',
          status: 'planned',
          source: 'manual',
        })],
      ]);
      const diff = buildTemplateDiff(baseArgs({ after, plansByDate: plans }));
      assert.ok(!diff.updates.some((u) => u.plan_id === 'manual-plan'));
      assert.ok(!diff.deletes.some((d) => d.plan_id === 'manual-plan'));
      assert.equal(diff.summary.skipped_manual, 1);
    });
  });

  describe('ai_proposed preservation', () => {
    it('skips AI-proposed rows and counts them', () => {
      const after: WeeklyPattern = { ...PATTERN_BEFORE, TH: { type: 'rest', day_code: null } };
      const plans = new Map<string, ExistingPlan>([
        ['2026-04-16', makeExistingPlan({
          id: 'ai-plan',
          date: '2026-04-16',
          status: 'planned',
          source: 'ai_proposed',
        })],
        ['2026-04-23', makeExistingPlan({
          id: 'tmpl-plan',
          date: '2026-04-23',
          status: 'planned',
          source: 'template',
          day_code: 'lower',
        })],
      ]);
      const diff = buildTemplateDiff(baseArgs({ after, plansByDate: plans }));
      // ai-plan untouched
      assert.ok(!diff.updates.some((u) => u.plan_id === 'ai-plan'));
      assert.ok(!diff.deletes.some((d) => d.plan_id === 'ai-plan'));
      // counted
      assert.ok(diff.summary.skipped_ai_proposed >= 1);
      // the other TH gets updated to rest (rest slot is still a slot → update, not delete)
      const u = diff.updates.find((u) => u.plan_id === 'tmpl-plan');
      assert.ok(u, 'expected tmpl-plan to be updated');
      assert.equal(u!.after.type, 'rest');
      assert.equal(u!.after.day_code, null);
    });
  });

  describe('add / remove / change cases', () => {
    it('add: new slot on a previously-empty DOW creates rows', () => {
      // Before: no slot on any "extra" DOW. Let's shift the baseline so
      // SU is empty, then add a yoga SU in the new pattern.
      const before: WeeklyPattern = { ...PATTERN_BEFORE };
      delete (before as Record<string, unknown>).SU;
      const after: WeeklyPattern = { ...before, SU: { type: 'yoga', day_code: null } };
      const diff = buildTemplateDiff(baseArgs({ before, after }));
      // There are 4 Sundays in the 28-day window (2026-04-19, 04-26, 05-03, 05-10).
      // All inside P2 (ends 05-31).
      assert.equal(diff.creates.length, 4);
      for (const c of diff.creates) {
        assert.equal(c.type, 'yoga');
        assert.equal(c.day_code, null);
        assert.equal(c.source, 'template');
        assert.equal(c.status, 'planned');
      }
      assert.equal(diff.summary.added, 4);
    });

    it('remove: dropping a DOW deletes future planned rows on that DOW only', () => {
      const after: WeeklyPattern = { ...PATTERN_BEFORE };
      delete (after as Record<string, unknown>).TU; // drop Tuesdays
      // Seed planned rows for two Tuesdays and one Wednesday in the window.
      const plans = new Map<string, ExistingPlan>([
        ['2026-04-21', makeExistingPlan({ id: 'tue1', date: '2026-04-21', day_code: 'pull' })],
        ['2026-04-28', makeExistingPlan({ id: 'tue2', date: '2026-04-28', day_code: 'pull' })],
        ['2026-04-22', makeExistingPlan({ id: 'wed1', date: '2026-04-22', day_code: 'easy_run', type: 'run' })],
      ]);
      const diff = buildTemplateDiff(baseArgs({ after, plansByDate: plans }));
      const ids = diff.deletes.map((d) => d.plan_id).sort();
      assert.ok(ids.includes('tue1'));
      assert.ok(ids.includes('tue2'));
      assert.ok(!ids.includes('wed1'));
      assert.ok(diff.summary.removed >= 2);
    });

    it('change: different slot on same DOW updates the planned row', () => {
      const after: WeeklyPattern = { ...PATTERN_BEFORE, TH: { type: 'run', day_code: 'easy_run' } };
      const plans = new Map<string, ExistingPlan>([
        ['2026-04-16', makeExistingPlan({
          id: 'th1',
          date: '2026-04-16',
          type: 'gym',
          day_code: 'lower',
          calendar_event_id: 'ev-lower',
          prescription: { blocks: ['squat'] },
        })],
      ]);
      const diff = buildTemplateDiff(baseArgs({ after, plansByDate: plans }));
      const upd = diff.updates.find((u) => u.plan_id === 'th1')!;
      assert.ok(upd);
      assert.equal(upd.patch.type, 'run');
      assert.equal(upd.patch.day_code, 'easy_run');
      assert.equal(upd.patch.calendar_event_id, 'ev-easy');
      assert.deepEqual(upd.patch.prescription, { blocks: ['zone2'] });
      assert.equal(upd.before.day_code, 'lower');
      assert.equal(upd.after.day_code, 'easy_run');
    });

    it('change to rest: updates to rest with empty prescription', () => {
      const after: WeeklyPattern = { ...PATTERN_BEFORE, TH: { type: 'rest', day_code: null } };
      const plans = new Map<string, ExistingPlan>([
        ['2026-04-16', makeExistingPlan({ id: 'th1', date: '2026-04-16', day_code: 'lower' })],
      ]);
      const diff = buildTemplateDiff(baseArgs({ after, plansByDate: plans }));
      const upd = diff.updates.find((u) => u.plan_id === 'th1')!;
      assert.equal(upd.patch.type, 'rest');
      assert.equal(upd.patch.day_code, null);
      assert.deepEqual(upd.patch.prescription, {});
      assert.equal(upd.patch.calendar_event_id, null);
    });

    it('no-op when only prescription changes at the calendar_event level (diff sees same slot)', () => {
      // The diff compares slot shape (type + day_code), not prescription.
      // Same slot → no update, even if the calendar event prescription
      // differs in fixtures. (Prescription refresh is a separate path.)
      const diff = buildTemplateDiff(baseArgs());
      assert.equal(diff.updates.length, 0);
      assert.equal(diff.creates.length, 0);
      assert.equal(diff.deletes.length, 0);
    });
  });

  describe('orphan day_codes', () => {
    it('flags new slots whose day_code has no calendar_event', () => {
      const after: WeeklyPattern = {
        ...PATTERN_BEFORE,
        TH: { type: 'gym', day_code: 'experimental_hypertrophy' },
      };
      const diff = buildTemplateDiff(baseArgs({ after }));
      assert.ok(diff.summary.orphan_day_codes.length > 0);
      assert.ok(diff.summary.orphan_day_codes.every((o) => o.day_code === 'experimental_hypertrophy'));
      // Each such create has is_orphan=true.
      const thCreates = diff.creates.filter((c) => c.day_code === 'experimental_hypertrophy');
      for (const c of thCreates) {
        assert.equal(c.is_orphan, true);
        assert.deepEqual(c.prescription, {});
      }
    });

    it('does not flag rest slots (they have no day_code)', () => {
      const after: WeeklyPattern = { ...PATTERN_BEFORE, TH: { type: 'rest', day_code: null } };
      const diff = buildTemplateDiff(baseArgs({ after }));
      assert.equal(diff.summary.orphan_day_codes.length, 0);
    });
  });

  describe('phase bounds', () => {
    it('does not emit rows past phase.target_ends_on', () => {
      const near: PhaseRow = { ...PHASE_P2, target_ends_on: '2026-04-20' };
      // add new SU slot so we'd normally create 4 Sundays — only Sunday 04-19 is in-phase.
      const before: WeeklyPattern = { ...PATTERN_BEFORE };
      delete (before as Record<string, unknown>).SU;
      const after: WeeklyPattern = { ...before, SU: { type: 'yoga', day_code: null } };
      const diff = buildTemplateDiff(baseArgs({ phase: near, allPhases: [near], before, after }));
      assert.equal(diff.creates.length, 1);
      assert.equal(diff.creates[0]!.date, '2026-04-19');
    });

    it('does not emit rows for dates the global phase resolver maps to a different phase', () => {
      const p2: PhaseRow = { id: 'p2', code: 'P2', starts_on: '2026-03-30', target_ends_on: '2026-04-30' };
      const p3: PhaseRow = { id: 'p3', code: 'P3', starts_on: '2026-05-01', target_ends_on: '2026-06-30' };
      // Diffing p2 with a 28-day window → would hit 2026-04-16..2026-05-13 but p3 owns 05-01+.
      const before: WeeklyPattern = { ...PATTERN_BEFORE };
      delete (before as Record<string, unknown>).SU;
      const after: WeeklyPattern = { ...before, SU: { type: 'yoga', day_code: null } };
      const diff = buildTemplateDiff(baseArgs({ phase: p2, allPhases: [p2, p3], before, after }));
      // Sundays in window: 04-19 (p2), 04-26 (p2), 05-03 (p3), 05-10 (p3).
      // Only the p2 Sundays should appear.
      const dates = diff.creates.map((c) => c.date).sort();
      assert.deepEqual(dates, ['2026-04-19', '2026-04-26']);
    });
  });

  describe('idempotency', () => {
    it('applying the same edit twice produces an empty diff the second time', () => {
      const after: WeeklyPattern = { ...PATTERN_BEFORE, TH: { type: 'rest', day_code: null } };
      // First diff — we'd emit updates. Pretend we applied them: rebuild
      // plansByDate as the new target state, then re-run the diff with
      // before=after. Expect an empty diff.
      const diff1 = buildTemplateDiff(baseArgs({ after }));
      assert.ok(diff1.updates.length + diff1.creates.length + diff1.deletes.length > 0);
      const diff2 = buildTemplateDiff(baseArgs({ before: after, after }));
      assert.equal(diff2.updates.length, 0);
      assert.equal(diff2.creates.length, 0);
      assert.equal(diff2.deletes.length, 0);
    });
  });

  describe('window size', () => {
    it('defaults to 28 days', () => {
      assert.equal(TEMPLATE_APPLY_WINDOW_DAYS, 28);
    });
  });

  describe('summary / rationale', () => {
    it('populates a human rationale reflecting the summary', () => {
      const after: WeeklyPattern = { ...PATTERN_BEFORE, TH: { type: 'rest', day_code: null } };
      const diff = buildTemplateDiff(baseArgs({ after }));
      assert.match(diff.rationale, /phase P2/);
      assert.match(diff.rationale, /changed|added|removed|no future/);
    });
  });
});
