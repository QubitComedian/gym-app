/**
 * Unit tests for the conflict resolver I/O wrapper (P1.4 / PR-U).
 *
 * Run via:
 *   npx tsx --test src/lib/google/conflict.test.ts
 *
 * Tests the resolver's DB interactions (discovery, auto-resolve state
 * transitions, proposal creation, idempotency) using the same fluent
 * Supabase mock pattern as the worker tests. The pure classification
 * logic is tested in conflict.pure.test.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Dynamic import to avoid googleapis top-level init.
async function loadModule() {
  return await import('./conflict');
}

// =====================================================================
// Fluent Supabase mock (reused pattern from worker.test.ts)
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
        limit() { return builder; },
        order() { return builder; },
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
// resolveConflicts (top-level)
// =====================================================================

describe('resolveConflicts', () => {
  it('returns zeros when no conflicted links exist', async () => {
    const { resolveConflicts } = await loadModule();
    const mock = makeSupaMock({
      calendar_links: { selectResult: { data: [], error: null } },
    });

    const r = await resolveConflicts(mock.sb);

    assert.equal(r.discovered, 0);
    assert.equal(r.auto_resolved, 0);
    assert.equal(r.proposals_created, 0);
    assert.equal(r.errors, 0);
  });

  it('returns zeros on discovery query error', async () => {
    const { resolveConflicts } = await loadModule();
    const mock = makeSupaMock({
      calendar_links: { selectResult: { data: null, error: { message: 'boom' } } },
    });

    const r = await resolveConflicts(mock.sb);
    assert.equal(r.discovered, 0);
  });

  it('counts discovery even when context build fails', async () => {
    const { resolveConflicts } = await loadModule();
    const mock = makeSupaMock({
      calendar_links: {
        selectResult: {
          data: [{
            id: 'link-1', user_id: 'u1', plan_id: 'p1',
            google_event_id: 'e1', google_calendar_id: 'c1',
            google_etag: '"old"', checksum: 'abc',
          }],
          error: null,
        },
      },
      // No google_tokens config → context build will fail
      google_tokens: { maybeSingleResult: { data: null, error: null } },
      training_preferences: { maybeSingleResult: { data: null, error: null } },
      profiles: { maybeSingleResult: { data: null, error: null } },
    });

    const r = await resolveConflicts(mock.sb);
    assert.equal(r.discovered, 1);
    assert.equal(r.errors, 1);
  });
});

// =====================================================================
// resolveOneConflict outcomes
// =====================================================================

describe('resolveOneConflict: skipped_no_plan', () => {
  it('clears sync_status when plan_id is null', async () => {
    const { resolveOneConflict } = await loadModule();
    const mock = makeSupaMock({
      calendar_links: {},
    });

    const link = {
      id: 'link-1', user_id: 'u1', plan_id: null,
      google_event_id: 'e1', google_calendar_id: 'c1',
      google_etag: '"old"', checksum: 'abc',
    };

    const ctx = { cal: {} as any, calendarId: 'c1', prefs: {} as any, timezone: 'UTC' };
    const outcome = await resolveOneConflict(mock.sb, ctx, link);

    assert.equal(outcome, 'skipped_no_plan');
    const upd = mock.updates.find(u => u.table === 'calendar_links');
    assert.ok(upd);
    assert.equal(upd!.patch.sync_status, 'synced');
  });

  it('clears sync_status when plan was deleted (not found)', async () => {
    const { resolveOneConflict } = await loadModule();
    const mock = makeSupaMock({
      plans: { maybeSingleResult: { data: null, error: null } },
      calendar_links: {},
    });

    const link = {
      id: 'link-1', user_id: 'u1', plan_id: 'p1',
      google_event_id: 'e1', google_calendar_id: 'c1',
      google_etag: '"old"', checksum: 'abc',
    };

    const ctx = { cal: {} as any, calendarId: 'c1', prefs: {} as any, timezone: 'UTC' };
    const outcome = await resolveOneConflict(mock.sb, ctx, link);

    assert.equal(outcome, 'skipped_no_plan');
  });
});

// =====================================================================
// createConflictProposal: idempotency
// =====================================================================

describe('createConflictProposal: idempotency', () => {
  it('skips when a pending conflict proposal already exists', async () => {
    const { createConflictProposal } = await loadModule();
    const mock = makeSupaMock({
      ai_proposals: {
        maybeSingleResult: { data: { id: 'existing-proposal' }, error: null },
      },
    });

    const link = {
      id: 'link-1', user_id: 'u1', plan_id: 'p1',
      google_event_id: 'e1', google_calendar_id: 'c1',
      google_etag: '"old"', checksum: 'abc',
    };
    const plan = {
      id: 'p1', date: '2026-04-16', type: 'gym',
      day_code: 'push', status: 'planned', prescription: {},
    };
    const projected = {
      summary: '🏋️ Push', description: '',
      start: { dateTime: '2026-04-16T07:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-04-16T08:00:00', timeZone: 'UTC' },
    };
    const remote = {
      exists: true as const,
      summary: 'Moved Workout',
      description: '',
      start: { dateTime: '2026-04-16T18:00:00' },
      end: { dateTime: '2026-04-16T19:00:00' },
      etag: '"new"',
    };
    const classification = {
      kind: 'time_moved' as const,
      reason: 'Event was moved.',
      options: [
        { id: 'keep_app', label: 'Keep app schedule', action: 'force_push' as const },
        { id: 'accept_google', label: 'Accept Google time', action: 'accept_remote' as const },
      ],
    };

    const outcome = await createConflictProposal(
      mock.sb, link, plan, projected, remote, classification
    );

    assert.equal(outcome, 'skipped_existing_proposal');
    // No insert should have been made.
    assert.equal(mock.inserts.filter(i => i.table === 'ai_proposals').length, 0);
  });

  it('creates a proposal when none exists', async () => {
    const { createConflictProposal } = await loadModule();
    const mock = makeSupaMock({
      ai_proposals: {
        maybeSingleResult: { data: null, error: null },
      },
      calendar_links: {},
    });

    const link = {
      id: 'link-1', user_id: 'u1', plan_id: 'p1',
      google_event_id: 'e1', google_calendar_id: 'c1',
      google_etag: '"old"', checksum: 'abc',
    };
    const plan = {
      id: 'p1', date: '2026-04-16', type: 'gym',
      day_code: 'push', status: 'planned', prescription: {},
    };
    const projected = {
      summary: '🏋️ Push', description: '',
      start: { dateTime: '2026-04-16T07:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-04-16T08:00:00', timeZone: 'UTC' },
    };
    const remote = {
      exists: true as const,
      summary: '🏋️ Push',
      description: '',
      start: { dateTime: '2026-04-16T18:00:00' },
      end: { dateTime: '2026-04-16T19:00:00' },
      etag: '"new"',
    };
    const classification = {
      kind: 'time_moved' as const,
      reason: 'Event was moved.',
      options: [
        { id: 'keep_app', label: 'Keep app', action: 'force_push' as const },
      ],
    };

    const outcome = await createConflictProposal(
      mock.sb, link, plan, projected, remote, classification
    );

    assert.equal(outcome, 'proposal_created');
    const proposalInserts = mock.inserts.filter(i => i.table === 'ai_proposals');
    assert.equal(proposalInserts.length, 1);
    const row = proposalInserts[0]!.rows[0] as Record<string, unknown>;
    assert.equal(row.kind, 'conflict');
    assert.equal(row.status, 'pending');
    assert.equal(row.user_id, 'u1');

    // Should also update remote_snapshot on calendar_links
    const snapshotUpd = mock.updates.find(
      u => u.table === 'calendar_links' && u.patch.remote_snapshot != null
    );
    assert.ok(snapshotUpd);
  });
});

// =====================================================================
// fetchRemoteEvent
// =====================================================================

describe('fetchRemoteEvent', () => {
  it('returns exists:false on 404', async () => {
    const { fetchRemoteEvent } = await loadModule();

    const mockCal = {
      events: {
        get: () => Promise.reject({ code: 404, message: 'Not Found' }),
      },
    };

    const link = {
      id: 'link-1', user_id: 'u1', plan_id: 'p1',
      google_event_id: 'e1', google_calendar_id: 'c1',
      google_etag: null, checksum: null,
    };

    const r = await fetchRemoteEvent(mockCal as any, link);
    assert.equal(r.exists, false);
  });

  it('returns event data on success', async () => {
    const { fetchRemoteEvent } = await loadModule();

    const mockCal = {
      events: {
        get: () => Promise.resolve({
          data: {
            summary: 'Push Day',
            description: 'workout',
            start: { dateTime: '2026-04-16T07:00:00+02:00' },
            end: { dateTime: '2026-04-16T08:00:00+02:00' },
            etag: '"abc"',
          },
        }),
      },
    };

    const link = {
      id: 'link-1', user_id: 'u1', plan_id: 'p1',
      google_event_id: 'e1', google_calendar_id: 'c1',
      google_etag: null, checksum: null,
    };

    const r = await fetchRemoteEvent(mockCal as any, link);
    assert.equal(r.exists, true);
    if (r.exists) {
      assert.equal(r.summary, 'Push Day');
      assert.equal(r.etag, '"abc"');
    }
  });

  it('throws on non-404 errors', async () => {
    const { fetchRemoteEvent } = await loadModule();

    const mockCal = {
      events: {
        get: () => Promise.reject({ code: 500, message: 'Server Error' }),
      },
    };

    const link = {
      id: 'link-1', user_id: 'u1', plan_id: 'p1',
      google_event_id: 'e1', google_calendar_id: 'c1',
      google_etag: null, checksum: null,
    };

    await assert.rejects(
      fetchRemoteEvent(mockCal as any, link),
      (err: any) => err.code === 500
    );
  });
});
