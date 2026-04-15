import Link from 'next/link';
import IconGlyph from './ui/IconGlyph';
import type { WeekSummary, DayCell } from '@/lib/weekSummary';
import { phaseLabelFor } from '@/lib/weekSummary';

export default function WeeklyStrip({ summary }: { summary: WeekSummary }) {
  const sessionsLabel = summary.sessionsPlanned > 0
    ? `${summary.sessionsDone}/${summary.sessionsPlanned} sessions`
    : summary.sessionsDone > 0
      ? `${summary.sessionsDone} session${summary.sessionsDone === 1 ? '' : 's'}`
      : '0 sessions';

  return (
    <section aria-label="Week overview" className="rounded-xl bg-panel border border-border px-3 py-3 mb-4">
      <div className="flex items-center justify-between gap-2 px-1 mb-2">
        <div className="text-tiny text-muted-2 truncate min-w-0">
          {phaseLabelFor(summary)}
          <span className="text-muted"> · </span>
          {sessionsLabel}
          {summary.primary && (
            <>
              <span className="text-muted"> · </span>
              <span className="tabular-nums">{summary.primary.value}</span>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1">
        {summary.days.map(day => <Dot key={day.date} day={day} />)}
      </div>
    </section>
  );
}

function Dot({ day }: { day: DayCell }) {
  const { ring, fill, border, glyph, glyphColor, dashed, inner } = stateVisuals(day);

  return (
    <Link
      href={day.href}
      aria-label={`${day.dow} ${day.date}`}
      className="flex flex-col items-center gap-1 py-1 group"
    >
      <div className={`text-[10px] uppercase tracking-wider ${day.isToday ? 'text-accent font-medium' : 'text-muted-2'}`}>
        {day.dow}
      </div>
      <div className={`relative flex items-center justify-center w-7 h-7 rounded-full ${fill} ${border} ${dashed ? 'border-dashed' : ''} ${ring} transition-colors group-hover:border-accent/40`}>
        {glyph === 'type' && day.type && (
          <IconGlyph type={day.type} size={14} color={glyphColor} />
        )}
        {glyph === 'check' && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="text-ok">
            <polyline points="5 12 10 17 19 7" />
          </svg>
        )}
        {glyph === 'dash' && (
          <div className={`w-2.5 h-0.5 rounded-full bg-muted ${inner}`} />
        )}
        {glyph === 'x' && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="text-muted-2">
            <line x1="5" y1="5" x2="19" y2="19" />
            <line x1="19" y1="5" x2="5" y2="19" />
          </svg>
        )}
      </div>
    </Link>
  );
}

type Visuals = {
  ring: string;
  fill: string;
  border: string;
  glyph: 'type' | 'check' | 'dash' | 'x' | 'none';
  glyphColor?: string;
  dashed?: boolean;
  inner?: string;
};

function stateVisuals(day: DayCell): Visuals {
  const todayRing = day.isToday ? 'ring-2 ring-accent ring-offset-2 ring-offset-panel' : '';
  switch (day.state) {
    case 'today_planned':
      return { ring: todayRing, fill: 'bg-panel-2', border: 'border border-border', glyph: 'type', glyphColor: '#d4ff3a' };
    case 'today_done':
      return { ring: todayRing, fill: 'bg-ok/25', border: 'border border-ok/40', glyph: 'check' };
    case 'today_rest':
      return { ring: todayRing, fill: 'bg-panel-2', border: 'border border-border', glyph: 'dash' };
    case 'today_empty':
      return { ring: todayRing, fill: 'bg-panel-2', border: 'border border-border', glyph: 'none' };
    case 'past_done':
      return { ring: '', fill: 'bg-ok/25', border: 'border border-ok/40', glyph: 'type', glyphColor: '#6bd48a' };
    case 'past_skipped':
      return { ring: '', fill: 'bg-panel-2', border: 'border border-muted/40', glyph: 'x' };
    case 'past_missed':
      return { ring: '', fill: 'bg-panel', border: 'border border-muted/40', glyph: 'none', dashed: true };
    case 'past_rest':
      return { ring: '', fill: 'bg-panel-2', border: 'border border-border', glyph: 'dash' };
    case 'past_empty':
      return { ring: '', fill: 'bg-transparent', border: 'border border-border/40', glyph: 'none', dashed: true };
    case 'future_planned':
      return { ring: '', fill: 'bg-panel', border: 'border border-border', glyph: 'type', glyphColor: '#8a8a8a' };
    case 'future_rest':
      return { ring: '', fill: 'bg-panel-2', border: 'border border-border', glyph: 'dash' };
    case 'future_empty':
      return { ring: '', fill: 'bg-transparent', border: 'border border-border/40', glyph: 'none', dashed: true };
  }
}
