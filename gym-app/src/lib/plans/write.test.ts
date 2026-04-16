/**
 * Unit tests for `enqueuePlanSync` + `dedupAndFilter` (P1.4 / PR-S).
 *
 * Run via:
 *   npx tsx --test src/lib/plans/write.test.ts
 *
 * These tests use a lightweight fluent Supabase mock — enough to drive
 * the three read paths (`google_tokens`, `sync_jobs` queued lookup,
 * `calendar_links` snapshot) plus the single `sync_jobs` insert — and
 * assert on the enqueued rows themselves rather than relying on a real
 * DB round-trip.
 *
 * The coverage map mirrors the helper's documented contract:
 *   - Gating: missing tokens / non-active status / no training calendar.
 *   - Dedup: identical queued upsert/delete already present.
 *   - Deletes: snapshot captures google_* fields; missing link → skip.
 *   - Error isolation: DB error on insert is swallowed + counted skipped.
 *   - dedupAndFilter: pure helper exhaustively exercised.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { dedupAndFilter, enqueuePlanSync } from './write';

// =====================================================================
// Minimal fluent Supabase mock
// =====================================================================

type QueryResult = { data: unknown; error: unknown };

type TableMock = {
  /**
   * Result returned when the chain is awaited WITHOUT `.maybeSingle()`.
   * Used by the list reads: `sync_jobs` queued lookup and
   * `calendar_links` snapshot.
   */
  listResult?: QueryResult;
  /**
   * Result returned when the chain ends in `.maybeSingle()`. Used by
   * the `google_tokens` gate.
   */
  maybeSingleResult?: QueryResult;
  /**
   * Result returned from `.insert(rows)`. Captured `insertCalls`
   * holds the row arrays for post-hoc assertions.
   */
  insertResult?: QueryResult;
  insertCalls: unknown[][];
};

type SupaMock = {
  sb: any;
  tables: Record<string, TableMock>;
};

function makeSupaMock(config: Record<string, Partial<TableMock>>): SupaMock {
  const tables: Record<string, TableMock> = {};
  for (const [name, partial] of Object.entries(config)) {
    tables[name] = {
      listResult: partial.listResult ?? { data: [], error: null },
      maybeSingleResult: partial.maybeSingleResult ?? { data: null, error: null },
      insertResult: partial.insertResult ?? { data: null, error: null },
      insertCalls: [],
    };
  }

  const sb = {
    from(tableName: string) {
      const cfg = tables[tableName];
      if (!cfg) {
        throw new Error(
          `[test mock] unexpected table access: ${tableName} (configure it in makeSupaMock)`
        );
      }

      // A single builder object: chain methods (`select`, `eq`, `in`)
      // return `this`; terminal resolvers (`maybeSingle`, `.then` when
      // awaited directly) resolve against the table's configured result.
      const builder: any = {
        select() { return builder; },
        eq() { return builder; },
        in() { return builder; },
        maybeSingle() {
          return Promise.resolve(cfg.maybeSingleResult);
        },
        insert(rows: unknown[]) {
          cfg.insertCalls.push(rows);
          // Post-insert `.select('id')` chaining isn't exercised by
          // write.ts's sync_jobs insert, but return `builder` anyway
          // so future callers don't silently break.
          const insertThenable: any = {
            select() { return insertThenable; },
            then(resolve: any, reject: any) {
              return Promise.resolve(cfg.insertResult).then(resolve, reject);
            },
          };
          return insertThenable;
        },
        then(resolve: any, reject: any) {
          return Promise.resolve(cfg.listResult).then(resolve, reject);
        },
      };
      return builder;
    },
  };

  return { sb, tables };
}

// =====================================================================
// dedupAndFilter (pure helper)
// =====================================================================

