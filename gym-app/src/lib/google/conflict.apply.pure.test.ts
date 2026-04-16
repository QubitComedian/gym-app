/**
 * Tests for conflict.apply.pure.ts (P1.5 / PR-Y).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveConflictAction,
  resolveMeetingConflictAction,
  computeMorningTime,
  computeEveningTime,
  findAlternateDay,
  timeToMinutes,
  minutesToTime,
  MORNING_DEFAULT,
  EVENING_DEFAULT,
  type OverlappingMeeting,
} from './conflict.apply.pure';

// =====================================================================
// resolveConflictAction
// =====================================================================

describe('resolveConflictAction', () => {
  it('force_push returns force_push', () => {
    const r = resolveConflictAction('force_push', '2026-04-20', null);
    assert.deepStrictEqual(r, { type: 'force_push' });
  });

  it('accept_remote with date change returns accept_remote_date', () => {
    const r = resolveConflictAction(
      'accept_remote',
      '2026-04-20',
      '2026-04-21T10:00:00+02:00',
    );
    assert.deepStrictEqual(r, { type: 'accept_remote_date', newDate: '2026-04-21' });
  });

  it('accept_remote with same date returns accept_remote_noop', () => {
    const r = resolveConflictAction(
      'accept_remote',
      '2026-04-20',
      '2026-04-20T18:00:00+02:00',
    );
    assert.deepStrictEqual(r, { type: 'accept_remote_noop' });
  });

  it('accept_remote with null remote returns accept_remote_noop', () => {
    const r = resolveConflictAction('accept_remote', '2026-04-20', null);
    assert.deepStrictEqual(r, { type: 'accept_remote_noop' });
  });

  it('cancel_plan returns cancel_plan', () => {
    const r = resolveConflictAction('cancel_plan', '2026-04-20', null);
    assert.deepStrictEqual(r, { type: 'cancel_plan' });
  });

  it('recreate returns recreate', () => {
    const r = resolveConflictAction('recreate', '2026-04-20', null);
    assert.deepStrictEqual(r, { type: 'recreate' });
  });

  it('dismiss returns dismiss', () => {
    const r = resolveConflictAction('dismiss', '2026-04-20', null);
    assert.deepStrictEqual(r, { type: 'dismiss' });
  });

  it('unknown action falls back to dismiss', () => {
    const r = resolveConflictAction('bogus' as any, '2026-04-20', null);
    assert.deepStrictEqual(r, { type: 'dismiss' });
  });
});

// =====================================================================
// computeMorningTime
// =====================================================================

describe('computeMorningTime', () => {
  const meeting = (start: string, end: string): OverlappingMeeting => ({
    summary: 'Meeting',
    start: `2026-04-20T${start}:00`,
    end: `2026-04-20T${end}:00`,
  });

  it('returns default when no meetings', () => {
    assert.equal(computeMorningTime([], 60), MORNING_DEFAULT);
  });

  it('places session before earliest meeting', () => {
    // Meeting at 09:00. Session = 60 min. End by 08:45 → start 07:45.
    const result = computeMorningTime([meeting('09:00', '10:00')], 60);
    assert.equal(result, '07:45:00');
  });

  it('uses earliest meeting when multiple', () => {
    // Meetings at 08:00 and 10:00. Session = 60 min. End by 07:45 → start 06:45.
    const result = computeMorningTime(
      [meeting('10:00', '11:00'), meeting('08:00', '09:00')],
      60,
    );
    assert.equal(result, '06:45:00');
  });

  it('falls back to default when session would be too early', () => {
    // Meeting at 06:00. Session = 90 min. End by 05:45 → start 04:15 < 05:00.
    const result = computeMorningTime([meeting('06:00', '07:00')], 90);
    assert.equal(result, MORNING_DEFAULT);
  });

  it('handles 30-min session', () => {
    // Meeting at 08:00. 30 min session. End by 07:45 → start 07:15.
    const result = computeMorningTime([meeting('08:00', '09:00')], 30);
    assert.equal(result, '07:15:00');
  });
});

// =====================================================================
// computeEveningTime
// =====================================================================

describe('computeEveningTime', () => {
  const meeting = (start: string, end: string): OverlappingMeeting => ({
    summary: 'Meeting',
    start: `2026-04-20T${start}:00`,
    end: `2026-04-20T${end}:00`,
  });

  it('returns default when no meetings', () => {
    assert.equal(computeEveningTime([], 60), EVENING_DEFAULT);
  });

  it('places session after latest meeting', () => {
    // Meeting ends 18:30. Start at 18:45.
    const result = computeEveningTime([meeting('17:30', '18:30')], 60);
    assert.equal(result, '18:45:00');
  });

  it('uses latest meeting end when multiple', () => {
    // Meetings end at 17:30 and 19:00. Start at 19:15.
    const result = computeEveningTime(
      [meeting('17:00', '17:30'), meeting('18:00', '19:00')],
      60,
    );
    assert.equal(result, '19:15:00');
  });

  it('falls back to default when session would be too late', () => {
    // Meeting ends 22:30. Session 60 min. Start 22:45 → end 23:45 > 23:00.
    const result = computeEveningTime([meeting('21:00', '22:30')], 60);
    assert.equal(result, EVENING_DEFAULT);
  });

  it('handles short session that fits late', () => {
    // Meeting ends 22:00. 30 min session. Start 22:15 → end 22:45 < 23:00.
    const result = computeEveningTime([meeting('21:00', '22:00')], 30);
    assert.equal(result, '22:15:00');
  });
});

// =====================================================================
// findAlternateDay
// =====================================================================

describe('findAlternateDay', () => {
  const today = '2026-04-16';

  it('returns +1 day when available', () => {
    const result = findAlternateDay('2026-04-20', [], today);
    assert.equal(result, '2026-04-21');
  });

  it('skips occupied days', () => {
    // +1 occupied, -1 available
    const result = findAlternateDay('2026-04-20', ['2026-04-21'], today);
    assert.equal(result, '2026-04-19');
  });

  it('skips past days', () => {
    // Plan is today. -1 = yesterday (past). +1 = tomorrow.
    const result = findAlternateDay('2026-04-16', [], '2026-04-16');
    assert.equal(result, '2026-04-17');
  });

  it('skips both occupied and past', () => {
    // Plan is today. +1 occupied, +2 available.
    const result = findAlternateDay('2026-04-16', ['2026-04-17'], '2026-04-16');
    assert.equal(result, '2026-04-18');
  });

  it('returns null when all candidates exhausted', () => {
    // All ±3 days occupied or past.
    const result = findAlternateDay('2026-04-16', [
      '2026-04-17', '2026-04-18', '2026-04-19',
    ], '2026-04-16');
    assert.equal(result, null);
  });

  it('prefers forward over backward', () => {
    // Both +1 and -1 available. Should pick +1.
    const result = findAlternateDay('2026-04-20', [], today);
    assert.equal(result, '2026-04-21');
  });

  it('handles fully occupied ±1, finds ±2', () => {
    const result = findAlternateDay(
      '2026-04-20',
      ['2026-04-21', '2026-04-19'],
      today,
    );
    assert.equal(result, '2026-04-22');
  });
});

// =====================================================================
// resolveMeetingConflictAction
// =====================================================================

describe('resolveMeetingConflictAction', () => {
  const today = '2026-04-16';
  const meetings: OverlappingMeeting[] = [
    { summary: 'Standup', start: '2026-04-20T09:00:00', end: '2026-04-20T09:30:00' },
  ];

  it('shift_morning returns reschedule_time', () => {
    const r = resolveMeetingConflictAction(
      'shift_morning', '2026-04-20', 60, meetings, [], today,
    );
    assert.equal(r.type, 'reschedule_time');
    assert.equal((r as any).newTimeOverride, '07:45:00');
  });

  it('shift_evening returns reschedule_time', () => {
    const r = resolveMeetingConflictAction(
      'shift_evening', '2026-04-20', 60, meetings, [], today,
    );
    assert.equal(r.type, 'reschedule_time');
    assert.equal((r as any).newTimeOverride, '09:45:00');
  });

  it('move_day returns reschedule_day', () => {
    const r = resolveMeetingConflictAction(
      'move_day', '2026-04-20', 60, meetings, [], today,
    );
    assert.equal(r.type, 'reschedule_day');
    assert.equal((r as any).newDate, '2026-04-21');
  });

  it('move_day falls back to dismiss when no day available', () => {
    const r = resolveMeetingConflictAction(
      'move_day', '2026-04-16', 60, meetings,
      ['2026-04-17', '2026-04-18', '2026-04-19'],
      '2026-04-16',
    );
    assert.equal(r.type, 'dismiss');
  });

  it('skip returns skip', () => {
    const r = resolveMeetingConflictAction(
      'skip', '2026-04-20', 60, meetings, [], today,
    );
    assert.deepStrictEqual(r, { type: 'skip' });
  });

  it('dismiss returns dismiss', () => {
    const r = resolveMeetingConflictAction(
      'dismiss', '2026-04-20', 60, meetings, [], today,
    );
    assert.deepStrictEqual(r, { type: 'dismiss' });
  });
});

// =====================================================================
// timeToMinutes / minutesToTime
// =====================================================================

describe('timeToMinutes', () => {
  it('parses HH:MM', () => {
    assert.equal(timeToMinutes('07:30'), 450);
    assert.equal(timeToMinutes('00:00'), 0);
    assert.equal(timeToMinutes('23:59'), 1439);
  });
});

describe('minutesToTime', () => {
  it('formats to HH:MM:SS', () => {
    assert.equal(minutesToTime(450), '07:30:00');
    assert.equal(minutesToTime(0), '00:00:00');
    assert.equal(minutesToTime(1439), '23:59:00');
  });
});
