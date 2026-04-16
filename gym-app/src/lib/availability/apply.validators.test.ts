/**
 * Unit tests for the availability-window API boundary validators
 * (P1.3 / PR-R).
 *
 * Run via:
 *   npx tsx --test src/lib/availability/apply.validators.test.ts
 *
 * These pure validators are called from the POST / PATCH / preview
 * routes before any DB round-trip, so they catch malformed input
 * cheaply. The resolved-range check in applyModifyWindow (which needs
 * the existing row loaded) is NOT covered here — that's the concern
 * of the I/O wrapper, not the validator.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_WINDOW_LENGTH_DAYS,
  validateCreateInput,
  validateModifyPatch,
  type CreateWindowInput,
  type ModifyWindowPatch,
} from './apply';

function addDays(iso: string, n: number): string {
  const base = Date.parse(iso + 'T00:00:00Z');
  const shifted = new Date(base + n * 86_400_000).toISOString();
  return shifted.slice(0, 10);
}

describe('validateCreateInput', () => {
  const base: CreateWindowInput = {
    starts_on: '2026-04-20',
    ends_on: '2026-04-26',
    kind: 'travel',
  };

  it('accepts a minimal valid input', () => {
    assert.deepEqual(validateCreateInput(base), { ok: true });
  });

  it('accepts every valid kind', () => {
    for (const kind of ['travel', 'injury', 'pause'] as const) {
      assert.deepEqual(
        validateCreateInput({ ...base, kind }),
        { ok: true },
        `kind=${kind}`
      );
    }
  });

  it('accepts every valid strategy', () => {
    for (const strategy of ['auto', 'bodyweight', 'rest', 'suppress'] as const) {
      assert.deepEqual(
        validateCreateInput({ ...base, strategy }),
        { ok: true },
        `strategy=${strategy}`
      );
    }
  });

  it('rejects malformed starts_on', () => {
    const r = validateCreateInput({ ...base, starts_on: '2026/04/20' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.detail, /starts_on/);
  });

  it('rejects malformed ends_on', () => {
    const r = validateCreateInput({ ...base, ends_on: 'tomorrow' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.detail, /ends_on/);
  });

  it('rejects starts_on > ends_on', () => {
    const r = validateCreateInput({
      ...base,
      starts_on: '2026-04-26',
      ends_on: '2026-04-20',
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.detail, /starts_on must be <= ends_on/);
  });

  it('accepts same-day window (single-day injury)', () => {
    const r = validateCreateInput({
      ...base,
      starts_on: '2026-04-20',
      ends_on: '2026-04-20',
      kind: 'injury',
    });
    assert.deepEqual(r, { ok: true });
  });

  it('accepts exactly MAX_WINDOW_LENGTH_DAYS', () => {
    // starts_on .. starts_on + (MAX - 1) is inclusive MAX days.
    const starts = '2026-04-20';
    const ends = addDays(starts, MAX_WINDOW_LENGTH_DAYS - 1);
    const r = validateCreateInput({ ...base, starts_on: starts, ends_on: ends });
    assert.deepEqual(r, { ok: true });
  });

  it('rejects MAX_WINDOW_LENGTH_DAYS + 1', () => {
    const starts = '2026-04-20';
    const ends = addDays(starts, MAX_WINDOW_LENGTH_DAYS); // inclusive = MAX+1
    const r = validateCreateInput({ ...base, starts_on: starts, ends_on: ends });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.detail, /exceeds max 365/);
      assert.match(r.detail, /366 days/);
    }
  });

  it('rejects invalid kind', () => {
    const r = validateCreateInput({ ...base, kind: 'holiday' as never });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.detail, /travel\|injury\|pause/);
  });

  it('rejects invalid strategy', () => {
    const r = validateCreateInput({ ...base, strategy: 'cardio' as never });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.detail, /auto\|bodyweight\|rest\|suppress/);
  });

  it('accepts note=null and note=string', () => {
    assert.deepEqual(validateCreateInput({ ...base, note: null }), { ok: true });
    assert.deepEqual(
      validateCreateInput({ ...base, note: 'Trip to Tokyo' }),
      { ok: true }
    );
  });

  it('rejects non-string, non-null note', () => {
    const r = validateCreateInput({ ...base, note: 42 as never });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.detail, /note/);
  });
});

describe('validateModifyPatch', () => {
  it('accepts a patch with only starts_on', () => {
    const r = validateModifyPatch({ starts_on: '2026-05-01' });
    assert.deepEqual(r, { ok: true });
  });

  it('accepts a patch with only strategy', () => {
    const r = validateModifyPatch({ strategy: 'bodyweight' });
    assert.deepEqual(r, { ok: true });
  });

  it('accepts a patch with only note=null', () => {
    const r = validateModifyPatch({ note: null });
    assert.deepEqual(r, { ok: true });
  });

  it('rejects malformed starts_on in patch', () => {
    const r = validateModifyPatch({ starts_on: 'april' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.detail, /starts_on/);
  });

  it('rejects starts_on > ends_on when both are present', () => {
    const r = validateModifyPatch({
      starts_on: '2026-05-10',
      ends_on: '2026-05-01',
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.detail, /starts_on must be <= ends_on/);
  });

  it('does NOT check ordering when only one bound is present', () => {
    // The resolved-range check lives in applyModifyWindow — here we
    // only reject what we can see without loading the old window.
    const r = validateModifyPatch({ starts_on: '2030-01-01' });
    assert.deepEqual(r, { ok: true });
  });

  it('accepts exactly MAX_WINDOW_LENGTH_DAYS when both bounds present', () => {
    const starts = '2026-04-20';
    const ends = addDays(starts, MAX_WINDOW_LENGTH_DAYS - 1);
    const r = validateModifyPatch({ starts_on: starts, ends_on: ends });
    assert.deepEqual(r, { ok: true });
  });

  it('rejects MAX+1 when both bounds present', () => {
    const starts = '2026-04-20';
    const ends = addDays(starts, MAX_WINDOW_LENGTH_DAYS);
    const r = validateModifyPatch({ starts_on: starts, ends_on: ends });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.detail, /exceeds max 365/);
  });

  it('rejects invalid strategy', () => {
    const r = validateModifyPatch({ strategy: 'vacation' as never });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.detail, /auto\|bodyweight\|rest\|suppress/);
  });

  it('rejects non-string, non-null note', () => {
    const r = validateModifyPatch({ note: { text: 'x' } as never });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.detail, /note/);
  });

  it('accepts empty patch — the route layer enforces "at least one field"', () => {
    // validateModifyPatch itself doesn't enforce non-empty because the
    // call sites (route handlers + Zod refine) already catch it before
    // we reach the validator. We document the responsibility split here.
    const r = validateModifyPatch({} as ModifyWindowPatch);
    assert.deepEqual(r, { ok: true });
  });
});

describe('MAX_WINDOW_LENGTH_DAYS invariant', () => {
  it('is a positive integer', () => {
    assert.ok(Number.isInteger(MAX_WINDOW_LENGTH_DAYS));
    assert.ok(MAX_WINDOW_LENGTH_DAYS > 0);
  });

  it('is 365 (documented contract — client form caps match)', () => {
    assert.equal(MAX_WINDOW_LENGTH_DAYS, 365);
  });
});
