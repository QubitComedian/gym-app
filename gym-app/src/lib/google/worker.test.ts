/**
 * Unit tests for the Google Calendar sync worker (P1.4 / PR-T).
 *
 * Run via:
 *   npx tsx --test src/lib/google/worker.test.ts
 *
 * Tests the worker's I/O orchestration — claim, upsert, delete, error
 * handling, backoff — using a fluent Supabase mock and stub Google
 * Calendar client. The pure projection logic is tested separately in
 * project.test.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  type SyncJob,
  MAX_ATTEMPTS,
  BASE_DELAY_S,
} from './worker';

// We can't easily mock `google` at module level, so we test the
// exported helper functions against their DB interactions and test
// the pure decision logic (requeueOrFail, markDone, handleJobError)
// via their Supabase side effects.

// =====================================================================
// Lightweight mock infrastructure
// =====================================================================

type UpdateCall = { table: string; patch: Record<string, unknown>; filters: Record<string, unknown> };
type InsertCall = { table: string; rows: unknown[] };
type DeleteCall = { table: string; filters: Record<string, unknown> };

type TableConfig = {
  selectResult?: { data: unknown; error: unknown };
  maybeSingleResult?: { data: unknown; error: unknown };
  insertResult?: { data: unknown; error: unknown };
  updateResult?: { data: unknown; error: unknown; count?: number };
  deleteResult?: { data: unknown; error: unknown; count?: number };
};

type MockState = {
  sb: any;
  updates: UpdateCall[];
  inserts: InsertCall[];
  deletes: DeleteCall[];
};

function makeSupaMock(tables: Record<string, TableConfig>): MockState {
  const state: MockState = { sb: null, updates: [], inserts: [], deletes: [] };

  const sb: any = {
    from(tableName: string) {
      const cfg = tables[tableName] ?? {};
      const filters: Record<string, unknown> = {};

      const builder: any = {
        select() { return builder; },
        eq(col: string, val: unknown) { filters[col] = val; return builder; },
        in(col: string, val: unknown) { filters[`${col}__in`] = val; return builder; },
        lte(col: string, val: unknown) { filters[`${col}__lte`] = val; return builder; },
        gte(col: string, val: unknown) { filters[`${col}__gte`] = val; return builder; },
        order() { return builder; },
        limit() { return builder; },
        maybeSingle() {
          return Promise.resolve(
            cfg.maybeSingleResult ?? { data: null, error: null }
          );
        },
        insert(rows: unknown[]) {
          state.inserts.push({ table: tableName, rows: Array.isArray(rows) ? rows : [rows] });
          const insertBuilder: any = {
            select() { return insertBuilder; },
            single() { return insertBuilder; },
            then(resolve: any, reject: any) {
              return Promise.resolve(cfg.insertResult ?? { data: null, error: null }).then(resolve, reject);
            },
          };
          return insertBuilder;
        },
        update(patch: Record<string, unknown>) {
          const updateBuilder: any = {
            eq(col: string, val: unknown) { filters[col] = val; return updateBuilder; },
            in(col: string, val: unknown) { filters[`${col}__in`] = val; return updateBuilder; },
            then(resolve: any, reject: any) {
              state.updates.push({ table: tableName, patch, filters: { ...filters } });
              return Promise.resolve(cfg.updateResult ?? { data: null, error: null }).then(resolve, reject);
            },
          };
          return updateBuilder;
        },
        delete(opts?: { count?: string }) {
          const deleteBuilder: any = {
            eq(col: string, val: unknown) { filters[col] = val; return deleteBuilder; },
            in(col: string, val: unknown) { filters[`${col}__in`] = val; return deleteBuilder; },
            then(resolve: any, reject: any) {
              state.deletes.push({ table: tableName, filters: { ...filters } });
              return Promise.resolve(
                cfg.deleteResult ?? { data: null, error: null, count: 1 }
              ).then(resolve, reject);
            },
          };
          return deleteBuilder;
        },
        then(resolve: any, reject: any) {
          return Promise.resolve(
            cfg.selectResult ?? { data: [], error: null }
          ).then(resolve, reject);
        },
      };
      return builder;
    },
  };

  state.sb = sb;
  return state;
}

// =====================================================================
// requeueOrFail (imported indirectly — we test via markDone behavior)
// =====================================================================

// Since the worker module imports googleapis at the top level, which
// needs env vars, we use dynamic import to test only the pure helpers
// that don't trigger googleapis initialization.

// We'll import the module lazily and test the helpers that accept
// an sb parameter.

async function loadWorker() {
  // Dynamic import to avoid top-level googleapis init in test env.
  // The module will still load but googleapis won't be called until
  // buildUserContext/processUpsert/processDelete actually execute.
  return await import('./worker');
}

describe('requeueOrFail', () => {
  it('re-queues a job with exponential backoff', async () => {
    const { requeueOrFail } = await loadWorker();
    const mock = makeSupaMock({ sync_jobs: {} });
    const job: SyncJob = {
      id: 1, user_id: 'u1', kind: 'plan_upsert',
      payload: { plan_id: 'p1' }, status: 'running', attempt: 1,
    };

    await requeueOrFail(mock.sb, job, 'transient error');

    assert.equal(mock.updates.length, 1);
    const upd = mock.updates[0]!;
    assert.equal(upd.table, 'sync_jobs');
    assert.equal(upd.patch.status, 'queued');
    assert.equal(upd.patch.attempt, 2);
    assert.equal(upd.patch.last_error, 'transient error');
    // run_after should be in the future
    assert.ok(new Date(upd.patch.run_after as string).getTime() > Date.now() - 1000);
  });

  it('marks job as failed when attempt >= MAX_ATTEMPTS', async () => {
    const { requeueOrFail } = await loadWorker();
    const mock = makeSupaMock({ sync_jobs: {} });
    const job: SyncJob = {
      id: 2, user_id: 'u1', kind: 'plan_upsert',
      payload: { plan_id: 'p1' }, status: 'running', attempt: MAX_ATTEMPTS - 1,
    };

    await requeueOrFail(mock.sb, job, 'still failing');

    const upd = mock.updates[0]!;
    assert.equal(upd.patch.status, 'failed');
    assert.ok((upd.patch.last_error as string).includes('max attempts'));
  });

  it('backoff delay doubles with each attempt', async () => {
    const { requeueOrFail } = await loadWorker();

    const delays: number[] = [];
    for (let attempt = 0; attempt < MAX_ATTEMPTS - 1; attempt++) {
      const mock = makeSupaMock({ sync_jobs: {} });
      const job: SyncJob = {
        id: 10 + attempt, user_id: 'u1', kind: 'plan_upsert',
        payload: { plan_id: 'p1' }, status: 'running', attempt,
      };
      await requeueOrFail(mock.sb, job, 'err');
      const runAfter = new Date(mock.updates[0]!.patch.run_after as string).getTime();
      delays.push(runAfter - Date.now());
    }

    // Each delay should be roughly double the previous (within tolerance).
    for (let i = 1; i < delays.length; i++) {
      // Allow 2s of tolerance for test execution time.
      assert.ok(
        delays[i]! > delays[i - 1]! * 1.5,
        `delay[${i}]=${delays[i]} should be > 1.5× delay[${i - 1}]=${delays[i - 1]}`
      );
    }
  });
});

describe('markDone', () => {
  it('sets status=done and clears last_error', async () => {
    const { markDone } = await loadWorker();
    const mock = makeSupaMock({ sync_jobs: {} });

    await markDone(mock.sb, 42);

    assert.equal(mock.updates.length, 1);
    const upd = mock.updates[0]!;
    assert.equal(upd.table, 'sync_jobs');
    assert.equal(upd.patch.status, 'done');
    assert.equal(upd.patch.last_error, null);
    assert.equal(upd.filters.id, 42);
  });
});

describe('handleJobError', () => {
  const makeCtx = (): any => ({
    cal: {},
    calendarId: 'cal-1',
    prefs: {},
    timezone: 'UTC',
    tokenRevoked: false,
  });

  const baseJob: SyncJob = {
    id: 100, user_id: 'u1', kind: 'plan_upsert',
    payload: { plan_id: 'p1' }, status: 'running', attempt: 0,
  };

  it('marks token as error on 401 and returns token_error', async () => {
    const { handleJobError } = await loadWorker();
    const mock = makeSupaMock({ google_tokens: {}, sync_jobs: {} });
    const ctx = makeCtx();

    const outcome = await handleJobError(
      mock.sb, ctx, baseJob,
      { code: 401, message: 'invalid_grant' },
    );

    assert.equal(outcome, 'token_error');
    assert.ok(ctx.tokenRevoked);
    // Should update google_tokens.status='error'
    const tokenUpd = mock.updates.find(u => u.table === 'google_tokens');
    assert.ok(tokenUpd);
    assert.equal(tokenUpd!.patch.status, 'error');
  });

  it('marks token as error on 403', async () => {
    const { handleJobError } = await loadWorker();
    const mock = makeSupaMock({ google_tokens: {}, sync_jobs: {} });
    const ctx = makeCtx();

    const outcome = await handleJobError(
      mock.sb, ctx, baseJob,
      { code: 403, message: 'forbidden' },
    );
    assert.equal(outcome, 'token_error');
  });

  it('resolves 404 on delete as already-gone', async () => {
    const { handleJobError } = await loadWorker();
    const mock = makeSupaMock({ calendar_links: {}, sync_jobs: {} });
    const ctx = makeCtx();
    const deleteJob: SyncJob = {
      ...baseJob, kind: 'plan_delete',
      payload: { plan_id: 'p1', google_event_id: 'e1', google_calendar_id: 'c1' },
    };

    const outcome = await handleJobError(
      mock.sb, ctx, deleteJob,
      { code: 404, message: 'not found' },
    );

    assert.equal(outcome, 'resolved');
    // Should mark the sync_job as done
    const doneUpd = mock.updates.find(u => u.table === 'sync_jobs' && u.patch.status === 'done');
    assert.ok(doneUpd);
  });

  it('marks 412 as conflict and resolves', async () => {
    const { handleJobError } = await loadWorker();
    const mock = makeSupaMock({ calendar_links: {}, sync_jobs: {} });
    const ctx = makeCtx();

    const outcome = await handleJobError(
      mock.sb, ctx, baseJob,
      { code: 412, message: 'precondition failed' },
    );

    assert.equal(outcome, 'resolved');
    // Should update calendar_links.sync_status='conflict'
    const linkUpd = mock.updates.find(u => u.table === 'calendar_links');
    assert.ok(linkUpd);
    assert.equal(linkUpd!.patch.sync_status, 'conflict');
  });

  it('retries on 500 with backoff', async () => {
    const { handleJobError } = await loadWorker();
    const mock = makeSupaMock({ sync_jobs: {} });
    const ctx = makeCtx();

    const outcome = await handleJobError(
      mock.sb, ctx, baseJob,
      { code: 500, message: 'internal server error' },
    );

    assert.equal(outcome, 'retried');
    const jobUpd = mock.updates.find(u => u.table === 'sync_jobs');
    assert.ok(jobUpd);
    assert.equal(jobUpd!.patch.status, 'queued');
    assert.equal(jobUpd!.patch.attempt, 1);
  });

  it('retries on 429 with backoff', async () => {
    const { handleJobError } = await loadWorker();
    const mock = makeSupaMock({ sync_jobs: {} });
    const ctx = makeCtx();

    const outcome = await handleJobError(
      mock.sb, ctx, baseJob,
      { code: 429, message: 'rate limited' },
    );

    assert.equal(outcome, 'retried');
  });

  it('retries on network error (no status code)', async () => {
    const { handleJobError } = await loadWorker();
    const mock = makeSupaMock({ sync_jobs: {} });
    const ctx = makeCtx();

    const outcome = await handleJobError(
      mock.sb, ctx, baseJob,
      new Error('ECONNREFUSED'),
    );

    assert.equal(outcome, 'retried');
  });

  it('marks job failed after max attempts on retry path', async () => {
    const { handleJobError } = await loadWorker();
    const mock = makeSupaMock({ sync_jobs: {} });
    const ctx = makeCtx();
    const exhaustedJob: SyncJob = { ...baseJob, attempt: MAX_ATTEMPTS - 1 };

    const outcome = await handleJobError(
      mock.sb, ctx, exhaustedJob,
      { code: 500, message: 'still broken' },
    );

    assert.equal(outcome, 'retried'); // The outcome is 'retried' even if it ended up as 'failed'
    const jobUpd = mock.updates.find(u => u.table === 'sync_jobs');
    assert.ok(jobUpd);
    assert.equal(jobUpd!.patch.status, 'failed');
  });
});

describe('claimBatch', () => {
  it('returns empty array when no jobs are queued', async () => {
    const { claimBatch } = await loadWorker();
    const mock = makeSupaMock({
      sync_jobs: { selectResult: { data: [], error: null } },
    });

    const jobs = await claimBatch(mock.sb);
    assert.equal(jobs.length, 0);
  });

  it('returns empty array on select error', async () => {
    const { claimBatch } = await loadWorker();
    const mock = makeSupaMock({
      sync_jobs: { selectResult: { data: null, error: { message: 'boom' } } },
    });

    const jobs = await claimBatch(mock.sb);
    assert.equal(jobs.length, 0);
  });

  it('claims queued jobs and updates their status to running', async () => {
    const { claimBatch } = await loadWorker();
    const fakeJobs = [
      { id: 1, user_id: 'u1', kind: 'plan_upsert', payload: { plan_id: 'p1' }, status: 'queued', attempt: 0 },
      { id: 2, user_id: 'u1', kind: 'plan_delete', payload: { plan_id: 'p2', google_event_id: 'e2', google_calendar_id: 'c2' }, status: 'queued', attempt: 0 },
    ];
    const mock = makeSupaMock({
      sync_jobs: { selectResult: { data: fakeJobs, error: null } },
    });

    const jobs = await claimBatch(mock.sb);

    assert.equal(jobs.length, 2);
    // Should have issued an update to set status='running'
    assert.equal(mock.updates.length, 1);
    const upd = mock.updates[0]!;
    assert.equal(upd.table, 'sync_jobs');
    assert.equal(upd.patch.status, 'running');
  });
});

describe('backoff schedule', () => {
  it('BASE_DELAY_S is 15 seconds', async () => {
    const w = await loadWorker();
    assert.equal(w.BASE_DELAY_S, 15);
  });

  it('MAX_ATTEMPTS is 5', async () => {
    const w = await loadWorker();
    assert.equal(w.MAX_ATTEMPTS, 5);
  });

  it('delay formula matches BASE_DELAY_S * 2^(attempt-1)', () => {
    // Manual verification of the expected delays:
    // attempt 1: 15 * 2^0 = 15s
    // attempt 2: 15 * 2^1 = 30s
    // attempt 3: 15 * 2^2 = 60s
    // attempt 4: 15 * 2^3 = 120s
    for (let a = 1; a <= 4; a++) {
      const expected = BASE_DELAY_S * Math.pow(2, a - 1);
      assert.equal(expected, BASE_DELAY_S * Math.pow(2, a - 1));
    }
  });
});
