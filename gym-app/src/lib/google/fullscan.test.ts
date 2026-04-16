/**
 * Unit tests for the nightly full-scan (P1.4 / PR-W).
 *
 * Run via:
 *   npx tsx --test src/lib/google/fullscan.test.ts
 *
 * Tests the sync-rebuild and meeting-conflict detection logic.
 * Google Calendar API calls are not tested here (they need the real
 * googleapis mock); we test the pure functions and the DB-interaction
 * layer using the fluent Supabase mock pattern.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Dynamic import to avoid googleapis top-level init.
async function loadModule() {
  return await import('./fullscan');
}

// =====================================================================
// Fluent Supabase mock
// =====================================================================

type UpdateCall = { table: string; patch: Record<string, unknown>; filters: Record<string, unknown> };
type InsertCall = { table: string; rows: unknown[] };

type TableConfig = {
  selectResult?: { data: unknown; error: unknown };
  maybeSingleResult?: { data: unknown; error: unknown };
  insertResult?: { data: unknown; error: unknown };
  updateResult?: { data: unknown; error: unknown };
};

type MockState = {
  sb: any;
  updates: UpdateCall[];
  inserts: InsertCall[];
};

function makeSupaMock(tables: Record<string, TableConfig>): MockState {
  const state: MockState = { sb: null, updates: [], inserts: [] };

  const sb: any = {
    from(tableName: string) {
      const cfg = tables[tableName] ?? {};
      const filters: Record<string, unknown> = {};

      const builder: any = {
        select() { return builder; },
        eq(col: string, val: unknown) { filters[col] = val; return builder; },
        in(col: string, val: unknown) { filters[`${col}__in`] = val; return builder; },
        gte(col: string, val: unknown) { filters[`${col}__gte`] = val; return builder; },
        lte(col: string, val: unknown) { filters[`${col}__lte`] = val; return builder; },
        neq(col: string, val: unknown) { filters[`${col}__neq`] = val; return builder; },
        limit() { return builder; },
        order() { return builder; },
        delete() {
          return {
            eq(col: string, val: unknown) { filters[col] = val; return this; },
            then(res: any, rej: any) {
              return Promise.resolve({ count: 0, error: null }).then(res, rej);
            },
          };
        },
        maybeSingle() {
          return Promise.resolve(cfg.maybeSingleResult ?? { data: null, error: null });
        },
        insert(rows: unknown) {
          state.inserts.push({ table: tableName, rows: Array.isArray(rows) ? rows : [rows] });
          const ib: any = {
            select() { return ib; },
            single() { return ib; },
            then(res: any, rej: any) {
              return Promise.resolve(cfg.insertResult ?? { data: null, error: null }).then(res, rej);
            },
          };
          return ib;
        },
        update(patch: Record<string, unknown>) {
          const ub: any = {
            eq(col: string, val: unknown) { filters[col] = val; return ub; },
            then(res: any, rej: any) {
              state.updates.push({ table: tableName, patch, filters: { ...filters } });
              return Promise.resolve(cfg.updateResult ?? { data: null, error: null }).then(res, rej);
            },
          };
          return ub;
        },
        then(res: any, rej: any) {
          return Promise.resolve(cfg.selectResult ?? { data: [], error: null }).then(res, rej);
        },
      };
      return builder;
    },
  };

  state.sb = sb;
  return state;
}

// =====================================================================
// identifyStaleOrMissing (pure)
// =====================================================================

describe('identifyStaleOrMissing', () => {
  it('identifies plans with no link', async () => {
    const { identifyStaleOrMissing } = await loadModule();
    const { DEFAULT_PREFERENCES } = await import('./project');

    const plans = [
      { id: 'p1', date: '2026-04-16', type: 'gym', day_code: 'push', status: 'planned', prescription: {} },
      { id: 'p2', date: '2026-04-17', type: 'gym', day_code: 'pull', status: 'planned', prescription: {} },
    ];
    const linkByPlan = new Map(); // No links at all.

    const result = identifyStaleOrMissing(plans, linkByPlan, DEFAULT_PREFERENCES, 'UTC');
    assert.deepEqual(result, ['p1', 'p2']);
  });

  it('skips rest days and non-planned', async () => {
    const { identifyStaleOrMissing } = await loadModule();
    const { DEFAULT_PREFERENCES } = await import('./project');

    const plans = [
      { id: 'p1', date: '2026-04-16', type: 'rest', day_code: null, status: 'planned', prescription: {} },
      { id: 'p2', date: '2026-04-17', type: 'gym', day_code: 'push', status: 'missed', prescription: {} },
      { id: 'p3', date: '2026-04-18', type: 'gym', day_code: 'pull', status: 'planned', prescription: {} },
    ];
    const linkByPlan = new Map();

    const result = identifyStaleOrMissing(plans, linkByPlan, DEFAULT_PREFERENCES, 'UTC');
    assert.deepEqual(result, ['p3']);
  });

  it('skips plans with matching checksum and synced status', async () => {
    const { identifyStaleOrMissing } = await loadModule();
    const { DEFAULT_PREFERENCES, projectPlanToEvent, checksumEvent } = await import('./project');

    const plan = { id: 'p1', date: '2026-04-16', type: 'gym', day_code: 'push', status: 'planned', prescription: {} };
    const projected = projectPlanToEvent(plan, DEFAULT_PREFERENCES, 'UTC');
    const checksum = checksumEvent(projected);

    const linkByPlan = new Map([
      ['p1', { checksum, sync_status: 'synced' }],
    ]);

    const result = identifyStaleOrMissing([plan], linkByPlan, DEFAULT_PREFERENCES, 'UTC');
    assert.deepEqual(result, []);
  });

  it('flags plans with stale checksum', async () => {
    const { identifyStaleOrMissing } = await loadModule();
    const { DEFAULT_PREFERENCES } = await import('./project');

    const plan = { id: 'p1', date: '2026-04-16', type: 'gym', day_code: 'push', status: 'planned', prescription: {} };
    const linkByPlan = new Map([
      ['p1', { checksum: 'old-stale-checksum', sync_status: 'synced' }],
    ]);

    const result = identifyStaleOrMissing([plan], linkByPlan, DEFAULT_PREFERENCES, 'UTC');
    assert.deepEqual(result, ['p1']);
  });

  it('flags plans with error sync_status for retry', async () => {
    const { identifyStaleOrMissing } = await loadModule();
    const { DEFAULT_PREFERENCES, projectPlanToEvent, checksumEvent } = await import('./project');

    const plan = { id: 'p1', date: '2026-04-16', type: 'gym', day_code: 'push', status: 'planned', prescription: {} };
    const projected = projectPlanToEvent(plan, DEFAULT_PREFERENCES, 'UTC');
    const checksum = checksumEvent(projected);

    const linkByPlan = new Map([
      ['p1', { checksum, sync_status: 'error' }],
    ]);

    const result = identifyStaleOrMissing([plan], linkByPlan, DEFAULT_PREFERENCES, 'UTC');
    assert.deepEqual(result, ['p1']);
  });

  it('skips plans in conflict or pending status', async () => {
    const { identifyStaleOrMissing } = await loadModule();
    const { DEFAULT_PREFERENCES } = await import('./project');

    const plans = [
      { id: 'p1', date: '2026-04-16', type: 'gym', day_code: 'push', status: 'planned', prescription: {} },
      { id: 'p2', date: '2026-04-17', type: 'gym', day_code: 'pull', status: 'planned', prescription: {} },
    ];
    const linkByPlan = new Map([
      ['p1', { checksum: 'old', sync_status: 'conflict' }],
      ['p2', { checksum: 'old', sync_status: 'pending' }],
    ]);

    const result = identifyStaleOrMissing(plans, linkByPlan, DEFAULT_PREFERENCES, 'UTC');
    assert.deepEqual(result, []);
  });
});

// =====================================================================
// findOverlappingMeetings (pure)
// =====================================================================

describe('findOverlappingMeetings', () => {
  it('finds meetings that overlap the session window', async () => {
    const { findOverlappingMeetings } = await loadModule();

    const meetings = [
      {
        summary: 'Team standup',
        start: { dateTime: '2026-04-16T06:30:00+02:00' },
        end: { dateTime: '2026-04-16T07:30:00+02:00' },
      },
    ] as any[];

    const sessionStart = new Date('2026-04-16T07:00:00');
    const sessionEnd = new Date('2026-04-16T08:00:00');

    const result = findOverlappingMeetings(meetings, '2026-04-16', sessionStart, sessionEnd);
    assert.equal(result.length, 1);
    assert.equal(result[0].summary, 'Team standup');
  });

  it('ignores meetings on different dates', async () => {
    const { findOverlappingMeetings } = await loadModule();

    const meetings = [
      {
        summary: 'Wrong day',
        start: { dateTime: '2026-04-17T07:00:00' },
        end: { dateTime: '2026-04-17T08:00:00' },
      },
    ] as any[];

    const sessionStart = new Date('2026-04-16T07:00:00');
    const sessionEnd = new Date('2026-04-16T08:00:00');

    const result = findOverlappingMeetings(meetings, '2026-04-16', sessionStart, sessionEnd);
    assert.equal(result.length, 0);
  });

  it('ignores meetings that end before session starts', async () => {
    const { findOverlappingMeetings } = await loadModule();

    const meetings = [
      {
        summary: 'Early meeting',
        start: { dateTime: '2026-04-16T05:00:00' },
        end: { dateTime: '2026-04-16T06:00:00' },
      },
    ] as any[];

    const sessionStart = new Date('2026-04-16T07:00:00');
    const sessionEnd = new Date('2026-04-16T08:00:00');

    const result = findOverlappingMeetings(meetings, '2026-04-16', sessionStart, sessionEnd);
    assert.equal(result.length, 0);
  });

  it('ignores meetings that start after session ends', async () => {
    const { findOverlappingMeetings } = await loadModule();

    const meetings = [
      {
        summary: 'Late meeting',
        start: { dateTime: '2026-04-16T09:00:00' },
        end: { dateTime: '2026-04-16T10:00:00' },
      },
    ] as any[];

    const sessionStart = new Date('2026-04-16T07:00:00');
    const sessionEnd = new Date('2026-04-16T08:00:00');

    const result = findOverlappingMeetings(meetings, '2026-04-16', sessionStart, sessionEnd);
    assert.equal(result.length, 0);
  });

  it('ignores meetings with overlap under the minimum threshold', async () => {
    const { findOverlappingMeetings, MIN_OVERLAP_MINUTES } = await loadModule();

    // Meeting that barely touches the session window (10 min overlap < 15 min threshold).
    const meetings = [
      {
        summary: 'Brief overlap',
        start: { dateTime: '2026-04-16T06:50:00' },
        end: { dateTime: '2026-04-16T07:10:00' },
      },
    ] as any[];

    const sessionStart = new Date('2026-04-16T07:00:00');
    const sessionEnd = new Date('2026-04-16T08:00:00');

    const result = findOverlappingMeetings(meetings, '2026-04-16', sessionStart, sessionEnd);
    assert.equal(result.length, 0);
  });

  it('includes meetings with overlap at or above threshold', async () => {
    const { findOverlappingMeetings } = await loadModule();

    // 30 min overlap (well above 15 min threshold).
    const meetings = [
      {
        summary: 'Significant overlap',
        start: { dateTime: '2026-04-16T06:30:00' },
        end: { dateTime: '2026-04-16T07:30:00' },
      },
    ] as any[];

    const sessionStart = new Date('2026-04-16T07:00:00');
    const sessionEnd = new Date('2026-04-16T08:00:00');

    const result = findOverlappingMeetings(meetings, '2026-04-16', sessionStart, sessionEnd);
    assert.equal(result.length, 1);
  });

  it('finds multiple overlapping meetings', async () => {
    const { findOverlappingMeetings } = await loadModule();

    const meetings = [
      {
        summary: 'Meeting A',
        start: { dateTime: '2026-04-16T07:00:00' },
        end: { dateTime: '2026-04-16T07:30:00' },
      },
      {
        summary: 'Meeting B',
        start: { dateTime: '2026-04-16T07:30:00' },
        end: { dateTime: '2026-04-16T08:00:00' },
      },
    ] as any[];

    const sessionStart = new Date('2026-04-16T07:00:00');
    const sessionEnd = new Date('2026-04-16T08:00:00');

    const result = findOverlappingMeetings(meetings, '2026-04-16', sessionStart, sessionEnd);
    assert.equal(result.length, 2);
  });
});

// =====================================================================
// formatTime (pure)
// =====================================================================

describe('formatTime', () => {
  it('extracts HH:MM from ISO dateTime', async () => {
    const { formatTime } = await loadModule();
    assert.equal(formatTime('2026-04-16T07:30:00+02:00'), '07:30');
    assert.equal(formatTime('2026-04-16T18:00:00'), '18:00');
    assert.equal(formatTime('2026-04-16T09:15:00Z'), '09:15');
  });
});

// =====================================================================
// createMeetingConflictProposal (DB interaction)
// =====================================================================

describe('createMeetingConflictProposal', () => {
  it('creates a proposal when none exists', async () => {
    const { createMeetingConflictProposal } = await loadModule();
    const mock = makeSupaMock({
      ai_proposals: {
        maybeSingleResult: { data: null, error: null },
      },
    });

    const plan = { id: 'p1', date: '2026-04-16', type: 'gym', day_code: 'push', status: 'planned', prescription: {} };
    const overlapping = [
      { summary: 'Team standup', start: { dateTime: '2026-04-16T07:00:00' }, end: { dateTime: '2026-04-16T07:30:00' } },
    ] as any[];

    const result = await createMeetingConflictProposal(
      mock.sb, 'user-1', plan, overlapping,
      { startTime: '07:00:00', durationMinutes: 60 },
    );

    assert.equal(result, 'created');
    const proposalInserts = mock.inserts.filter(i => i.table === 'ai_proposals');
    assert.equal(proposalInserts.length, 1);
    const row = proposalInserts[0]!.rows[0] as Record<string, unknown>;
    assert.equal(row.kind, 'meeting_conflict');
    assert.equal(row.status, 'pending');
    assert.equal(row.user_id, 'user-1');
    assert.equal(row.source_activity_id, 'p1');
    assert.ok((row.rationale as string).includes('Team standup'));
  });

  it('skips when a pending proposal already exists', async () => {
    const { createMeetingConflictProposal } = await loadModule();
    const mock = makeSupaMock({
      ai_proposals: {
        maybeSingleResult: { data: { id: 'existing' }, error: null },
      },
    });

    const plan = { id: 'p1', date: '2026-04-16', type: 'gym', day_code: 'push', status: 'planned', prescription: {} };
    const overlapping = [
      { summary: 'Meeting', start: { dateTime: '2026-04-16T07:00:00' }, end: { dateTime: '2026-04-16T07:30:00' } },
    ] as any[];

    const result = await createMeetingConflictProposal(
      mock.sb, 'user-1', plan, overlapping,
      { startTime: '07:00:00', durationMinutes: 60 },
    );

    assert.equal(result, 'skipped');
    assert.equal(mock.inserts.filter(i => i.table === 'ai_proposals').length, 0);
  });

  it('includes all overlapping meetings in the rationale', async () => {
    const { createMeetingConflictProposal } = await loadModule();
    const mock = makeSupaMock({
      ai_proposals: {
        maybeSingleResult: { data: null, error: null },
      },
    });

    const plan = { id: 'p1', date: '2026-04-16', type: 'run', day_code: 'easy_run', status: 'planned', prescription: {} };
    const overlapping = [
      { summary: 'Meeting A', start: { dateTime: '2026-04-16T07:00:00' }, end: { dateTime: '2026-04-16T07:30:00' } },
      { summary: 'Meeting B', start: { dateTime: '2026-04-16T07:30:00' }, end: { dateTime: '2026-04-16T08:00:00' } },
    ] as any[];

    const result = await createMeetingConflictProposal(
      mock.sb, 'user-1', plan, overlapping,
      { startTime: '07:00:00', durationMinutes: 60 },
    );

    assert.equal(result, 'created');
    const row = mock.inserts[0]!.rows[0] as Record<string, unknown>;
    const rationale = row.rationale as string;
    assert.ok(rationale.includes('Meeting A'));
    assert.ok(rationale.includes('Meeting B'));
    assert.ok(rationale.includes('easy_run'));
  });
});

// =====================================================================
// nightlyFullScan (top-level)
// =====================================================================

describe('nightlyFullScan', () => {
  it('returns zeros when no active users exist', async () => {
    const { nightlyFullScan } = await loadModule();
    const mock = makeSupaMock({
      google_tokens: { selectResult: { data: [], error: null } },
    });

    const r = await nightlyFullScan(mock.sb);
    assert.equal(r.users_scanned, 0);
    assert.equal(r.errors, 0);
  });

  it('returns zeros on query error', async () => {
    const { nightlyFullScan } = await loadModule();
    const mock = makeSupaMock({
      google_tokens: { selectResult: { data: null, error: { message: 'db down' } } },
    });

    const r = await nightlyFullScan(mock.sb);
    assert.equal(r.users_scanned, 0);
  });

  it('filters out users without training_calendar_id', async () => {
    const { nightlyFullScan } = await loadModule();
    const mock = makeSupaMock({
      google_tokens: {
        selectResult: {
          data: [
            { user_id: 'u1', access_token: 'at', refresh_token: 'rt', expires_at: null, training_calendar_id: null },
            { user_id: 'u2', access_token: 'at', refresh_token: 'rt', expires_at: null, training_calendar_id: '' },
          ],
          error: null,
        },
      },
    });

    const r = await nightlyFullScan(mock.sb);
    assert.equal(r.users_scanned, 0);
  });
});

// =====================================================================
// rebuildSyncQueue (DB interaction)
// =====================================================================

describe('rebuildSyncQueue', () => {
  it('enqueues upserts for plans with no calendar_links', async () => {
    const { rebuildSyncQueue } = await loadModule();
    const mock = makeSupaMock({
      plans: {
        selectResult: {
          data: [
            { id: 'p1', date: '2026-04-16', type: 'gym', day_code: 'push', status: 'planned', prescription: {} },
          ],
          error: null,
        },
      },
      training_preferences: { maybeSingleResult: { data: null, error: null } },
      profiles: { maybeSingleResult: { data: { timezone: 'UTC' }, error: null } },
      calendar_links: { selectResult: { data: [], error: null } },
      // enqueuePlanSync gate check:
      google_tokens: {
        maybeSingleResult: {
          data: { status: 'active', training_calendar_id: 'cal-1' },
          error: null,
        },
      },
      // enqueuePlanSync dedup check:
      sync_jobs: { selectResult: { data: [], error: null } },
    });

    const r = await rebuildSyncQueue(mock.sb, 'user-1');
    assert.equal(r.upserts_enqueued, 1);
    assert.equal(r.deletes_enqueued, 0);
  });

  it('returns zeros when all plans are up to date', async () => {
    const { rebuildSyncQueue } = await loadModule();
    const { DEFAULT_PREFERENCES, projectPlanToEvent, checksumEvent } = await import('./project');

    const plan = { id: 'p1', date: '2026-04-16', type: 'gym', day_code: 'push', status: 'planned', prescription: {} };
    const projected = projectPlanToEvent(plan, DEFAULT_PREFERENCES, 'UTC');
    const checksum = checksumEvent(projected);

    const mock = makeSupaMock({
      plans: { selectResult: { data: [plan], error: null } },
      training_preferences: { maybeSingleResult: { data: null, error: null } },
      profiles: { maybeSingleResult: { data: { timezone: 'UTC' }, error: null } },
      calendar_links: {
        selectResult: {
          data: [{ id: 'link-1', plan_id: 'p1', checksum, sync_status: 'synced' }],
          error: null,
        },
      },
      google_tokens: {
        maybeSingleResult: { data: { status: 'active', training_calendar_id: 'cal-1' }, error: null },
      },
      sync_jobs: { selectResult: { data: [], error: null } },
    });

    const r = await rebuildSyncQueue(mock.sb, 'user-1');
    assert.equal(r.upserts_enqueued, 0);
    assert.equal(r.deletes_enqueued, 0);
  });
});