describe('dedupAndFilter', () => {
  it('returns empty array for undefined input', () => {
    assert.deepEqual(dedupAndFilter(undefined), []);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(dedupAndFilter([]), []);
  });

  it('preserves a unique list in input order', () => {
    const r = dedupAndFilter(['a', 'b', 'c']);
    assert.deepEqual(r.sort(), ['a', 'b', 'c']);
  });

  it('strips duplicates', () => {
    const r = dedupAndFilter(['a', 'b', 'a', 'c', 'b']);
    assert.equal(r.length, 3);
    assert.ok(r.includes('a'));
    assert.ok(r.includes('b'));
    assert.ok(r.includes('c'));
  });

  it('strips falsy entries (empty string)', () => {
    const r = dedupAndFilter(['a', '', 'b', '']);
    assert.deepEqual(r.sort(), ['a', 'b']);
  });

  it('strips non-string entries defensively', () => {
    // The type signature says string[], but callers can cheat through
    // `any`. Mixed runtime inputs shouldn't crash the helper.
    const mixed = ['a', null as unknown as string, 42 as unknown as string, 'b'];
    const r = dedupAndFilter(mixed);
    assert.deepEqual(r.sort(), ['a', 'b']);
  });
});

// =====================================================================
// enqueuePlanSync — gating
// =====================================================================

describe('enqueuePlanSync: gating', () => {
  const userId = 'user-1';

  it('no-ops (returns {0,0}) for empty input before touching DB', async () => {
    const m = makeSupaMock({});
    const r = await enqueuePlanSync(m.sb, userId, {});
    assert.deepEqual(r, { enqueued: 0, skipped: 0 });
    // No `from()` call should have been made — passing an empty
    // config above would throw on any access, so reaching here is
    // proof the short-circuit fired.
  });

  it('no-ops when upsertIds/deleteIds are empty arrays', async () => {
    const m = makeSupaMock({});
    const r = await enqueuePlanSync(m.sb, userId, { upsertIds: [], deleteIds: [] });
    assert.deepEqual(r, { enqueued: 0, skipped: 0 });
  });

  it('skips everything when user has no google_tokens row', async () => {
    const m = makeSupaMock({
      google_tokens: { maybeSingleResult: { data: null, error: null } },
    });
    const r = await enqueuePlanSync(m.sb, userId, { upsertIds: ['p1', 'p2'] });
    assert.deepEqual(r, { enqueued: 0, skipped: 2 });
    assert.equal(m.tables.google_tokens!.insertCalls.length, 0);
  });

  it("skips everything when google_tokens.status !== 'active'", async () => {
    const m = makeSupaMock({
      google_tokens: {
        maybeSingleResult: {
          data: { status: 'error', training_calendar_id: 'cal-abc' },
          error: null,
        },
      },
    });
    const r = await enqueuePlanSync(m.sb, userId, {
      upsertIds: ['p1'],
      deleteIds: ['p2'],
    });
    assert.deepEqual(r, { enqueued: 0, skipped: 2 });
  });

  it('skips everything when training_calendar_id is null', async () => {
    const m = makeSupaMock({
      google_tokens: {
        maybeSingleResult: {
          data: { status: 'active', training_calendar_id: null },
          error: null,
        },
      },
    });
    const r = await enqueuePlanSync(m.sb, userId, { upsertIds: ['p1'] });
    assert.deepEqual(r, { enqueued: 0, skipped: 1 });
  });

  it('skips everything when google_tokens lookup errors', async () => {
    const m = makeSupaMock({
      google_tokens: {
        maybeSingleResult: { data: null, error: { message: 'boom' } },
      },
    });
    const r = await enqueuePlanSync(m.sb, userId, { upsertIds: ['p1'] });
    assert.deepEqual(r, { enqueued: 0, skipped: 1 });
  });
});

// =====================================================================
// enqueuePlanSync — upsert path
// =====================================================================

