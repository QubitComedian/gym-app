'use client';

/**
 * Banner for conflict + meeting_conflict proposals (P1.5 / PR-Z).
 *
 * Renders in the Today page pending-proposal slot. Links through to
 * the /ai/[id] detail page where the user picks an option.
 *
 * Unlike rfg/pt banners which have a one-tap default, conflict proposals
 * always link to the detail view — the user needs to see the diff and
 * choose consciously. The banner is just a heads-up.
 */

import Link from 'next/link';
import IconGlyph from './ui/IconGlyph';
import { TYPE_LABEL } from '@/lib/session-types';

export type ConflictBannerProps = {
  id: string;
  kind: 'conflict' | 'meeting_conflict';
  headline: string;
  subhead: string | null;
  plan_date: string;
  plan_type: string;
  plan_day_code: string | null;
  conflict_kind: string | null; // 'time_moved' | 'content_edited' | 'deleted_remotely' | null
};

function conflictIcon(kind: 'conflict' | 'meeting_conflict', conflictKind: string | null): string {
  if (kind === 'meeting_conflict') return '📅';
  if (conflictKind === 'deleted_remotely') return '🗑';
  if (conflictKind === 'time_moved') return '⏰';
  return '🔄';
}

function tagLabel(kind: 'conflict' | 'meeting_conflict'): string {
  return kind === 'meeting_conflict' ? 'Meeting conflict' : 'Calendar conflict';
}

export default function ConflictBanner({
  proposals,
}: {
  proposals: ConflictBannerProps[];
}) {
  if (!proposals.length) return null;

  // Show the first conflict; stack count if multiple.
  const top = proposals[0];
  const extra = proposals.length - 1;

  return (
    <Link
      href={`/ai/${top.id}`}
      className="flex items-start gap-3 rounded-xl bg-panel-2 border border-warn/30 px-4 py-3.5 mb-5 animate-fade-in"
    >
      <span className="text-lg leading-none mt-0.5 shrink-0" aria-hidden>
        {conflictIcon(top.kind, top.conflict_kind)}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-tiny text-warn uppercase tracking-wider">
            {tagLabel(top.kind)}
          </span>
          <span className="text-tiny text-muted">· {formatShort(top.plan_date)}</span>
          <span className="ml-auto flex items-center gap-1">
            <IconGlyph type={top.plan_type} size={14} />
            <span className="text-tiny text-muted">
              {TYPE_LABEL[top.plan_type] ?? top.plan_type}
              {top.plan_day_code ? ` · ${top.plan_day_code}` : ''}
            </span>
          </span>
        </div>
        <div className="text-small font-medium truncate">{top.headline}</div>
        {extra > 0 && (
          <div className="text-tiny text-muted mt-1">
            + {extra} more conflict{extra > 1 ? 's' : ''}
          </div>
        )}
      </div>
      <span className="text-warn text-lg shrink-0 mt-0.5">›</span>
    </Link>
  );
}

function formatShort(iso: string): string {
  const [, m, d] = iso.split('-');
  if (!m || !d) return iso;
  return `${Number(m)}/${Number(d)}`;
}
