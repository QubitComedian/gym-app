'use client';
import BottomSheet from './ui/BottomSheet';
import AdjustSheet from './AdjustSheet';
import type { WhyExplainer } from '@/lib/whyThisSession';
import { formatDaysAgo } from '@/lib/whyThisSession';

export default function WhySheet({
  open,
  onClose,
  why,
  planId,
  date,
}: {
  open: boolean;
  onClose: () => void;
  why: WhyExplainer;
  planId: string;
  date: string;
}) {
  return (
    <BottomSheet open={open} onClose={onClose} title={why.title}>
      {why.empty ? (
        <p className="text-small text-muted-2">
          This one's fresh — not enough history yet to explain the choice. Keep logging and Claude will start
          showing you patterns here.
        </p>
      ) : (
        <div className="space-y-5">
          {why.phase && (
            <Section label="Phase">
              <div className="text-small">
                <span className="font-medium">{why.phase.name}</span>
                <span className="text-muted-2">
                  {' · week '}
                  {why.phase.weekIndex}
                  {why.phase.weekTotal ? ` of ${why.phase.weekTotal}` : ''}
                </span>
              </div>
              {why.phase.focus && (
                <div className="text-tiny text-muted-2 mt-1">{why.phase.focus}</div>
              )}
            </Section>
          )}

          {why.pattern && (
            <Section label="Pattern">
              <div className="text-small text-muted-2">
                Your <span className="text-white">{why.pattern.weekday}</span> are usually{' '}
                <span className="text-white">{why.pattern.type}</span>
                <span className="text-muted"> ({why.pattern.hits} of the last {why.pattern.total}).</span>
              </div>
            </Section>
          )}

          {(why.recent.lastSameType || why.recent.lastRest || why.recent.lastHard) && (
            <Section label="Recent">
              <div className="space-y-1 text-small text-muted-2">
                {why.recent.lastSameType && (
                  <div>
                    Last same-type session:{' '}
                    <span className="text-white">{formatDaysAgo(why.recent.lastSameType.daysAgo)}</span>
                  </div>
                )}
                {why.recent.lastHard && (
                  <div>
                    Last hard session:{' '}
                    <span className="text-white">{formatDaysAgo(why.recent.lastHard.daysAgo)}</span>
                  </div>
                )}
                {why.recent.lastRest && (
                  <div>
                    Last rest:{' '}
                    <span className="text-white">{formatDaysAgo(why.recent.lastRest.daysAgo)}</span>
                  </div>
                )}
              </div>
            </Section>
          )}

          {why.origin && (
            <Section label="Origin">
              <div className="text-small text-muted-2">{why.origin.text}</div>
            </Section>
          )}
        </div>
      )}

      <div className="mt-6 pt-4 border-t border-border">
        <p className="text-tiny text-muted mb-2">Not quite right?</p>
        <AdjustSheet mode="adjust" planId={planId} date={date} label="Ask Claude to adjust →" />
      </div>
    </BottomSheet>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted mb-1.5">{label}</div>
      {children}
    </div>
  );
}