describe('enqueuePlanSync: upsert path', () => {
  const userId = 'user-2';
  const activeToken = {
    maybeSingleResult: {
      data: { status: 'active', training_calendar_id: 'cal-xyz' },
      error: null,
    },
  };

  it('enqueues a plan_upsert job for each new plan id', async () => {
    const m = makeSupaMock({
      google_tokens: activeToken,
      sync_jobs: { listResult: { data: [], error: null } },
    });

    const r = await enqueuePlanSync(m.sb, userId, { upsertIds: ['p1', 'p2'] });

    assert.deepEqual(r, { enqueued: 2, skipped: 0 });
    assert.equal(m.tables.sync_jobs!.insertCalls.length, 1);
    const inserted = m.tables.sync_jobs!.insertCalls[0] as Array<{
      user_id: string;
      kind: string;
      payload: { plan_id: string };
    }>;
    assert.equal(inserted.length, 2);
    for (const row of inserted) {
      assert.equal(row.user_id, userId);
      assert.equal(row.kind, 'plan_upsert');
      assert.ok(['p1', 'p2'].includes(row.payload.plan_id));
    }
  });

  it('dedups duplicate plan ids within a single call', async () => {
    const m = makeSupaMock({
      google_tokens: activeToken,
      sync_jobs: { listResult: { data: [], error: null } },
    });

    const r = await enqueuePlanSync(m.sb, userId, {
      upsertIds: ['p1', 'p1', 'p2', 'p1'],
    });

    assert.equal(r.enqueued, 2);
    const inserted = m.tables.sync_jobs!.insertCalls[0] as Array<{
      payload: { plan_id: string };
    }>;
    const insertedIds = inserted.map((r) => r.payload.plan_id).sort();
    assert.deepEqual(insertedIds, ['p1', 'p2']);
  });

  it('skips upserts that already have a queued plan_upsert for the same plan', async () => {
    const m = makeSupaMock({
      google_tokens: activeToken,
      sync_jobs: {
        listResult: {
          data: [
            { kind: 'plan_upsert', payload: { plan_id: 'p1' } },
            // 'plan_delete' for p3 shouldn't block a plan_upsert for p3;
            // they're different kinds.
            { kind: 'plan_delete', payload: { plan_id: 'p3' } },
          ],
          error: null,
        },
      },
    });

    const r = await enqueuePlanSync(m.sb, userId, {
      upsertIds: ['p1', 'p2', 'p3'],
    });

    assert.equal(r.enqueued, 2);
    assert.equal(r.skipped, 1);
    const inserted = m.tables.sync_jobs!.insertCalls[0] as Array<{
      payload: { plan_id: string };
    }>;
    const insertedIds = inserted.map((r) => r.payload.plan_id).sort();
    assert.deepEqual(insertedIds, ['p2', 'p3']);
  });

  it('does not call calendar_links lookup when only upserts are requested', async () => {
    // calendar_links isn't configured → the mock would throw on access.
    const m = makeSupaMock({
      google_tokens: activeToken,
      sync_jobs: { listResult: { data: [], error: null } },
    });

    await assert.doesNotReject(
      enqueuePlanSync(m.sb, userId, { upsertIds: ['p1'] })
    );
  });
});

// =====================================================================
// enqueuePlanSync — delete path (snapshotting)
// =====================================================================

