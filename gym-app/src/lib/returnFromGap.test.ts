/**
 * Unit tests for the return_from_gap presentation helper.
 *
 * Covers tier classification (soft → banner, hard/hard_extended → hero),
 * rationale splitting (Headline: line vs fallback), and CTA copy per
 * option id. Keeps the Today page's proposal-shape knowledge out of the
 * server component.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { summarizeReturnFromGapProposal } from './returnFromGap';

function makeProp(diff: unknown, rationale: string | null = null) {
  return { id: 'prop-1', rationale, diff };
}

describe('summarizeReturnFromGapProposal', () => {
  it('returns null when diff kind is not return_from_gap', () => {
    assert.equal(summarizeReturnFromGapProposal(makeProp({ kind: 'adjust' })), null);
    assert.equal(summarizeReturnFromGapProposal(makeProp({})), null);
    assert.equal(summarizeReturnFromGapProposal(makeProp(null)), null);
  });

  it('returns a banner view for soft tier', () => {
    const got = summarizeReturnFromGapProposal(
      makeProp({
        kind: 'return_from_gap',
        tier: 'soft',
        gap_days: 4,
        default_option_id: 'shift_week',
        options: [
          { id: 'shift_week', label: 'Shift this week', description: '…', recommended: true },
          { id: 'jump_back_in', label: 'Jump back in', description: '…', recommended: false },
        ],
        rationale: 'Headline: Welcome back — 4 days since your last session.\nWant me to shift this week so it starts today?',
      })
    );
    assert.ok(got);
    assert.equal(got!.view, 'banner');
    if (got!.view !== 'banner') throw new Error('unreachable');
    assert.equal(got!.props.id, 'prop-1');
    assert.equal(got!.props.gap_days, 4);
    assert.equal(got!.props.default_option_id, 'shift_week');
    assert.match(got!.props.headline, /Welcome back/);
    assert.ok(got!.props.subhead);
    assert.equal(got!.props.primary_label, 'Shift this week →');
  });

  it('returns a hero view for hard tier with three options', () => {
    const got = summarizeReturnFromGapProposal(
      makeProp({
        kind: 'return_from_gap',
        tier: 'hard',
        gap_days: 10,
        default_option_id: 'reentry_soft',
        options: [
          { id: 'reentry_soft', label: 'Re-entry week', description: '…', recommended: true },
          { id: 'jump_back_in', label: 'Jump back in', description: '…', recommended: false },
          { id: 'reassess', label: 'Reassess', description: '…', recommended: false, action: 'reassess' },
        ],
        rationale: 'Headline: Welcome back — 10 days since your last session.',
      })
    );
    assert.ok(got);
    assert.equal(got!.view, 'hero');
    if (got!.view !== 'hero') throw new Error('unreachable');
    assert.equal(got!.props.tier, 'hard');
    assert.equal(got!.props.options.length, 3);
    const reentry = got!.props.options.find((o) => o.id === 'reentry_soft')!;
    assert.equal(reentry.cta_label, 'Start re-entry week');
    assert.equal(reentry.recommended, true);
    assert.equal(reentry.is_reassess, false);
    const reassess = got!.props.options.find((o) => o.id === 'reassess')!;
    assert.equal(reassess.is_reassess, true);
  });

  it('returns a hero view for hard_extended tier with reentry_full option', () => {
    const got = summarizeReturnFromGapProposal(
      makeProp({
        kind: 'return_from_gap',
        tier: 'hard_extended',
        gap_days: 30,
        default_option_id: 'reassess',
        options: [
          { id: 'reentry_full', label: 'Re-entry fortnight', description: '…', recommended: false },
          { id: 'jump_back_in', label: 'Jump back in', description: '…', recommended: false },
          { id: 'reassess', label: 'Reassess', description: '…', recommended: true, action: 'reassess' },
        ],
        rationale: 'Headline: Welcome back — 30 days.',
      })
    );
    assert.ok(got);
    assert.equal(got!.view, 'hero');
    if (got!.view !== 'hero') throw new Error('unreachable');
    assert.equal(got!.props.tier, 'hard_extended');
    assert.equal(got!.props.default_option_id, 'reassess');
    const reentry = got!.props.options.find((o) => o.id === 'reentry_full')!;
    assert.equal(reentry.cta_label, 'Start re-entry fortnight');
  });

  it('uses top-level rationale when diff.rationale is missing', () => {
    const got = summarizeReturnFromGapProposal(
      makeProp(
        {
          kind: 'return_from_gap',
          tier: 'soft',
          gap_days: 3,
          default_option_id: 'shift_week',
          options: [{ id: 'shift_week', label: 'x', description: 'y', recommended: true }],
        },
        'Just a plain first line without any header'
      )
    );
    assert.ok(got);
    if (got!.view !== 'banner') throw new Error('unreachable');
    assert.equal(got!.props.headline, 'Just a plain first line without any header');
    assert.equal(got!.props.subhead, null);
  });

  it('strips the "Headline:" prefix case-insensitively', () => {
    const got = summarizeReturnFromGapProposal(
      makeProp({
        kind: 'return_from_gap',
        tier: 'soft',
        gap_days: 5,
        default_option_id: 'shift_week',
        options: [{ id: 'shift_week', label: 'x', description: 'y', recommended: true }],
        rationale: 'HEADLINE:  Upper case variant',
      })
    );
    if (got?.view !== 'banner') throw new Error('expected banner');
    assert.equal(got.props.headline, 'Upper case variant');
  });

  it('falls back to a safe default headline when rationale is empty', () => {
    const got = summarizeReturnFromGapProposal(
      makeProp({
        kind: 'return_from_gap',
        tier: 'soft',
        gap_days: 4,
        default_option_id: 'shift_week',
        options: [{ id: 'shift_week', label: 'x', description: 'y', recommended: true }],
      })
    );
    if (got?.view !== 'banner') throw new Error('expected banner');
    assert.equal(got.props.headline, 'Welcome back');
  });

  it('returns null for unrecognized tier', () => {
    const got = summarizeReturnFromGapProposal(
      makeProp({
        kind: 'return_from_gap',
        tier: 'unknown' as unknown as 'soft',
        gap_days: 4,
        default_option_id: 'shift_week',
        options: [],
      })
    );
    assert.equal(got, null);
  });

  it('primary_label falls back to "Continue" for unknown default option id', () => {
    const got = summarizeReturnFromGapProposal(
      makeProp({
        kind: 'return_from_gap',
        tier: 'soft',
        gap_days: 4,
        default_option_id: 'brand_new_option',
        options: [
          { id: 'brand_new_option', label: 'Mystery', description: '…', recommended: true },
        ],
      })
    );
    if (got?.view !== 'banner') throw new Error('expected banner');
    assert.equal(got.props.primary_label, 'Continue');
  });
});
