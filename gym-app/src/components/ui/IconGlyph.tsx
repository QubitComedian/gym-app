import { typeColor } from '@/lib/session-types';

/** Minimal custom SVG glyphs for session types. Kept inline to avoid adding deps. */

const paths: Record<string, React.ReactNode> = {
  gym: (
    // Dumbbell
    <g strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="9" width="3" height="6" rx="1" />
      <rect x="5" y="7" width="2" height="10" rx="0.5" />
      <rect x="17" y="7" width="2" height="10" rx="0.5" />
      <rect x="19" y="9" width="3" height="6" rx="1" />
      <line x1="7" y1="12" x2="17" y2="12" />
    </g>
  ),
  run: (
    <g strokeLinecap="round" strokeLinejoin="round" fill="none">
      <circle cx="17" cy="4.5" r="1.8" />
      <path d="M7 21l3-6 3 2 3-5-2-3-4 1-3 3" />
      <path d="M5 11l3-1" />
    </g>
  ),
  bike: (
    <g strokeLinecap="round" strokeLinejoin="round" fill="none">
      <circle cx="6" cy="17" r="4" />
      <circle cx="18" cy="17" r="4" />
      <path d="M6 17l4-8h5l3 8" />
      <path d="M10 9h3" />
      <circle cx="15" cy="4" r="1" />
      <path d="M14 5l1 4" />
    </g>
  ),
  swim: (
    <g strokeLinecap="round" strokeLinejoin="round" fill="none">
      <path d="M2 16c2 0 2-1 4-1s2 1 4 1 2-1 4-1 2 1 4 1 2-1 4-1" />
      <path d="M2 20c2 0 2-1 4-1s2 1 4 1 2-1 4-1 2 1 4 1 2-1 4-1" />
      <circle cx="15" cy="6" r="1.5" />
      <path d="M7 14l4-3 4 1 3-4" />
    </g>
  ),
  yoga: (
    <g strokeLinecap="round" strokeLinejoin="round" fill="none">
      <circle cx="12" cy="5" r="2" />
      <path d="M12 8v5" />
      <path d="M6 14c2 2 4 3 6 3s4-1 6-3" />
      <path d="M8 20h8" />
    </g>
  ),
  climb: (
    <g strokeLinecap="round" strokeLinejoin="round" fill="none">
      <circle cx="14" cy="5" r="1.8" />
      <path d="M14 7l-2 4 3 2-1 4 3 2" />
      <path d="M12 11l-4-1-3 3" />
    </g>
  ),
  sauna_cold: (
    <g strokeLinecap="round" strokeLinejoin="round" fill="none">
      <path d="M12 3v18M4 9l16 6M4 15l16-6" />
      <path d="M12 3l-2 2M12 3l2 2M12 21l-2-2M12 21l2-2" />
    </g>
  ),
  mobility: (
    <g strokeLinecap="round" strokeLinejoin="round" fill="none">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4l1.4-1.4M17 7l1.4-1.4" />
    </g>
  ),
  rest: (
    <g strokeLinecap="round" strokeLinejoin="round" fill="none">
      <path d="M20 14A8 8 0 0110 4a7 7 0 1010 10z" />
    </g>
  ),
  other: (
    <g strokeLinecap="round" strokeLinejoin="round" fill="none">
      <circle cx="12" cy="12" r="4" />
    </g>
  ),
};

export default function IconGlyph({
  type,
  size = 20,
  className = '',
  strokeWidth = 1.6,
  color,
}: {
  type: string;
  size?: number;
  className?: string;
  strokeWidth?: number;
  color?: string;
}) {
  const path = paths[type] ?? paths.other;
  const c = color ?? typeColor(type);
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
      {path}
    </svg>
  );
}
