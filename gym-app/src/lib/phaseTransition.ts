/**
 * Presentation helpers for phase_transition proposals.
 *
 * Takes the raw `ai_proposals` row + its diff (as written by the
 * reconciler's phase-transition pass) and produces the props needed by
 * either PhaseTransitionBanner (soft tier) or PhaseTransitionHero (hard
 * tier). Keeps the UI components thin and the Today page render free of
 * proposal-shape knowledge.
 *
 * Mirrors `returnFromGap.ts` — same file-shape, same two-view split.
 * Kept separate because the option enums, summary text, and default
 * option resolution rules are different enough that conflating them
 * would hurt readability.
 */
import type {
  PhaseTransitionOption,
  PhaseTransitionOptionId,
  PhaseTransitionProposal,
  PhaseTransitionTier,
} from '@/lib/phase/transition.pure';
import type { PhaseTransitionBannerProps } from '@/components/PhaseTransitionBanner';
import type {
  PhaseTransitionHeroOption,
  PhaseTransitionHeroProps,
} from '@/components/PhaseTransitionHero';

export type RawProposal = {
  id: string;
  rationale: string | null;
  diff: unknown;
};

export type PhaseTransitionView =
  | { view: 'hero'; props: PhaseTransitionHeroProps }
  | { view: 'banner'; props: PhaseTransitionBannerProps }
  | null;

/**
 * Try to split a rationale into (headline, subhead). The engine writes
 * a single-line header that reads well as a headline by itself; if the
 * header ever grows multi-line (future copy polish), the first line
 * becomes the headline and the remainder the subhead.
 */
function splitRationale(raw: string | null | undefined): { headline: string; subhead: string | null } {
  if (!raw) return { headline: 'Phase update', subhead: null };
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return { headline: 'Phase update', subhead: null };
  const [first, ...rest] = lines;
  return {
    headline: first.replace(/^headline:\s*/i, ''),
    subhead: rest.length > 0 ? rest.join(' ') : null,
  };
}

function asDiff(diff: unknown): PhaseTransitionProposal | null {
  if (!diff || typeof diff !== 'object') return null;
  const d = diff as Partial<PhaseTransitionProposal>;
  if (d.kind !== 'phase_transition') return null;
  if (!Array.isArray(d.options)) return null;
  return diff as PhaseTransitionProposal;
}

function toHeroOption(o: PhaseTransitionOption): PhaseTransitionHeroOption {
  return {
    id: o.id,
    label: o.label,
    description: o.description,
    recommended: !!o.recommended,
    cta_label: o.cta_label,
    is_reassess: o.action === 'reassess',
    is_end: o.action === 'end',
    summary: {
      added: o.summary.added,
      removed: o.summary.removed,
      orphans: o.summary.orphan_day_codes.length,
      skipped_logged: o.summary.skipped_logged,
      skipped_manual: o.summary.skipped_manual,
      skipped_ai_proposed: o.summary.skipped_ai_proposed,
      skipped_availability_window: o.summary.skipped_availability_window,
      new_target_ends_on: o.summary.new_target_ends_on ?? null,
    },
  };
}

export function summarizePhaseTransitionProposal(prop: RawProposal): PhaseTransitionView {
  const diff = asDiff(prop.diff);
  if (!diff) return null;

  const rationale = diff.rationale ?? prop.rationale ?? null;
  const { headline, subhead } = splitRationale(rationale);

  const defaultId: PhaseTransitionOptionId =
    diff.default_option_id ?? diff.options[0]?.id ?? 'extend_2w';

  if (diff.tier === 'soft') {
    const defaultOption =
      diff.options.find(o => o.id === defaultId) ?? diff.options[0] ?? null;
    if (!defaultOption) return null;
    return {
      view: 'banner',
      props: {
        id: prop.id,
        tier: 'soft',
        default_option_id: defaultOption.id,
        headline,
        subhead,
        primary_label: defaultOption.cta_label,
        phase_code: diff.phase_code,
        phase_name: diff.phase_name,
        next_phase_code: diff.next_phase_code,
        target_ends_on: diff.target_ends_on,
        days_until: diff.days_until,
      },
    };
  }

  // hard tier → full hero
  const heroOptions = diff.options.map(toHeroOption);
  return {
    view: 'hero',
    props: {
      id: prop.id,
      tier: diff.tier,
      default_option_id: defaultId,
      headline,
      subhead,
      phase_code: diff.phase_code,
      phase_name: diff.phase_name,
      next_phase_code: diff.next_phase_code,
      next_phase_name: diff.next_phase_name,
      target_ends_on: diff.target_ends_on,
      days_until: diff.days_until,
      days_overdue: diff.days_overdue,
      options: heroOptions,
    },
  };
}

export type { PhaseTransitionTier };
