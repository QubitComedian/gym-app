import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildWeekScorecard, weekBounds } from './weekScorecard.pure';

describe('weekBounds', () => {
  it('returns Mon→Sun range for a Monday', () => {
    assert.deepEqual(weekBounds('2026-04-13'), { week_start: '2026-04-13', week_end: '2026-04-19' });
  });

  it('returns Mon→Sun range for a mid-week day (Wed)', () => {
    assert.deepEqual(weekBounds('2026-04-15'), { week_start: '2026-04-13', week_end: '2026-04-19' });
  });

  it('returns Mon→Sun range for a Sunday (Sunday belongs to the PREVIOUS Mon)', () => {
    assert.deepEqual(weekBounds('2026-04-19'), { week_start: '2026-04-13', week_end: '2026-04-19' });
  });

  it('handles month boundary', () => {
    // 2026-05-03 is a Sunday → week should be Apr 27 → May 3
    assert.deepEqual(weekBounds('2026-05-03'), { week_start: '2026-04-27', week_end: '2026-05-03' });
  });

  it('handles year boundary', () => {
    // 2026-01-01 is a Thursday → week Mon 2025-12-29 → Sun 2026-01-04
    assert.deepEqual(weekBounds('2026-01-01'), { week_start: '2025-12-29', week_end: '2026-01-04' });
  });
});

describe('buildWeekScorecard', () => {
  const today = '2026-04-15'; // Wednesday
  // Week: Mon 04-13 → Sun 04-19

  it('counts done and skipped activities inside the week', () => {
    const s = buildWeekScorecard({
      today,
      activities: [
        { date: '2026-04-13', type: 'gym', status: 'done' },
        { date: '2026-04-14', type: 'run', status: 'done' },
        { date: '2026-04-14', type: 'gym', status: 'skipped' },
        { date: '2026-04-12', type: 'gym', status: 'done' },   // OUT: prior week
        { date: '2026-04-20', type: 'gym', status: 'done' },   // OUT: next week
      ],
      plans: [],
    });
    assert.deepEqual(s.done_by_type, { gym: 1, run: 1 });
    assert.deepEqual(s.skipped_by_type, { gym: 1 });
    assert.equal(s.total_done, 2);
    assert.equal(s.total_skipped, 1);
  });

  it('counts ONLY remaining planned sessions (today onward, within the week)', () => {
    const s = buildWeekScorecard({
      today,
      activities: [],
      plans: [
        { date: '2026-04-13', type: 'gym', status: 'planned' },  // OUT: before today
        { date: '2026-04-15', type: 'gym', status: 'planned' },  // IN:  today
        { date: '2026-04-16', type: 'run', status: 'planned' },  // IN:  thu
        { date: '2026-04-19', type: 'gym', status: 'planned' },  // IN:  sun
        { date: '2026-04-20', type: 'gym', status: 'planned' },  // OUT: next week
      ],
    });
    assert.deepEqual(s.planned_by_type, { gym: 2, run: 1 });
    assert.equal(s.total_planned, 3);
  });

  it('avoids double-counting: done/skipped plans are not re-added via plans', () => {
    const s = buildWeekScorecard({
      today,
      activities: [{ date: '2026-04-15', type: 'gym', status: 'done' }],
      plans: [
        { date: '2026-04-15', type: 'gym', status: 'done' },    // ignore — activities row wins
        { date: '2026-04-15', type: 'gym', status: 'skipped' }, // ignore — activities row wins
        { date: '2026-04-16', type: 'gym', status: 'planned' }, // counted
      ],
    });
    assert.deepEqual(s.done_by_type, { gym: 1 });
    assert.deepEqual(s.planned_by_type, { gym: 1 });
  });

  it('handles an empty week gracefully', () => {
    const s = buildWeekScorecard({ today, activities: [], plans: [] });
    assert.deepEqual(s.planned_by_type, {});
    assert.deepEqual(s.done_by_type, {});
    assert.deepEqual(s.skipped_by_type, {});
    assert.equal(s.total_planned, 0);
    assert.equal(s.total_done, 0);
    assert.equal(s.total_skipped, 0);
  });

  it('week bounds land on Mon/Sun of the containing week', () => {
    const s = buildWeekScorecard({ today: '2026-04-19', activities: [], plans: [] });
    assert.equal(s.week_start, '2026-04-13');
    assert.equal(s.week_end, '2026-04-19');
  });
});
