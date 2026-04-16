/**
 * Minimal custom SVG glyphs for availability-window kinds.
 *
 * Kept in a separate file (not folded into IconGlyph) because:
 *   - availability windows have a smaller, more opinionated vocabulary
 *   - IconGlyph is keyed by session *type*; mixing window kinds in there
 *     would make its key space ambiguous (travel isn't a session type)
 *
 * Sizes: 14 for the WeeklyStrip dot overlay, 18 for inline list chips,
 * 24 for the Today chip / form header. Matches IconGlyph's scale.
 */

import type { AvailabilityWindowKind } from '@/lib/reconcile/rollForward.pure';
import { KIND_META } from '@/lib/availability/ui';

const paths: Record<AvailabilityWindowKind, React.ReactNode> = {
  travel: (
    // Suitcase
    <g strokeLinecap="round" strokeLinejoin="round" fill="none">
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M9 8V6a1 1 0 011-1h4a1 1 0 011 1v2" />
      <line x1="4" y1="13" x2="20" y2="13" />
    </g>
  ),
  injury: (
    // Bandage / plus-in-cross
    <g strokeLinecap="round" strokeLinejoin="round" fill="none">
      <rect
        x="3"
        y="9"
        width="18"
        height="6"
        rx="2"
        transform="rotate(-30 12 12)"
      />
      <circle cx="12" cy="12" r="0.8" fill="currentColor" />
      <circle cx="10" cy="10" r="0.6" fill="currentColor" />
      <circle cx="14" cy="14" r="0.6" fill="currentColor" />
      <circle cx="14" cy="10" r="0.6" fill="currentColor" />
      <circle cx="10" cy="14" r="0.6" fill="currentColor" />
    </g>
  ),
  pause: (
    // Pause bars
    <g strokeLinecap="round" strokeLinejoin="round" fill="none">
      <rect x="7" y="6" width="3.5" height="12" rx="1" />
      <rect x="13.5" y="6" width="3.5" height="12" rx="1" />
    </g>
  ),
};

export default function WindowGlyph({
  kind,
  size = 18,
  className = '',
  strokeWidth = 1.6,
  color,
}: {
  kind: AvailabilityWindowKind;
  size?: number;
  className?: string;
  strokeWidth?: number;
  color?: string;
}) {
  const c = color ?? KIND_META[kind].tint.hex;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={c}
      strokeWidth={strokeWidth}
      className={className}
      aria-hidden
    >
      {paths[kind]}
    </svg>
  );
}
