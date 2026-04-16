/**
 * WeightTracker — body weight input + sparkline history.
 *
 * Behavior:
 *   - Mounts and fetches /api/weights?days=180 on first paint
 *   - Today's value (if any) is prefilled as placeholder
 *   - Sparkline uses inline SVG — no dep on recharts so it stays cheap
 *   - A second light-colored line traces the 7-day rolling average
 *   - Shows trend chip: weekly delta (kg) colored against the user's
 *     active phase intent (cut → down is good, bulk → up is good). We
 *     accept `phaseIntent` as an optional prop; when unknown we show
 *     neutral.
 *
 * Edge cases:
 *   - Empty history → "Log your first weight" empty state
 *   - Single data point → dot-only chart (no line) with "Log a few more
 *     to see a trend" hint
 *   - Bad input (> 400 or < 20) → inline error, button disabled
 *   - Offline / API failure → error banner with retry
 */

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { format, parseISO, subDays } from 'date-fns';
import { DictationButton } from '@/components/ui/Dictation';

type Row = {
  id: string;
  measured_on: string;
  weight_kg: number;
  note: string | null;
  source: string;
};

type Props = {
  phaseIntent?: 'cut' | 'bulk' | 'maintain' | null;
};

export default function WeightTracker({ phaseIntent = null }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [avg7, setAvg7] = useState<(number | null)[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [inputVal, setInputVal] = useState('');
  const [inputNote, setInputNote] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const todayIso = format(new Date(), 'yyyy-MM-dd');

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/weights?days=180', { cache: 'no-store' });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Failed to load');
      setRows(j.rows ?? []);
      setAvg7(j.avg7 ?? []);
    } catch (e: any) {
      setError(e?.message ?? 'Failed');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  const todayRow = rows.find((r) => r.measured_on === todayIso);
  const latestRow = rows[rows.length - 1] ?? null;

  async function save() {
    const parsed = parseFloat(inputVal.replace(',', '.'));
    if (!isFinite(parsed) || parsed < 20 || parsed > 400) {
      setError('Enter a realistic weight (20–400 kg).');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/weights', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          measured_on: todayIso,
          weight_kg: parsed,
          note: inputNote.trim() || null,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error?.fieldErrors?.weight_kg?.[0] || j?.error || 'Save failed');
      setInputVal('');
      setInputNote('');
      await load();
    } catch (e: any) {
      setError(e?.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!confirm('Delete this entry?')) return;
    try {
      const res = await fetch(`/api/weights/${id}`, { method: 'DELETE' });
      if (res.ok) load();
    } catch { /* ignore */ }
  }

  const stats = useMemo(() => computeStats(rows, phaseIntent), [rows, phaseIntent]);
  const chart = useMemo(() => buildSparkline(rows, avg7), [rows, avg7]);

  return (
    <section className="card-raised">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="section-eyebrow">Body weight</div>
          <div className="flex items-baseline gap-2 mt-1 flex-wrap">
            <div className="text-lg font-semibold">
              {latestRow ? `${latestRow.weight_kg} kg` : 'Log your first weight'}
            </div>
            {latestRow && (
              <div className="text-tiny text-muted">
                last {format(parseISO(latestRow.measured_on), 'MMM d')}
              </div>
            )}
          </div>
        </div>
        <TrendChip stats={stats} />
      </div>

      {/* Chart */}
      <div className="rounded-2xl bg-panel-3 border border-panel-2 p-3 mb-3">
        {loading ? (
          <div className="h-24 flex items-center justify-center text-tiny text-muted">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="h-24 flex items-center justify-center text-tiny text-muted">
            No data yet — your trend shows up after your first entry.
          </div>
        ) : rows.length === 1 ? (
          <div className="h-24 flex flex-col items-center justify-center text-tiny text-muted gap-1">
            <div className="text-small text-ink">{rows[0].weight_kg} kg</div>
            <div>Log a few more days to see the trend.</div>
          </div>
        ) : (
          <Sparkline {...chart} />
        )}
      </div>

      {/* Input row */}
      <div className="space-y-2">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              ref={inputRef}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder={todayRow ? `Today: ${todayRow.weight_kg} kg` : 'Today in kg (e.g. 72.4)'}
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
              className="input pr-10"
            />
            <div className="absolute inset-y-0 right-2 flex items-center text-tiny text-muted pointer-events-none">kg</div>
          </div>
          <button
            type="button"
            onClick={save}
            disabled={saving || !inputVal.trim()}
            className="btn btn-primary text-small disabled:opacity-50"
          >
            {saving ? 'Saving…' : todayRow ? 'Update' : 'Log'}
          </button>
        </div>
        <div className="relative">
          <input
            type="text"
            placeholder="Optional note (morning, post-sauna, fasted…)"
            value={inputNote}
            onChange={(e) => setInputNote(e.target.value)}
            className="input text-small pr-10"
          />
          <div className="absolute inset-y-0 right-1 flex items-center">
            <DictationButton
              size="sm"
              compact
              onTranscript={(t: string) => setInputNote((prev) => (prev ? prev + ' ' + t : t))}
            />
          </div>
        </div>
        {error && (
          <div className="text-tiny text-coral">{error}</div>
        )}
      </div>

      {/* Recent entries */}
      {rows.length > 0 && (
        <details className="mt-4">
          <summary className="text-tiny text-muted cursor-pointer select-none">Recent entries ({rows.length})</summary>
          <ul className="mt-2 divide-y divide-panel-2">
            {[...rows].reverse().slice(0, 12).map((r) => (
              <li key={r.id} className="py-2 flex items-center gap-3 text-small">
                <div className="w-20 text-tiny text-muted">{format(parseISO(r.measured_on), 'MMM d')}</div>
                <div className="flex-1">{r.weight_kg} kg {r.note && <span className="text-tiny text-muted">· {r.note}</span>}</div>
                <button onClick={() => remove(r.id)} className="text-tiny text-muted hover:text-coral">✕</button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/* ──────────── Stats ──────────── */

function computeStats(rows: Row[], intent: Props['phaseIntent']) {
  if (rows.length < 2) return { delta7: null as number | null, delta30: null as number | null, tone: 'neutral' as 'good' | 'bad' | 'neutral' };

  const last = rows[rows.length - 1];
  const cutoff7 = format(subDays(parseISO(last.measured_on), 7), 'yyyy-MM-dd');
  const cutoff30 = format(subDays(parseISO(last.measured_on), 30), 'yyyy-MM-dd');
  const seven = closestAtOrBefore(rows, cutoff7);
  const thirty = closestAtOrBefore(rows, cutoff30);

  const delta7 = seven ? +(last.weight_kg - seven.weight_kg).toFixed(2) : null;
  const delta30 = thirty ? +(last.weight_kg - thirty.weight_kg).toFixed(2) : null;

  let tone: 'good' | 'bad' | 'neutral' = 'neutral';
  if (delta7 != null && intent) {
    if (intent === 'cut')  tone = delta7 < -0.1 ? 'good' : delta7 > 0.4 ? 'bad' : 'neutral';
    if (intent === 'bulk') tone = delta7 > 0.1  ? 'good' : delta7 < -0.4 ? 'bad' : 'neutral';
    if (intent === 'maintain') tone = Math.abs(delta7) < 0.5 ? 'good' : 'bad';
  }
  return { delta7, delta30, tone };
}

function closestAtOrBefore(rows: Row[], iso: string): Row | null {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].measured_on <= iso) return rows[i];
  return null;
}

function TrendChip({ stats }: { stats: { delta7: number | null; tone: 'good' | 'bad' | 'neutral' } }) {
  if (stats.delta7 == null) return null;
  const sign = stats.delta7 > 0 ? '+' : '';
  const cls =
    stats.tone === 'good' ? 'bg-accent-soft text-accent border-accent/30' :
    stats.tone === 'bad'  ? 'bg-coral-soft text-coral border-coral/30' :
                            'bg-panel-2 text-muted border-border';
  return (
    <div className={`shrink-0 rounded-full px-2.5 py-1 text-tiny border ${cls}`}>
      7d {sign}{stats.delta7} kg
    </div>
  );
}

/* ──────────── Sparkline ──────────── */

function buildSparkline(rows: Row[], avg7: (number | null)[]) {
  const values = rows.map((r) => Number(r.weight_kg));
  const labels = rows.map((r) => r.measured_on);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { values, avg7, labels, min, max };
}

function Sparkline({ values, avg7, labels, min, max }: ReturnType<typeof buildSparkline>) {
  const W = 320, H = 96;
  const pad = 6;
  const range = Math.max(0.5, max - min);

  const toXY = (arr: (number | null)[]) => arr.map((v, i) => {
    if (v == null) return null;
    const x = pad + (i / Math.max(1, arr.length - 1)) * (W - pad * 2);
    const y = H - pad - ((v - min) / range) * (H - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const mainPath = 'M' + toXY(values).filter(Boolean).join(' L');
  const avgPath = 'M' + toXY(avg7).filter(Boolean).join(' L');
  const last = values[values.length - 1];
  const lastXY = toXY(values)[values.length - 1];
  const [lx, ly] = lastXY ? lastXY.split(',').map(Number) : [0, 0];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-24">
      <defs>
        <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.25" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={mainPath + ` L${W - pad},${H - pad} L${pad},${H - pad} Z`} fill="url(#sparkFill)" className="text-accent" />
      <path d={avgPath} fill="none" stroke="currentColor" strokeWidth={1.2} className="text-iris opacity-70" strokeDasharray="3 3" />
      <path d={mainPath} fill="none" stroke="currentColor" strokeWidth={2} className="text-accent" />
      <circle cx={lx} cy={ly} r={3.5} className="fill-accent" />
      <text x={W - pad} y={12} textAnchor="end" className="fill-muted" fontSize="9">{last} kg</text>
      <text x={pad} y={12} className="fill-muted" fontSize="9">{labels[0]?.slice(5)}</text>
    </svg>
  );
}