describe('enqueuePlanSync: delete path', () => {
  const userId = 'user-3';
  const activeToken = {
    maybeSingleResult: {
      data: { status: 'active', training_calendar_id: 'cal-xyz' },
      error: null,
    },
  };

  it('snapshots google_event_id + google_calendar_id + google_etag into the payload', async () => {
    const m = makeSupaMock({
      google_tokens: activeToken,
      sync_jobs: { listResult: { data: [], error: null } },
      calendar_links: {
        listResult: {
          data: [
            {
              plan_id: 'p1',
              google_event_id: 'evt-1',
              google_calendar_id: 'cal-xyz',
              google_etag: '"etag-1"',
            },
          ],
          error: null,
        },
      },
    });

    const r = await enqueuePlanSync(m.sb, userId, { deleteIds: ['p1'] });

    assert.deepEqual(r, { enqueued: 1, skipped: 0 });
    const inserted = m.tables.sync_jobs!.insertCalls[0] as Array<{
      kind: string;
      payload: {
        plan_id: string;
        google_event_id: string;
        google_calendar_id: string;
        google_etag: string | null;
      };
    }>;
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0]!.kind, 'plan_delete');
    assert.equal(inserted[0]!.payload.plan_id, 'p1');
    assert.equal(inserted[0]!.payload.google_event_id, 'evt-1');
    assert.equal(inserted[0]!.payload.google_calendar_id, 'cal-xyz');
    assert.equal(inserted[0]!.payload.google_etag, '"etag-1"');
  });

  it('passes google_etag=null through when the link has no etag yet', async () => {
    const m = makeSupaMock({
      google_tokens: activeToken,
      sync_jobs: { listResult: { data: [], error: null } },
      calendar_links: {
        listResult: {
          data: [
            {
              plan_id: 'p1',
              google_event_id: 'evt-1',
              google_calendar_id: 'cal-xyz',
              google_etag: null,
            },
          ],
          error: null,
        },
      },
    });

    const r = await enqueuePlanSync(m.sb, userId, { deleteIds: ['p1'] });
    assert.equal(r.enqueued, 1);
    const inserted = m.tables.sync_jobs!.insertCalls[0] as Array<{
      payload: { google_etag: string | null };
    }>;
    assert.equal(inserted[0]!.payload.google_etag, null);
  });

  it('skips deletes for plans that have no calendar_link (never synced)', async () => {
    const m = makeSupaMock({
      google_tokens: activeToken,
      sync_jobs: { listResult: { data: [], error: null } },
      calendar_links: {
        listResult: {
          data: [
            // p1 has a link, p2 does not → p2 is skipped.
            {
              plan_id: 'p1',
              google_event_id: 'evt-1',
              google_calendar_id: 'cal-xyz',
              google_etag: null,
            },
          ],
          error: null,
        },
      },
    });

    const r = await enqueuePlanSync(m.sb, userId, { deleteIds: ['p1', 'p2'] });

    assert.deepEqual(r, { enqueued: 1, skipped: 1 });
    const inserted = m.tables.sync_jobs!.insertCalls[0] as Array<{
      payload: { plan_id: string };
    }>;
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0]!.payload.plan_id, 'p1');
  });

  it('skips deletes for plans already queued for plan_delete', async () => {
    const m = makeSupaMock({
      google_tokens: activeToken,
      sync_jobs: {
        listResult: {
          data: [{ kind: 'plan_delete', payload: { plan_id: 'p1' } }],
          error: null,
        },
      },
      calendar_links: {
        listResult: {
          data: [
            {
              plan_id: 'p1',
              google_event_id: 'evt-1',
              google_calendar_id: 'cal-xyz',
              google_etag: null,
            },
            {
              plan_id: 'p2',
              google_event_id: 'evt-2',
              google_calendar_id: 'cal-xyz',
              google_etag: null,
            },
          ],
          error: null,
        },
      },
    });

    const r = await enqueuePlanSync(m.sb, userId, { deleteIds: ['p1', 'p2'] });

    assert.equal(r.enqueued, 1);
    assert.equal(r.skipped, 1);
    const inserted = m.tables.sync_jobs!.insertCalls[0] as Array<{
      payload: { plan_id: string };
    }>;
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0]!.payload.plan_id, 'p2');
  });

  it('tolerates calendar_links lookup error by skipping all deletes silently', async () => {
    const m = makeSupaMock({
      google_tokens: activeToken,
      sync_jobs: { listResult: { data: [], error: null } },
      calendar_links: {
        listResult: { data: null, error: { message: 'boom' } },
      },
    });

    const r = await enqueuePlanSync(m.sb, userId, { deleteIds: ['p1', 'p2'] });
    // Both deletes drop out because snapshot map is empty.
    assert.equal(r.enqueued, 0);
    assert.equal(r.skipped, 2);
    assert.equal(m.tables.sync_jobs!.insertCalls.length, 0);
  });
});

