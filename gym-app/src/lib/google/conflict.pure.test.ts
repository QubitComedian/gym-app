/**
 * Unit tests for the pure conflict classification (P1.4 / PR-U).
 *
 * Run via:
 *   npx tsx --test src/lib/google/conflict.pure.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyConflict,
  isTimeMoved,
  isSummaryChanged,
  normalizeDT,
  normalizeSummary,
  type RemoteEvent,
} from './conflict.pure';
import type { GoogleEventBody } from './project';

// =====================================================================
// normalizeDT
// =====================================================================

describe('normalizeDT', () => {
  it('passes through bare dateTime unchanged', () => {
    assert.equal(normalizeDT('2026-04-16T07:00:00'), '2026-04-16T07:00:00');
  });

  it('strips +HH:MM offset', () => {
    assert.equal(normalizeDT('2026-04-16T07:00:00+02:00'), '2026-04-16T07:00:00');
  });

  it('strips -HH:MM offset', () => {
    assert.equal(normalizeDT('2026-04-16T07:00:00-05:00'), '2026-04-16T07:00:00');
  });

  it('strips Z suffix', () => {
    assert.equal(normalizeDT('2026-04-16T07:00:00Z'), '2026-04-16T07:00:00');
  });

  it('strips milliseconds + Z', () => {
    assert.equal(normalizeDT('2026-04-16T07:00:00.000Z'), '2026-04-16T07:00:00');
  });

  it('handles date-only strings', () => {
    assert.equal(normalizeDT('2026-04-16'), '2026-04-16');
  });

  it('returns empty string for empty input', () => {
    assert.equal(normalizeDT(''), '');
  });
});

// =====================================================================
// normalizeSummary
// =====================================================================

describe('normalizeSummary', () => {
  it('strips emoji and normalizes whitespace', () => {
    assert.equal(normalizeSummary('🏋️ Push'), 'push');
  });

  it('collapses multiple spaces', () => {
    assert.equal(normalizeSummary('  Push   Day  '), 'push day');
  });

  it('lowercases', () => {
    assert.equal(normalizeSummary('UPPER FULL'), 'upper full');
  });

  it('treats emoji-only string as empty after strip', () => {
    assert.equal(normalizeSummary('🏋️'), '');
  });

  it('handles no-emoji string cleanly', () => {
    assert.equal(normalizeSummary('Push Day'), 'push day');
  });
});

// =====================================================================
// isTimeMoved
// =====================================================================

describe('isTimeMoved', () => {
  const projected: GoogleEventBody = {
    summary: '🏋️ Push',
    description: '',
    start: { dateTime: '2026-04-16T07:00:00', timeZone: 'Europe/Paris' },
    end: { dateTime: '2026-04-16T08:00:00', timeZone: 'Europe/Paris' },
  };

  it('returns false when times match exactly', () => {
    const remote: Extract<RemoteEvent, { exists: true }> = {
      exists: true,
      summary: '🏋️ Push',
      description: '',
      start: { dateTime: '2026-04-16T07:00:00', timeZone: 'Europe/Paris' },
      end: { dateTime: '2026-04-16T08:00:00', timeZone: 'Europe/Paris' },
      etag: '"abc"',
    };
    assert.equal(isTimeMoved(projected, remote), false);
  });

  it('returns false when times match modulo offset', () => {
    const remote: Extract<RemoteEvent, { exists: true }> = {
      exists: true,
      summary: '🏋️ Push',
      description: '',
      start: { dateTime: '2026-04-16T07:00:00+02:00' },
      end: { dateTime: '2026-04-16T08:00:00+02:00' },
      etag: '"abc"',
    };
    assert.equal(isTimeMoved(projected, remote), false);
  });

  it('returns true when start time differs', () => {
    const remote: Extract<RemoteEvent, { exists: true }> = {
      exists: true,
      summary: '🏋️ Push',
      description: '',
      start: { dateTime: '2026-04-16T09:00:00+02:00' },
      end: { dateTime: '2026-04-16T10:00:00+02:00' },
      etag: '"abc"',
    };
    assert.equal(isTimeMoved(projected, remote), true);
  });

  it('returns true when date differs (event moved to different day)', () => {
    const remote: Extract<RemoteEvent, { exists: true }> = {
      exists: true,
      summary: '🏋️ Push',
      description: '',
      start: { dateTime: '2026-04-17T07:00:00' },
      end: { dateTime: '2026-04-17T08:00:00' },
      etag: '"abc"',
    };
    assert.equal(isTimeMoved(projected, remote), true);
  });

  it('returns true when end time only differs', () => {
    const remote: Extract<RemoteEvent, { exists: true }> = {
      exists: true,
      summary: '🏋️ Push',
      description: '',
      start: { dateTime: '2026-04-16T07:00:00' },
      end: { dateTime: '2026-04-16T09:00:00' },
      etag: '"abc"',
    };
    assert.equal(isTimeMoved(projected, remote), true);
  });
});

// =====================================================================
// isSummaryChanged
// =====================================================================

describe('isSummaryChanged', () => {
  it('returns false when summaries match', () => {
    assert.equal(isSummaryChanged('🏋️ Push', '🏋️ Push'), false);
  });

  it('returns false when only emoji differs', () => {
    assert.equal(isSummaryChanged('🏋️ Push', '💪 Push'), false);
  });

  it('returns false when only whitespace differs', () => {
    assert.equal(isSummaryChanged('🏋️  Push', '🏋️ Push'), false);
  });

  it('returns true when text content differs', () => {
    assert.equal(isSummaryChanged('🏋️ Push', '🏋️ Pull'), true);
  });

  it('returns true when user renamed event completely', () => {
    assert.equal(isSummaryChanged('🏋️ Push', 'Morning Workout'), true);
  });
});

// =====================================================================
// classifyConflict (integration)
// =====================================================================

describe('classifyConflict', () => {
  const projected: GoogleEventBody = {
    summary: '🏋️ Push',
    description: 'bench press — 4 × 8-10',
    start: { dateTime: '2026-04-16T07:00:00', timeZone: 'Europe/Paris' },
    end: { dateTime: '2026-04-16T08:00:00', timeZone: 'Europe/Paris' },
  };

  it('returns deleted_remotely when event does not exist', () => {
    const r = classifyConflict(projected, { exists: false });
    assert.equal(r.kind, 'deleted_remotely');
    assert.ok(r.options!.length >= 2);
    assert.ok(r.options!.some(o => o.action === 'recreate'));
    assert.ok(r.options!.some(o => o.action === 'cancel_plan'));
  });

  it('returns trivial when content is effectively the same', () => {
    const remote: RemoteEvent = {
      exists: true,
      summary: '🏋️ Push',
      description: 'different description is fine',
      start: { dateTime: '2026-04-16T07:00:00+02:00' },
      end: { dateTime: '2026-04-16T08:00:00+02:00' },
      etag: '"new-etag"',
    };
    const r = classifyConflict(projected, remote);
    assert.equal(r.kind, 'trivial');
    assert.equal(r.options, undefined);
  });

  it('returns time_moved when start time changed', () => {
    const remote: RemoteEvent = {
      exists: true,
      summary: '🏋️ Push',
      description: '',
      start: { dateTime: '2026-04-16T18:00:00' },
      end: { dateTime: '2026-04-16T19:00:00' },
      etag: '"new-etag"',
    };
    const r = classifyConflict(projected, remote);
    assert.equal(r.kind, 'time_moved');
    assert.ok(r.options!.some(o => o.action === 'force_push'));
    assert.ok(r.options!.some(o => o.action === 'accept_remote'));
  });

  it('returns content_edited when summary text changed', () => {
    const remote: RemoteEvent = {
      exists: true,
      summary: 'Morning Weights',
      description: '',
      start: { dateTime: '2026-04-16T07:00:00' },
      end: { dateTime: '2026-04-16T08:00:00' },
      etag: '"new-etag"',
    };
    const r = classifyConflict(projected, remote);
    assert.equal(r.kind, 'content_edited');
    assert.ok(r.reason.includes('Morning Weights'));
  });

  it('prioritizes time_moved over content_edited when both changed', () => {
    const remote: RemoteEvent = {
      exists: true,
      summary: 'Evening Workout',
      description: '',
      start: { dateTime: '2026-04-16T18:00:00' },
      end: { dateTime: '2026-04-16T19:00:00' },
      etag: '"new-etag"',
    };
    const r = classifyConflict(projected, remote);
    assert.equal(r.kind, 'time_moved');
  });

  it('treats description-only changes as trivial', () => {
    const remote: RemoteEvent = {
      exists: true,
      summary: '🏋️ Push',
      description: 'user added a note here',
      start: { dateTime: '2026-04-16T07:00:00' },
      end: { dateTime: '2026-04-16T08:00:00' },
      etag: '"new-etag"',
    };
    const r = classifyConflict(projected, remote);
    assert.equal(r.kind, 'trivial');
  });
});
