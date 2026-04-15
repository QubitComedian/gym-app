type Status = 'planned' | 'done' | 'skipped' | 'missed' | 'moved' | 'unplanned';

const cls: Record<Status, string> = {
  planned:   'border border-muted bg-transparent',
  done:      'bg-ok border border-ok',
  skipped:   'bg-muted/40 border border-muted/40',
  missed:    'bg-danger border border-danger',
  moved:     'bg-warn border border-warn',
  unplanned: 'bg-accent border border-accent',
};

export default function StatusDot({ status, size = 8 }: { status: Status | string; size?: number }) {
  const s = (cls as any)[status] ?? cls.planned;
  return <span className={`inline-block rounded-full ${s}`} style={{ width: size, height: size }} />;
}
