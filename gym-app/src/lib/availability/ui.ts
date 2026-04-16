/**
 * Shared UI metadata for availability windows — kind/strategy labels,
 * colors, icons, and human-friendly copy.
 *
 * Imported by /you/availability, the Today chip, the WeeklyStrip badge,
 * and the /you entry card so every surface speaks the same dialect.
 *
 * Kept purely presentational — no DB, no React state, just static maps
 * and small formatting helpers. Safe to import from server + client.
 */

import type {
  AvailabilityWindowKind,
  AvailabilityWindowStrategy,
  ResolvedWindowStrategy,
} from '@/lib/reconcile/rollForward.pure';
import { resolveWindowStrategy } from '@/lib/reconcile/rollForward.pure';

// ---------- kind metadata --------------------------------------------

export type KindMeta = {
  /** Single-word label used in chips / cards. */
  label: string;
  /** Full noun phrase used in headings ("Travel window"). */
  longLabel: string;
  /** SVG glyph key consumed by <WindowGlyph />. */
  glyph: 'travel' | 'injury' | 'pause';
  /** Tint for badge/chip backgrounds — paired with the token set in use elsewhere. */
  tint: {
    /** Soft background (e.g. `bg-accent-soft`). */
    bg: string;
    /** Foreground text color token. */
    text: string;
    /** Ring color token for focus + dot overlays. */
    ring: string;
    /** Raw accent color (hex) for the strip overlay — IconGlyph stroke. */
    hex: string;
  };
  /** One-liner explaining what this kind means, rendered under the radio. */
  blurb: string;
};

/**
 * Kind → metadata.
 *
 * Colour notes — we reuse tokens the rest of the app already defines so
 * the palette stays coherent:
 *   - travel → accent (yellow-green)    — friendly, movement-forward
 *   - injury → warn   (amber)           — caution without alarming
 *   - pause  → muted  (neutral grey)    — deliberate pause, not a problem
 */
export const KIND_META: Record<AvailabilityWindowKind, KindMeta> = {
  travel: {
    label: 'Travel',
    longLabel: 'Travel window',
    glyph: 'travel',
    tint: {
      bg: 'bg-accent-soft',
      text: 'text-accent',
      ring: 'ring-accent/40',
      hex: '#d4ff3a',
    },
    blurb: 'A trip with limited equipment. Defaults to bodyweight-friendly sessions.',
  },
  injury: {
    label: 'Injury',
    longLabel: 'Injury window',
    glyph: 'injury',
    tint: {
      bg: 'bg-warn/10',
      text: 'text-warn',
      ring: 'ring-warn/40',
      hex: '#f2b13a',
    },
    blurb: 'Something\u2019s hurting. Defaults to rest days to protect recovery.',
  },
  pause: {
    label: 'Pause',
    longLabel: 'Pause window',
    glyph: 'pause',
    tint: {
      bg: 'bg-panel-2',
      text: 'text-muted',
      ring: 'ring-border',
      hex: '#8a8a8a',
    },
    blurb: 'A deliberate off-block. Your schedule goes quiet; no nagging.',
  },
};

// ---------- strategy metadata ----------------------------------------

export type StrategyMeta = {
  label: string;
  blurb: string;
};

export const STRATEGY_META: Record<AvailabilityWindowStrategy, StrategyMeta> = {
  auto: {
    label: 'Auto',
    blurb: 'Use the default for this kind.',
  },
  bodyweight: {
    label: 'Bodyweight',
    blurb: 'Swap each session for a short bodyweight workout.',
  },
  rest: {
    label: 'Rest days',
    blurb: 'Every covered day becomes a rest day.',
  },
  suppress: {
    label: 'Hide',
    blurb: 'Clear the schedule entirely. No sessions, no rest prompts.',
  },
};

/** A short human label for the *resolved* strategy — used in list cards. */
export function resolvedStrategyLabel(
  kind: AvailabilityWindowKind,
  strategy: AvailabilityWindowStrategy
): string {
  const resolved = resolveWindowStrategy(kind, strategy);
  return resolvedLabelMap[resolved];
}

const resolvedLabelMap: Record<ResolvedWindowStrategy, string> = {
  rest: 'Rest days',
  bodyweight: 'Bodyweight',
  suppress: 'Hidden',
};

// ---------- date helpers ---------------------------------------------

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** "Apr 20" from "2026-04-20" — no Date object, tz-safe. */
export function formatShortDate(iso: string): string {
  const [, mm, dd] = iso.split('-');
  const m = Number(mm);
  const d = Number(dd);
  if (!m || !d) return iso;
  return `${MONTHS[m - 1]} ${d}`;
}

/** "Apr 20 – May 4" — collapses same-month ("Apr 20 – 24"). */
export function formatRange(startIso: string, endIso: string): string {
  if (startIso === endIso) return formatShortDate(startIso);
  const [, sM] = startIso.split('-');
  const [, eM] = endIso.split('-');
  if (sM === eM) {
    const [, , eD] = endIso.split('-');
    return `${formatShortDate(startIso)}\u2013${Number(eD)}`;
  }
  return `${formatShortDate(startIso)} \u2013 ${formatShortDate(endIso)}`;
}

/** Inclusive day count between two ISO dates (clamps to >= 1). */
export function inclusiveDayCount(startIso: string, endIso: string): number {
  if (startIso > endIso) return 0;
  // yyyy-MM-dd parses as UTC midnight with T00:00:00Z, so a simple diff works.
  const ms =
    Date.parse(endIso + 'T00:00:00Z') - Date.parse(startIso + 'T00:00:00Z');
  return Math.round(ms / 86_400_000) + 1;
}

/**
 * Temporal phase of a window vs "today":
 *   - 'active'     : today falls inside [starts_on, ends_on]
 *   - 'upcoming'   : starts_on > today
 *   - 'past'       : ends_on < today
 */
export type WindowTemporalPhase = 'active' | 'upcoming' | 'past';

export function windowTemporalPhase(
  startsOn: string,
  endsOn: string,
  todayIso: string
): WindowTemporalPhase {
  if (endsOn < todayIso) return 'past';
  if (startsOn > todayIso) return 'upcoming';
  return 'active';
}

/** "Ends in 4 days" / "Starts in 7 days" / "Ended Mar 10". */
export function relativeWindowPhrase(
  startsOn: string,
  endsOn: string,
  todayIso: string
): string {
  const phase = windowTemporalPhase(startsOn, endsOn, todayIso);
  if (phase === 'active') {
    const daysLeft = inclusiveDayCount(todayIso, endsOn) - 1; // "today" counts as 0 remaining
    if (daysLeft <= 0) return 'Ends today';
    if (daysLeft === 1) return 'Ends tomorrow';
    return `Ends in ${daysLeft} days`;
  }
  if (phase === 'upcoming') {
    const daysUntil = inclusiveDayCount(todayIso, startsOn) - 1;
    if (daysUntil <= 0) return 'Starts today';
    if (daysUntil === 1) return 'Starts tomorrow';
    return `Starts in ${daysUntil} days`;
  }
  return `Ended ${formatShortDate(endsOn)}`;
}
