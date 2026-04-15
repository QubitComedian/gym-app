/**
 * Unit tests for the reconciler freshness gate.
 *
 * Run via:
 *   npx tsx --test src/lib/reconcile/freshness.test.ts
 *
 * Uses Node's built-in test runner, no extra deps.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { checkFreshness, FRESHNESS_WINDOW_MS } from './freshness';

const NOW = new Date('2026-04-15T12:00:00.000Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);
const minutesAhead = (n: number) => new Date(NOW.getTime() + n * 60_000);

describe('checkFreshness', () => {
  describe('today_page_load cause', () => {
    it('runs when there is no prior reconcile', () => {
      const r = checkFreshness({
        cause: 'today_page_load',
        lastReconciledAt: null,
        now: NOW,
      });
      assert.deepEqual(r, { shouldRun: true });
    });

    it('skips when last reconcile was within the window', () => {
      const r = checkFreshness({
        cause: 'today_page_load',
        lastReconciledAt: minutesAgo(5),
        now: NOW,
      });
      assert.deepEqual(r, { shouldRun: false, reason: 'fresh' });
    });

    it('skips at the very edge just inside the window', () => {
      const r = checkFreshness({
        cause: 'today_page_load',
        lastReconciledAt: new Date(NOW.getTime() - (FRESHNESS_WINDOW_MS - 1)),
        now: NOW,
      });
      assert.deepEqual(r, { shouldRun: false, reason: 'fresh' });
    });

    it('runs exactly at the window boundary', () => {
      const r = checkFreshness({
        cause: 'today_page_load',
        lastReconciledAt: new Date(NOW.getTime() - FRESHNESS_WINDOW_MS),
        now: NOW,
      });
      assert.deepEqual(r, { shouldRun: true });
    });

    it('runs when last reconcile was over 30 minutes ago', () => {
      const r = checkFreshness({
        cause: 'today_page_load',
        lastReconciledAt: minutesAgo(45),
        now: NOW,
      });
      assert.deepEqual(r, { shouldRun: true });
    });

    it('runs when last reconcile is far in the future (clock skew)', () => {
      // Someone else's clock is way off; we'd rather do the work than
      // sit idle forever.
      const r = checkFreshness({
        cause: 'today_page_load',
        lastReconciledAt: minutesAhead(10),
        now: NOW,
      });
      assert.deepEqual(r, { shouldRun: true });
    });

    it('still skips for small future skew (<=60s)', () => {
      // A 30-second future timestamp is likely just NTP jitter; treat
      // it as fresh so a chatty client doesn't hammer the pipeline.
      const r = checkFreshness({
        cause: 'today_page_load',
        lastReconciledAt: new Date(NOW.getTime() + 30_000),
        now: NOW,
      });
      assert.deepEqual(r, { shouldRun: false, reason: 'fresh' });
    });

    it('honors a custom windowMs override', () => {
      const r = checkFreshness({
        cause: 'today_page_load',
        lastReconciledAt: minutesAgo(2),
        now: NOW,
        windowMs: 60_000, // 1 minute window
      });
      assert.deepEqual(r, { shouldRun: true });
    });
  });

  describe('non-page-load causes bypass the gate', () => {
    it('runs for activity_logged even if recently reconciled', () => {
      const r = checkFreshness({
        cause: 'activity_logged',
        lastReconciledAt: minutesAgo(1),
        now: NOW,
      });
      assert.deepEqual(r, { shouldRun: true });
    });

    it('runs for proposal_applied even if recently reconciled', () => {
      const r = checkFreshness({
        cause: 'proposal_applied',
        lastReconciledAt: minutesAgo(1),
        now: NOW,
      });
      assert.deepEqual(r, { shouldRun: true });
    });

    it('runs for nightly_cron unconditionally', () => {
      const r = checkFreshness({
        cause: 'nightly_cron',
        lastReconciledAt: minutesAgo(1),
        now: NOW,
      });
      assert.deepEqual(r, { shouldRun: true });
    });
  });
});
