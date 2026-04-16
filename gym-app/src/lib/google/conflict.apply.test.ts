/**
 * Unit tests for conflict.apply.ts (P1.5 / PR-Y).
 *
 * Tests the I/O apply logic for both `kind='conflict'` and
 * `kind='meeting_conflict'` proposals. Uses the fluent Supabase mock
 * from the existing test suite.
 *
 * Run via:
 *   npx tsx --test src/lib/google/conflict.apply.test.ts
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Dynamic import to avoid googleapis top-level init (enqueuePlanSync
// references are resolved at module level in some paths).
async function loadModule() {
  return await import('./conflict.apply');
}

// =====================================================================
// Fluent Supabase mock
// =====================================================================

type UpdateCall = { table: string; patch: Record<string, unknown>; filters: Record<string, unknown> };
type InsertCall = { table: string; rows: unknown[] };

type MockState = {
  sb: any;
  updates: UpdateCall[];
  inserts: InsertCall[];
  deletes: Array<{ table: string; filters: Record<string, unknown> }>;
};

/**
 * Build a mock Supabase client. `tables` provides per-table result
 * overrides. Results can be functions that receive the query filters
 * for context-dependent returns.
 */
function makeSupaMock(tables: Record<string, {
  selectResult?: any;
  maybeSingleResult?: any | ((filters: Record<string, unknown>) => any);
  insertResult?: any;
  updateResult?: any;
}>): MockState {
  const state: MockState = { sb: null, updates: [], inserts: [], deletes: [] };

  const sb: any = {
    from(tableName: string) {
      const cfg = tables[tableName] ?? {};
      const filters: Record<string, unknown> = {};

      const builder: any = {
        select() { return builder; },
        eq(col: string, val: unknown) { filters[col] = val; return builder; },
        neq(col: string, val: unknown) { filters[`${col}__neq`] = val; return builder; },
        in(col: string, val: unknown) { filters[`${col}__in`] = val; return builder; },
        gte(col: string, val: unknown) { filters[`${col}__gte`] = val; return builder; },
        lte(col: string, val: unknown) { filters[`${col}__lte`] = val; return builder; },
        limit() { return builder; },
        order() { return builder; },
        maybeSingle() {
          const ms = cfg.maybeSingleResult;
          if (typeof ms === 'function') {
            return Promise.resolve(ms(filters));
          }
          return Promise.resolve(ms ?? { data: null, error: null });
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
        delete() {
          const db: any = {
            eq(col: string, val: unknown) { filters[col] = val; return db; },
            then(res: any, rej: any) {
              state.deletes.push({ table: tableName, filters: { ...filters } });
              return Promise.resolve({ data: null, error: null }).then(res, rej);
            },
          };
          return db;
        },
        upsert(rows: unknown) {
          state.inserts.push({ table: tableName, rows: Array.isArray(rows) ? rows : [rows] });
          return Promise.resolve(cfg.insertResult ?? { data: null, error: null });
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
// Fixtures
// =====================================================================

const PLAN_ID = 'plan-111';
const LINK_ID = 'link-222';
const USER_ID = 'user-aaa';

const baseConflictDiff = {
  conflict_kind: 'time_moved',
  plan_id: PLAN_ID,
  plan_date: '2026-04-20',
  plan_type: 'gym',
  plan_day_code: 'push',
  calendar_link_id: LINK_ID,
  google_event_id: 'gev-1',
  google_calendar_id: 'cal-1',
  projected: {
    summary: '🏋️ Push',
    start: { dateTime: '2026-04-20T07:00:00', timeZone: 'Europe/Paris' },
    end: { dateTime: '2026-04-20T08:00:00', timeZone: 'Europe/Paris' },
  },
  remote: {
    summary: '🏋️ Push',
    start: { dateTime: '2026-04-20T18:00:00+02:00' },
    end: { dateTime: '2026-04-20T19:00:00+02:00' },
  },
  options: [
    { id: 'keep_app', label: 'Keep app schedule', action: 'force_push' as const },
    { id: 'accept_google', label: 'Accept Google time', action: 'accept_remote' as const },
    { id: 'dismiss', label: 'Dismiss', action: 'dismiss' as const },
  ],
};

const baseMeetingDiff = {
  plan_id: PLAN_ID,
  plan_date: '2026-04-20',
  plan_type: 'gym',
  plan_day_code: 'push',
  session_start: '07:00:00',
  session_duration: 60,
  overlapping_meetings: [
    { summary: 'Standup', start: '2026-04-20T07:30:00', end: '2026-04-20T08:00:00' },
  ],
  options: [
    { id: 'shift_morning' as const, label: 'Move to morning', action: 'reschedule' },
    { id: 'shift_evening' as const, label: 'Move to evening', action: 'reschedule' },
    { id: 'move_day' as const, label: 'Move to adjacent day', action: 'reschedule' },
    { id: 'skip' as const, label: 'Skip this session', action: 'skip' },
    { id: 'dismiss' as const, label: 'Keep as planned', action: 'dismiss' },
  ],
};

function planRow(overrides: Record<string, unknown> = {}) {
  return { id: PLAN_ID, date: '2026-04-20', status: 'planned', type: 'gym', day_code: 'push', prescription: {}, version: 1, ...overrides };
}

// =====================================================================
// kind='conflict' tests
// =====================================================================

describe('applyConflictOption', () => {
  it('force_push clears conflict state and enqueues upsert', async () => {
    const { applyConflictOption } = await loadModule();
    const mock = makeSupaMock({
      plans: { maybeSingleResult: { data: planRow(), error: null } },
      // enqueuePlanSync needs google_tokens + calendar_links + sync_jobs
      google_tokens: { maybeSingleResult: { data: { status: 'active', training_calendar_id: 'cal-1' }, error: null } },
      calendar_links: { selectResult: { data: [], error: null } },
      sync_jobs: { insertResult: { data: null, error: null } },
    });

    const result = await applyConflictOption(mock.sb, USER_ID, baseConflictDiff, 'keep_app');
    assert.equal(result.ok, true);
    assert.equal((result as any).resolution, 'force_push');

    // Should update calendar_links to clear conflict.
    const linkUpdate = mock.updates.find((u) => u.table === 'calendar_links');
    assert.ok(linkUpdate, 'calendar_links should be updated');
    assert.equal(linkUpdate!.patch.sync_status, 'pending');
    assert.equal(linkUpdate!.patch.remote_snapshot, null);
  });

  it('accept_remote with same date marks link synced (noop)', async () => {
    const { applyConflictOption } = await loadModule();
    const mock = makeSupaMock({
      plans: { maybeSingleResult: { data: planRow(), error: null } },
    });

    const result = await applyConflictOption(mock.sb, USER_ID, baseConflictDiff, 'accept_google');
    assert.equal(result.ok, true);
    assert.equal((result as any).resolution, 'accept_remote_noop');

    // calendar_links should be set to 'synced'.
    const linkUpdate = mock.updates.find((u) => u.table === 'calendar_links');
    assert.ok(linkUpdate);
    assert.equal(linkUpdate!.patch.sync_status, 'synced');
  });

  it('accept_remote with date change updates plan date', async () => {
    const { applyConflictOption } = await loadModule();
    const diffWithDateChange = {
      ...baseConflictDiff,
      remote: {
        summary: '🏋️ Push',
        start: { dateTime: '2026-04-21T18:00:00+02:00' },  // Different date!
        end: { dateTime: '2026-04-21T19:00:00+02:00' },
      },
    };
    const mock = makeSupaMock({
      plans: { maybeSingleResult: { data: planRow(), error: null } },
      google_tokens: { maybeSingleResult: { data: { status: 'active', training_calendar_id: 'cal-1' }, error: null } },
      calendar_links: { selectResult: { data: [], error: null } },
      sync_jobs: { insertResult: { data: null, error: null } },
    });

    const result = await applyConflictOption(mock.sb, USER_ID, diffWithDateChange, 'accept_google');
    assert.equal(result.ok, true);
    assert.equal((result as any).resolution, 'accept_remote_date');

    // Plan date should be updated.
    const planUpdate = mock.updates.find((u) => u.table === 'plans');
    assert.ok(planUpdate);
    assert.equal(planUpdate!.patch.date, '2026-04-21');
  });

  it('cancel_plan skips plan and enqueues delete', async () => {
    const { applyConflictOption } = await loadModule();
    const diffWithDelete = {
      ...baseConflictDiff,
      options: [
        { id: 'cancel', label: 'Cancel this session', action: 'cancel_plan' as const },
      ],
    };
    const mock = makeSupaMock({
      plans: { maybeSingleResult: { data: planRow(), error: null } },
      google_tokens: { maybeSingleResult: { data: { status: 'active', training_calendar_id: 'cal-1' }, error: null } },
      calendar_links: {
        selectResult: { data: [{ id: LINK_ID, plan_id: PLAN_ID, google_event_id: 'gev-1', google_calendar_id: 'cal-1', google_etag: 'etag-1' }], error: null },
      },
      sync_jobs: { insertResult: { data: null, error: null } },
    });

    const result = await applyConflictOption(mock.sb, USER_ID, diffWithDelete, 'cancel');
    assert.equal(result.ok, true);
    assert.equal((result as any).resolution, 'cancel_plan');

    // Plan should be updated to 'skipped'.
    const planUpdate = mock.updates.find((u) => u.table === 'plans' && u.patch.status === 'skipped');
    assert.ok(planUpdate, 'plan should be marked skipped');
  });

  it('returns ok when plan already gone', async () => {
    const { applyConflictOption } = await loadModule();
    const mock = makeSupaMock({
      plans: { maybeSingleResult: { data: null, error: null } },
    });

    const result = await applyConflictOption(mock.sb, USER_ID, baseConflictDiff, 'keep_app');
    // Should still succeed — plan is gone, conflict is moot.
    assert.equal(result.ok, true);
  });

  it('rejects unknown option_id', async () => {
    const { applyConflictOption } = await loadModule();
    const mock = makeSupaMock({});
    const result = await applyConflictOption(mock.sb, USER_ID, baseConflictDiff, 'nonexistent');
    assert.equal(result.ok, false);
    assert.ok((result as any).reason.includes('unknown option_id'));
  });
});

// =====================================================================
// kind='meeting_conflict' tests
// =====================================================================

describe('applyMeetingConflictOption', () => {
  it('shift_morning sets time_override on plan', async () => {
    const { applyMeetingConflictOption } = await loadModule();
    const mock = makeSupaMock({
      plans: {
        maybeSingleResult: (filters: any) => {
          if (filters.status === 'planned') return { data: [], error: null };
          return { data: planRow(), error: null };
        },
        selectResult: { data: [{ date: '2026-04-20' }], error: null },
      },
      google_tokens: { maybeSingleResult: { data: { status: 'active', training_calendar_id: 'cal-1' }, error: null } },
      calendar_links: { selectResult: { data: [], error: null } },
      sync_jobs: { insertResult: { data: null, error: null } },
    });

    const result = await applyMeetingConflictOption(mock.sb, USER_ID, baseMeetingDiff, 'shift_morning');
    assert.equal(result.ok, true);
    assert.ok((result as any).resolution.startsWith('reschedule_time:'));

    // Plan should have time_override set.
    const planUpdate = mock.updates.find((u) => u.table === 'plans' && u.patch.time_override);
    assert.ok(planUpdate, 'plan should have time_override');
  });

  it('shift_evening sets time_override on plan', async () => {
    const { applyMeetingConflictOption } = await loadModule();
    const mock = makeSupaMock({
      plans: {
        maybeSingleResult: (filters: any) => {
          if (filters.status === 'planned') return { data: [], error: null };
          return { data: planRow(), error: null };
        },
        selectResult: { data: [{ date: '2026-04-20' }], error: null },
      },
      google_tokens: { maybeSingleResult: { data: { status: 'active', training_calendar_id: 'cal-1' }, error: null } },
      calendar_links: { selectResult: { data: [], error: null } },
      sync_jobs: { insertResult: { data: null, error: null } },
    });

    const result = await applyMeetingConflictOption(mock.sb, USER_ID, baseMeetingDiff, 'shift_evening');
    assert.equal(result.ok, true);
    assert.ok((result as any).resolution.startsWith('reschedule_time:'));
  });

  it('move_day updates plan date', async () => {
    const { applyMeetingConflictOption } = await loadModule();
    const mock = makeSupaMock({
      plans: {
        maybeSingleResult: (filters: any) => {
          if (filters.status === 'planned') return { data: [], error: null };
          return { data: planRow(), error: null };
        },
        selectResult: { data: [{ date: '2026-04-20' }], error: null },
      },
      google_tokens: { maybeSingleResult: { data: { status: 'active', training_calendar_id: 'cal-1' }, error: null } },
      calendar_links: { selectResult: { data: [], error: null } },
      sync_jobs: { insertResult: { data: null, error: null } },
    });

    const result = await applyMeetingConflictOption(mock.sb, USER_ID, baseMeetingDiff, 'move_day');
    assert.equal(result.ok, true);
    assert.ok((result as any).resolution.startsWith('reschedule_day:'));

    const planUpdate = mock.updates.find((u) => u.table === 'plans' && u.patch.date);
    assert.ok(planUpdate, 'plan date should be updated');
    assert.equal(planUpdate!.patch.time_override, null); // cleared
  });

  it('skip marks plan skipped and enqueues delete', async () => {
    const { applyMeetingConflictOption } = await loadModule();
    const mock = makeSupaMock({
      plans: {
        maybeSingleResult: (filters: any) => {
          if (filters.status === 'planned') return { data: [], error: null };
          return { data: planRow(), error: null };
        },
        selectResult: { data: [{ date: '2026-04-20' }], error: null },
      },
      google_tokens: { maybeSingleResult: { data: { status: 'active', training_calendar_id: 'cal-1' }, error: null } },
      calendar_links: {
        selectResult: { data: [{ id: LINK_ID, plan_id: PLAN_ID, google_event_id: 'gev-1', google_calendar_id: 'cal-1', google_etag: 'etag-1' }], error: null },
      },
      sync_jobs: { insertResult: { data: null, error: null } },
    });

    const result = await applyMeetingConflictOption(mock.sb, USER_ID, baseMeetingDiff, 'skip');
    assert.equal(result.ok, true);
    assert.equal((result as any).resolution, 'skip');

    const planUpdate = mock.updates.find((u) => u.table === 'plans' && u.patch.status === 'skipped');
    assert.ok(planUpdate, 'plan should be marked skipped');
  });

  it('dismiss returns ok without changes', async () => {
    const { applyMeetingConflictOption } = await loadModule();
    const mock = makeSupaMock({
      plans: {
        maybeSingleResult: { data: planRow(), error: null },
        selectResult: { data: [{ date: '2026-04-20' }], error: null },
      },
    });

    const result = await applyMeetingConflictOption(mock.sb, USER_ID, baseMeetingDiff, 'dismiss');
    assert.equal(result.ok, true);
    assert.equal((result as any).resolution, 'dismiss');

    // No plan updates should exist (no time_override, no status change).
    const planUpdates = mock.updates.filter((u) => u.table === 'plans');
    assert.equal(planUpdates.length, 0);
  });

  it('returns noop when plan is already gone', async () => {
    const { applyMeetingConflictOption } = await loadModule();
    const mock = makeSupaMock({
      plans: {
        maybeSingleResult: { data: null, error: null },
        selectResult: { data: [], error: null },
      },
    });

    const result = await applyMeetingConflictOption(mock.sb, USER_ID, baseMeetingDiff, 'skip');
    assert.equal(result.ok, true);
    assert.equal((result as any).resolution, 'noop_plan_gone');
  });

  it('rejects unknown option_id', async () => {
    const { applyMeetingConflictOption } = await loadModule();
    const mock = makeSupaMock({});
    const result = await applyMeetingConflictOption(mock.sb, USER_ID, baseMeetingDiff, 'nonexistent');
    assert.equal(result.ok, false);
    assert.ok((result as any).reason.includes('unknown option_id'));
  });
});
