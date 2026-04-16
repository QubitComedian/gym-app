/**
 * ActiveWindowChip — surfaces an active availability window on /today.
 *
 * Rendered above TodayHero whenever today falls inside a travel / injury /
 * pause window. Reminds the user why the day's plan looks different
 * (bodyweight, rest, or hidden) and gives them a one-tap path to the
 * detailed view.
 *
 * Design goals:
 *   - Calm, compact, never shouts. A small tinted bar — not a modal.
 *   - Mentions remaining duration ("ends tomorrow") so it feels live.
 *   - One window only. If somehow multiple windows overlap today
 *     (backend guards against this via the unique overlap constraint),
 *     the page passes the soonest-to-end one.
 *   - Tap-through goes to /you/availability where it can be adjusted.
 */

import Link from 'next/link';
import WindowGlyph from './ui/WindowGlyph';
import {
  KIND_META,
  relativeWindowPhrase,
  resolvedStrategyLabel,
} from '@/lib/availability/ui';
import type {
  AvailabilityWindowKind,
  AvailabilityWindowStrategy,
} from '@/lib/reconcile/rollForward.pure';

export type ActiveWindowChipProps = {
  kind: AvailabilityWindowKind;
  strategy: AvailabilityWindowStrategy;
  startsOn: string;
  endsOn: string;
  todayIso: string;
};

export default function ActiveWindowChip({
  kind,
  strategy,
  startsOn,
  endsOn,
  todayIso,
}: ActiveWindowChipProps) {
  const meta = KIND_META[kind];
  const remaining = relativeWindowPhrase(startsOn, endsOn, todayIso);
  const resolved = resolvedStrategyLabel(kind, strategy);

  return (
    <Link
      href="/you/availability"
      className={[
        'group mt-3 mb-4 flex items-center gap-3 rounded-2xl',
        'border border-border bg-panel-2 px-3 py-2.5',
        'transition hover:bg-panel hover:border-muted-2/50',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
      ].join(' ')}
      aria-label={`${meta.longLabel} — ${remaining}. Tap to manage.`}
    >
      <span
        className={[
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl',
          meta.tint.bg,
        ].join(' ')}
        aria-hidden
      >
        <WindowGlyph kind={kind} size={20} />
      </span>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="flex items-center gap-2">
          <span className={['text-small font-medium', meta.tint.text].join(' ')}>
            {meta.longLabel}
          </span>
          <span className="text-tiny text-muted-2">·</span>
          <span className="text-tiny text-muted">{remaining}</span>
        </div>
        <div className="text-tiny text-muted-2 truncate">
          Sessions swapped to <span className="text-muted">{resolved.toLowerCase()}</span>
        </div>
      </div>
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-muted-2 shrink-0 transition group-hover:text-muted"
        aria-hidden
      >
        <path d="M9 6l6 6-6 6" />
      </svg>
    </Link>
  );
}
