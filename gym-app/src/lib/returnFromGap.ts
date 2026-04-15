/**
 * Presentation helpers for return_from_gap proposals.
 *
 * Takes the raw `ai_proposals` row + its diff (as written by the
 * reconciler's drop-off pass) and produces the props needed by either
 * ReturnFromGapBanner (soft tier) or ReturnFromGapHero (hard /
 * hard_extended tier). Keeps the UI components thin and the Today page
 * render free of proposal-shape knowledge.
 */

import type { ReturnFromGapHeroOption, ReturnFromGapHeroProposal } from '@/components/ReturnFromGapHero';
import type { ReturnFromGapProposalSummary } from '@/components/ReturnFromGapBanner';

type RawOption = {
  id: string;
  label: string;
  description: string;
  recommended: boolean;
  action?: 'reassess';
};

type RawDiff = {
  kind?: string;
  gap_days?: number;
  tier?: 'soft' | 'hard' | 'hard_extended';
  default_option_id?: string;
  options?: RawOption[];
  rationale?: string;
};

export type RawProposal = {
  id: string;
  rationale: string | null;
  diff: unknown;
};

/**
 * Split the diff's rationale into a single-line headline + optional
 * multi-line subhead. By convention the reconciler writes a
 * "Headline: …" first line; if it's absent, fall back to the first line.
 */
function splitRationale(raw: string | null | undefined): { headline: string; subhead: string | null } {
  if (!raw) return { headline: 'Welcome back', subhead: null };
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const headlineLine = lines.find((l) => l.toLowerCase().startsWith('headline:')) ?? lines[0];
  const headline = headlineLine?.replace(/^headline:\s*/i, '') ?? 'Welcome back';
  const rest = lines.filter((l) => l !== headlineLine && !l.toLowerCase().startsWith('headline:'));
  return {
    headline,
    subhead: rest.length ? rest.join(' ') : null,
  };
}

/**
 * Per-option CTA copy. Chosen to match the mock in docs §5c (and with
 * conservative fallbacks so a future option name doesn't crash the UI).
 */
function ctaLabelFor(optionId: string): string {
  switch (optionId) {
    case 'shift_week':
      return 'Shift this week →';
    case 'reentry_soft':
      return 'Start re-entry week';
    case 'reentry_full':
      return 'Start re-entry fortnight';
    case 'jump_back_in':
      return 'Jump back in';
    case 'reassess':
      return 'Reassess with Claude';
    default:
      return 'Continue';
  }
}

function asDiff(diff: unknown): RawDiff {
  if (diff && typeof diff === 'object') return diff as RawDiff;
  return {};
}

/**
 * Classify a raw proposal row as the Hero tier (hard / hard_extended)
 * or the Banner tier (soft). Returns null when the row isn't
 * return_from_gap or is otherwise unusable.
 */
export type ReturnFromGapView =
  | { view: 'hero'; props: ReturnFromGapHeroProposal }
  | { view: 'banner'; props: ReturnFromGapProposalSummary }
  | null;

export function summarizeReturnFromGapProposal(prop: RawProposal): ReturnFromGapView {
  const diff = asDiff(prop.diff);
  if (diff.kind !== 'return_from_gap') return null;
  const tier = diff.tier;
  const rationale = diff.rationale ?? prop.rationale;
  const { headline, subhead } = splitRationale(rationale);
  const defaultId = diff.default_option_id ?? diff.options?.[0]?.id ?? '';

  if (tier === 'soft') {
    return {
      view: 'banner',
      props: {
        id: prop.id,
        gap_days: diff.gap_days ?? 0,
        default_option_id: defaultId,
        headline,
        subhead,
        primary_label: ctaLabelFor(defaultId),
      },
    };
  }

  if (tier === 'hard' || tier === 'hard_extended') {
    const options: ReturnFromGapHeroOption[] = (diff.options ?? []).map((o) => ({
      id: o.id,
      label: o.label,
      description: o.description,
      recommended: !!o.recommended,
      cta_label: ctaLabelFor(o.id),
      is_reassess: o.action === 'reassess',
    }));
    return {
      view: 'hero',
      props: {
        id: prop.id,
        gap_days: diff.gap_days ?? 0,
        tier,
        default_option_id: defaultId,
        headline,
        subhead,
        options,
      },
    };
  }

  return null;
}