// =====================================================================
// enqueuePlanSync — mixed upsert + delete
// =====================================================================

describe('enqueuePlanSync: mixed', () => {
  const userId = 'user-4';
  const activeToken = {
    maybeSingleResult: {
      data: { status: 'active', training_calendar_id: 'cal-xyz' },
      error: null,
    },
  };

  it('batches upserts + deletes into a single sync_jobs insert', async () => {
    const m = makeSupaMock({
      google_tokens: activeToken,
      sync_jobs: { listResult: { data: [], error: null } },
      calendar_links: {
        listResult: {
          data: [
            {
              plan_id: 'd1',
              google_event_id: 'evt-d1',
              google_calendar_id: 'cal-xyz',
              google_etag: null,
            },
          ],
          error: null,
        },
      },
    });

    const r = await enqueuePlanSync(m.sb, userId, {
      upsertIds: ['u1', 'u2'],
      deleteIds: ['d1'],
    });

    assert.deepEqual(r, { enqueued: 3, skipped: 0 });
    // One round-trip for the insert, carrying all 3 rows.
    assert.equal(m.tables.sync_jobs!.insertCalls.length, 1);
    const rows = m.tables.sync_jobs!.insertCalls[0] as Array<{ kind: string }>;
    assert.equal(rows.length, 3);
    const kinds = rows.map((r) => r.kind).sort();
    assert.deepEqual(kinds, ['plan_delete', 'plan_upsert', 'plan_upsert']);
  });
});

// =====================================================================
// enqueuePlanSync — error isolation
// =====================================================================

describe('enqueuePlanSync: error isolation', () => {
  const userId = 'user-5';
  const activeToken = {
    maybeSingleResult: {
      data: { status: 'active', training_calendar_id: 'cal-xyz' },
      error: null,
    },
  };

  it('swallows sync_jobs insert error and counts all rows as skipped', async () => {
    const m = makeSupaMock({
      google_tokens: activeToken,
      sync_jobs: {
        listResult: { data: [], error: null },
        insertResult: { data: null, error: { message: 'db down' } },
      },
    });

    const r = await enqueuePlanSync(m.sb, userId, {
      upsertIds: ['p1', 'p2'],
    });

    // Insert was attempted (2 candidate rows) but the DB said no —
    // both counted as skipped, never thrown.
    assert.deepEqual(r, { enqueued: 0, skipped: 2 });
  });

  it('swallows sync_jobs queued-lookup error (treats existing set as empty)', async () => {
    const m = makeSupaMock({
      google_tokens: activeToken,
      sync_jobs: {
        listResult: { data: null, error: { message: 'query failed' } },
      },
    });

    const r = await enqueuePlanSync(m.sb, userId, { upsertIds: ['p1'] });

    // Lookup error means the helper treats nothing as already-queued
    // and proceeds with the enqueue. That's the right call: better
    // to risk a dup (worker is idempotent on plan_upsert) than to
    // silently drop the user's intent.
    assert.equal(r.enqueued, 1);
    assert.equal(r.skipped, 0);
  });

  it('never throws when a table lookup fails outright', async () => {
    const m = makeSupaMock({
      google_tokens: activeToken,
      sync_jobs: {
        listResult: { data: null, error: { message: 'whoops' } },
        insertResult: { data: null, error: { message: 'also whoops' } },
      },
      calendar_links: {
        listResult: { data: null, error: { message: 'also also whoops' } },
      },
    });

    await assert.doesNotReject(
      enqueuePlanSync(m.sb, userId, { upsertIds: ['p1'], deleteIds: ['p2'] })
    );
  });
});
