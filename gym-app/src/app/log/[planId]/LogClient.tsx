'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import BottomSheet from '@/components/ui/BottomSheet';
import { EXERCISE_LIBRARY, getExercise, prettyName, type ExerciseEntry } from '@/lib/exercises/library';
import { differenceInCalendarDays, parseISO } from 'date-fns';
import CardioLog, { cardioDefaults, type CardioPayload, type CardioType } from './forms/CardioLog';
import YogaLog, { yogaDefaults, type YogaPayload } from './forms/YogaLog';
import ClimbLog, { climbDefaults, type ClimbPayload } from './forms/ClimbLog';
import MobilityLog, { mobilityDefaults, type MobilityPayload } from './forms/MobilityLog';
import SaunaColdLog, { saunaColdDefaults, type SaunaColdPayload } from './forms/SaunaColdLog';

/* ────────────────────────── Types ────────────────────────── */

type SetRow = { w?: string; r?: string; rir?: string; note?: string };
type LastEntry = { date: string; sets: Array<{ w?: any; r?: any; rir?: any; note?: string }> };
type Pref = { exercise_id: string; status: string | null; reason?: string | null };

type FlatEx = {
  key: string;              // stable key (uses original id; we track swaps separately)
  original_id: string;      // for "swapped_from"
  exercise_id: string;      // current (possibly swapped) id
  weight_hint?: string;
  reps_hint?: string;
  targetSets: number;
  rest_s: number;
  notes?: string;
  block_label?: string;     // e.g. "A1" for superset
};

type NonGymPayload =
  | { kind: 'cardio'; data: CardioPayload }
  | { kind: 'yoga'; data: YogaPayload }
  | { kind: 'climb'; data: ClimbPayload }
  | { kind: 'mobility'; data: MobilityPayload }
  | { kind: 'sauna_cold'; data: SaunaColdPayload }
  | { kind: 'none' };

type PersistShape = {
  v: 2;
  updatedAt: number;
  startedAt: number | null;
  sets: Record<string, SetRow[]>;
  done: Record<string, boolean[]>;
  swapped: Record<string, string>;      // key -> new exercise_id
  removed: string[];                    // keys
  sentiment: number | null;
  notes: string;
  nonGym?: NonGymPayload;
};

function planKind(type: string): NonGymPayload['kind'] {
  if (type === 'run' || type === 'bike' || type === 'swim') return 'cardio';
  if (type === 'yoga') return 'yoga';
  if (type === 'climbing' || type === 'climb') return 'climb';
  if (type === 'mobility') return 'mobility';
  if (type === 'sauna_cold' || type === 'sauna' || type === 'cold') return 'sauna_cold';
  return 'none';
}

function initialNonGym(plan: any): NonGymPayload {
  const t = plan.type as string;
  const kind = planKind(t);
  if (kind === 'cardio') return { kind: 'cardio', data: cardioDefaults(t as CardioType, plan) };
  if (kind === 'yoga') return { kind: 'yoga', data: yogaDefaults(plan) };
  if (kind === 'climb') return { kind: 'climb', data: climbDefaults(plan) };
  if (kind === 'mobility') return { kind: 'mobility', data: mobilityDefaults(plan) };
  if (kind === 'sauna_cold') return { kind: 'sauna_cold', data: saunaColdDefaults(plan) };
  return { kind: 'none' };
}

/* ────────────────────────── Helpers ────────────────────────── */

const DEFAULT_REST = 90;

function firstNum(s: any): number | null {
  if (s == null) return null;
  const m = String(s).match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function flattenExercises(prescription: any): FlatEx[] {
  const out: FlatEx[] = [];
  for (const b of prescription?.blocks ?? []) {
    if (b.kind === 'single') {
      const sets = b.set_scheme?.sets ?? (b.set_scheme?.type === 'emom' ? 1 : 3);
      const reps = b.set_scheme?.reps ?? (b.set_scheme?.total_reps ? `${b.set_scheme.total_reps} total` : '');
      out.push({
        key: `b${b.position}:${b.exercise_id}`,
        original_id: b.exercise_id,
        exercise_id: b.exercise_id,
        weight_hint: b.weight_hint,
        reps_hint: reps,
        targetSets: sets,
        rest_s: b.rest_s ?? DEFAULT_REST,
        notes: b.notes,
      });
    } else if (b.kind === 'superset') {
      for (const it of b.items ?? []) {
        out.push({
          key: `b${b.position}${it.letter ?? ''}:${it.exercise_id}`,
          original_id: it.exercise_id,
          exercise_id: it.exercise_id,
          weight_hint: it.weight_hint,
          reps_hint: it.set_scheme?.reps ?? '',
          targetSets: b.rounds ?? 3,
          rest_s: b.rest_between_s ?? DEFAULT_REST,
          notes: it.notes,
          block_label: `${String.fromCharCode(64 + (b.position ?? 0))}${it.letter ?? ''}`,
        });
      }
    }
  }
  return out;
}

function formatLastSets(sets: LastEntry['sets']): string {
  const parts = sets.slice(0, 4).map(s => {
    const w = s.w ?? '';
    const r = s.r ?? '';
    if (w && r) return `${w}×${r}`;
    if (r) return `${r}`;
    if (w) return `${w}`;
    return '–';
  });
  const rirs = sets.map(s => s.rir).filter((x): x is number => typeof x === 'number');
  const tail = rirs.length ? ` @RIR${Math.min(...rirs)}` : '';
  const trunc = sets.length > 4 ? ` +${sets.length - 4}` : '';
  return parts.join(', ') + trunc + tail;
}

function daysAgoLabel(dateStr: string, today: string) {
  const d = differenceInCalendarDays(parseISO(today), parseISO(dateStr));
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  if (d < 14) return 'last week';
  if (d < 30) return `${Math.round(d / 7)} weeks ago`;
  return `${Math.round(d / 30)} months ago`;
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(sec)}`;
  return `${pad(m)}:${pad(sec)}`;
}

/* ────────────────────────── Audio / Haptics ────────────────────────── */

let audioCtx: AudioContext | null = null;
function ensureAudio() {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)(); } catch { return null; }
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}
function beep(freq = 880, ms = 160, gain = 0.08) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  g.gain.value = gain;
  osc.connect(g).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + ms / 1000);
}
function vibrate(pattern: number | number[]) {
  try { if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(pattern); } catch {}
}

/* ────────────────────────── Component ────────────────────────── */

export default function LogClient({
  plan,
  lastByEx,
  prefs,
}: {
  plan: any;
  lastByEx: Record<string, LastEntry>;
  prefs: Pref[];
}) {
  const router = useRouter();
  const isGym = plan.type === 'gym';
  const baseExercises = useMemo(() => flattenExercises(plan.prescription), [plan]);
  const storageKey = `log:${plan.id}`;

  /* ─── State ─── */
  const [sets, setSets] = useState<Record<string, SetRow[]>>(() => {
    const obj: Record<string, SetRow[]> = {};
    for (const e of baseExercises) obj[e.key] = Array.from({ length: e.targetSets }, () => ({}));
    return obj;
  });
  const [done, setDone] = useState<Record<string, boolean[]>>(() => {
    const obj: Record<string, boolean[]> = {};
    for (const e of baseExercises) obj[e.key] = Array.from({ length: e.targetSets }, () => false);
    return obj;
  });
  const [swapped, setSwapped] = useState<Record<string, string>>({});
  const [removed, setRemoved] = useState<string[]>([]);
  const [sentiment, setSentiment] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [nonGym, setNonGym] = useState<NonGymPayload>(() => initialNonGym(plan));
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [restTimer, setRestTimer] = useState<{ key: string; targetAt: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [restoredBanner, setRestoredBanner] = useState<string | null>(null);
  const [swapSheet, setSwapSheet] = useState<FlatEx | null>(null);
  const [cueSheet, setCueSheet] = useState<FlatEx | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);

  /* ─── Derived: active exercise list (with swaps + removals) ─── */
  const exercises: FlatEx[] = useMemo(() => {
    return baseExercises
      .filter(e => !removed.includes(e.key))
      .map(e => swapped[e.key] ? { ...e, exercise_id: swapped[e.key] } : e);
  }, [baseExercises, swapped, removed]);

  /* ─── Restore from localStorage ─── */
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;
      const parsed: PersistShape = JSON.parse(raw);
      if (parsed.v !== 2) return;
      if (parsed.sets) setSets(prev => ({ ...prev, ...parsed.sets }));
      if (parsed.done) setDone(prev => ({ ...prev, ...parsed.done }));
      if (parsed.swapped) setSwapped(parsed.swapped);
      if (parsed.removed) setRemoved(parsed.removed);
      if (typeof parsed.sentiment === 'number') setSentiment(parsed.sentiment);
      if (parsed.notes) setNotes(parsed.notes);
      if (parsed.nonGym && parsed.nonGym.kind === planKind(plan.type)) setNonGym(parsed.nonGym);
      if (parsed.startedAt) setStartedAt(parsed.startedAt);
      const agoMin = Math.round((Date.now() - parsed.updatedAt) / 60000);
      if (agoMin < 1) setRestoredBanner('Restored draft from just now');
      else if (agoMin < 60) setRestoredBanner(`Restored draft from ${agoMin} minute${agoMin === 1 ? '' : 's'} ago`);
      else setRestoredBanner(`Restored draft from ${Math.round(agoMin / 60)} hour${agoMin < 120 ? '' : 's'} ago`);
    } catch {}
  }, [storageKey]);

  /* ─── Auto-save (1.5s debounce) ─── */
  const saveTimer = useRef<any>(null);
  useEffect(() => {
    if (!restoredRef.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      try {
        const payload: PersistShape = {
          v: 2,
          updatedAt: Date.now(),
          startedAt,
          sets, done, swapped, removed,
          sentiment, notes, nonGym,
        };
        localStorage.setItem(storageKey, JSON.stringify(payload));
      } catch {}
    }, 1500);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [sets, done, swapped, removed, sentiment, notes, nonGym, startedAt, storageKey]);

  /* ─── Global tick for timers ─── */
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  /* ─── Rest timer zero-trigger + 10s grace auto-clear ─── */
  const firedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!restTimer) return;
    const left = restTimer.targetAt - now;
    const fireKey = `${restTimer.key}:${restTimer.targetAt}`;
    if (left <= 0 && firedRef.current !== fireKey) {
      firedRef.current = fireKey;
      vibrate([30, 50, 30]);
      beep(880, 140); setTimeout(() => beep(1175, 180), 180);
    }
    // Auto-clear 10s after the rest-over moment.
    if (left <= -10000) {
      setRestTimer(null);
    }
  }, [now, restTimer]);

  /* ─── Handlers ─── */

  const touchStart = useCallback(() => {
    if (!startedAt) setStartedAt(Date.now());
    ensureAudio(); // unlock Web Audio on user gesture
  }, [startedAt]);

  function setCell(exKey: string, idx: number, key: keyof SetRow, val: string) {
    setSets(prev => ({
      ...prev,
      [exKey]: (prev[exKey] ?? []).map((r, i) => i === idx ? { ...r, [key]: val } : r),
    }));
  }
  function nudge(exKey: string, idx: number, key: 'w' | 'r' | 'rir', delta: number) {
    setSets(prev => {
      const rows = prev[exKey] ?? [];
      const row = rows[idx] ?? {};
      const cur = firstNum(row[key]);
      let next = (cur ?? 0) + delta;
      if (key === 'rir') next = Math.max(0, Math.min(5, Math.round(next * 2) / 2));
      if (key === 'r') next = Math.max(0, Math.round(next));
      if (key === 'w') next = Math.max(0, Math.round(next * 10) / 10);
      return { ...prev, [exKey]: rows.map((r, i) => i === idx ? { ...r, [key]: String(next) } : r) };
    });
  }
  function addSet(exKey: string) {
    setSets(prev => ({ ...prev, [exKey]: [...(prev[exKey] ?? []), {}] }));
    setDone(prev => ({ ...prev, [exKey]: [...(prev[exKey] ?? []), false] }));
  }
  function removeSet(exKey: string, idx: number) {
    setSets(prev => ({ ...prev, [exKey]: (prev[exKey] ?? []).filter((_, i) => i !== idx) }));
    setDone(prev => ({ ...prev, [exKey]: (prev[exKey] ?? []).filter((_, i) => i !== idx) }));
  }

  function toggleDone(ex: FlatEx, idx: number) {
    touchStart();
    const isDone = done[ex.key]?.[idx] ?? false;
    if (!isDone) {
      // Auto-fill empty fields from last-time or weight_hint
      setSets(prev => {
        const rows = prev[ex.key] ?? [];
        const row = rows[idx] ?? {};
        const next: SetRow = { ...row };
        const last = lastByEx[ex.original_id];
        const lastSet = last?.sets?.[idx] ?? last?.sets?.[0];
        if (!next.w) {
          const fromLast = firstNum(lastSet?.w);
          const fromHint = firstNum(ex.weight_hint);
          if (fromLast != null) next.w = String(fromLast);
          else if (fromHint != null) next.w = String(fromHint);
        }
        if (!next.r) {
          const fromLast = firstNum(lastSet?.r);
          const fromHint = firstNum(ex.reps_hint);
          if (fromLast != null) next.r = String(fromLast);
          else if (fromHint != null) next.r = String(fromHint);
        }
        return { ...prev, [ex.key]: rows.map((r, i) => i === idx ? next : r) };
      });
      vibrate(20);
      setRestTimer({ key: ex.key, targetAt: Date.now() + ex.rest_s * 1000 });
    } else {
      // untoggle
      setRestTimer(prev => (prev && prev.key === ex.key ? null : prev));
    }
    setDone(prev => ({
      ...prev,
      [ex.key]: (prev[ex.key] ?? []).map((b, i) => i === idx ? !isDone : b),
    }));
  }

  function dismissRest() { setRestTimer(null); }
  function bumpRest(delta: number) {
    setRestTimer(prev => prev ? { ...prev, targetAt: prev.targetAt + delta * 1000 } : prev);
  }

  function swapExercise(ex: FlatEx, newId: string) {
    setSwapped(prev => ({ ...prev, [ex.key]: newId }));
    setSwapSheet(null);
    setMenuFor(null);
  }
  function removeBlock(ex: FlatEx) {
    setRemoved(prev => prev.includes(ex.key) ? prev : [...prev, ex.key]);
    setMenuFor(null);
  }

  /* ─── Save ─── */
  async function save(status: 'done' | 'skipped') {
    setBusy(true); setErr(null);
    try {
      let data: any = {};
      const elapsedMin = startedAt ? Math.round((Date.now() - startedAt) / 60000) : undefined;

      if (isGym) {
        const cleanedSets: Record<string, any[]> = {};
        const swapsOut: Record<string, string> = {};
        for (const ex of exercises) {
          const rows = sets[ex.key] ?? [];
          const dones = done[ex.key] ?? [];
          // Include rows that are either marked done OR have values entered
          const picked = rows
            .map((r, i) => ({ r, i, done: !!dones[i] }))
            .filter(x => x.done || x.r.w || x.r.r);
          if (picked.length === 0) continue;
          cleanedSets[ex.exercise_id] = picked.map(({ r, done: d }) => ({
            w: r.w ? (Number(r.w) || r.w) : undefined,
            r: r.r ? (Number(r.r) || r.r) : undefined,
            rir: r.rir ? Number(r.rir) : undefined,
            note: r.note || undefined,
            done: d || undefined,
          }));
          if (ex.exercise_id !== ex.original_id) swapsOut[ex.exercise_id] = ex.original_id;
        }
        data = {
          day_code: plan.day_code,
          sets: cleanedSets,
          ...(Object.keys(swapsOut).length ? { swapped_from: swapsOut } : {}),
          ...(removed.length ? { removed_blocks: removed } : {}),
          ...(elapsedMin ? { duration_actual_min: elapsedMin } : {}),
        };
      } else if (nonGym.kind !== 'none') {
        // Strip empty values for cleaner persistence
        const clean = (obj: any) => {
          const out: any = {};
          for (const [k, v] of Object.entries(obj)) {
            if (v === undefined || v === '' || v === null) continue;
            if (Array.isArray(v) && v.length === 0) continue;
            out[k] = v;
          }
          return out;
        };
        const base = clean(nonGym.data);
        data = {
          ...base,
          ...(elapsedMin ? { duration_actual_min: elapsedMin } : {}),
        };
      }

      const res = await fetch('/api/activities', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          plan_id: plan.id, date: plan.date, type: plan.type, status,
          sentiment, notes: notes || undefined, data,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const j = await res.json();
      try { localStorage.removeItem(storageKey); } catch {}
      router.push(j?.redirect ?? `/calendar/${plan.date}`);
    } catch (e: any) { setErr(e.message); setBusy(false); }
  }

  /* ─── Render ─── */

  const elapsedMs = startedAt ? now - startedAt : 0;
  const restLeftMs = restTimer ? restTimer.targetAt - now : 0;
  const restExName = restTimer ? (exercises.find(e => e.key === restTimer.key)?.exercise_id) : null;
  const bannedIds = new Set(prefs.filter(p => p.status === 'banned').map(p => p.exercise_id));

  return (
    <main className="max-w-xl mx-auto px-4 py-4 pb-40">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <Link href="/today" className="text-tiny text-muted">← cancel</Link>
          <h1 className="text-xl font-bold tracking-tight mt-1 leading-tight">
            Log · {plan.type}{plan.day_code ? ` · ${plan.day_code}` : ''}
          </h1>
          <p className="text-tiny text-muted">{plan.date}</p>
        </div>
        {startedAt && isGym && (
          <div className="text-right shrink-0">
            <div className="text-tiny text-muted uppercase tracking-wider">Elapsed</div>
            <div className="text-base font-mono tabular-nums">{fmtElapsed(elapsedMs)}</div>
          </div>
        )}
      </div>

      {restoredBanner && (
        <div className="mt-3 rounded-lg bg-panel-2 border border-border px-3 py-2 text-tiny flex items-center justify-between">
          <span className="text-muted-2">{restoredBanner}</span>
          <button
            onClick={() => { try { localStorage.removeItem(storageKey); } catch {} ; location.reload(); }}
            className="text-accent hover:underline"
          >Start fresh</button>
        </div>
      )}

      {plan.prescription?.notes_top && (
        <p className="text-tiny italic text-muted mt-3">{plan.prescription.notes_top}</p>
      )}

      {/* Gym body */}
      {isGym && exercises.length > 0 && (
        <section className="mt-4 space-y-3">
          {exercises.map(ex => {
            const rows = sets[ex.key] ?? [];
            const dones = done[ex.key] ?? [];
            const doneCount = dones.filter(Boolean).length;
            const last = lastByEx[ex.original_id];
            const isSwapped = !!swapped[ex.key];
            return (
              <div key={ex.key} className="rounded-xl bg-panel border border-border p-3">
                {/* Header row */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      {ex.block_label && (
                        <span className="text-[10px] font-semibold text-muted-2 bg-panel-2 rounded px-1 py-0.5">{ex.block_label}</span>
                      )}
                      <Link href={`/exercise/${encodeURIComponent(ex.exercise_id)}`} className="font-medium text-sm leading-tight hover:underline">
                        {prettyName(ex.exercise_id)}
                      </Link>
                      {isSwapped && (
                        <span className="text-[10px] text-accent bg-accent/15 border border-accent/30 rounded px-1">swapped</span>
                      )}
                    </div>
                    <div className="text-[11px] text-muted mt-0.5">
                      {ex.targetSets} × {ex.reps_hint || '?'}
                      {ex.weight_hint ? ` · ${ex.weight_hint}` : ''}
                      {ex.rest_s ? ` · ${ex.rest_s}s rest` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="text-[11px] text-muted-2 tabular-nums">{doneCount}/{rows.length}</div>
                    <div className="relative">
                      <button
                        onClick={() => setMenuFor(menuFor === ex.key ? null : ex.key)}
                        aria-label="exercise menu"
                        className="text-muted hover:text-white text-lg leading-none px-2 py-0.5 rounded hover:bg-panel-2"
                      >⋯</button>
                      {menuFor === ex.key && (
                        <div className="absolute right-0 top-full mt-1 z-30 w-40 rounded-lg bg-panel-2 border border-border-strong shadow-pop text-tiny overflow-hidden">
                          <button onClick={() => { setCueSheet(ex); setMenuFor(null); }} className="w-full text-left px-3 py-2 hover:bg-panel">View cues</button>
                          <button onClick={() => { setSwapSheet(ex); setMenuFor(null); }} className="w-full text-left px-3 py-2 hover:bg-panel">Swap exercise</button>
                          <button onClick={() => removeBlock(ex)} className="w-full text-left px-3 py-2 hover:bg-panel text-danger">Remove</button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Last time strip */}
                {last ? (
                  <div className="mt-2 text-[11px] text-muted-2 flex items-center gap-1.5">
                    <span className="text-muted">Last:</span>
                    <span className="tabular-nums truncate">{formatLastSets(last.sets)}</span>
                    <span className="text-muted ml-auto shrink-0">· {daysAgoLabel(last.date, plan.date)}</span>
                  </div>
                ) : (
                  <div className="mt-2 text-[11px] text-muted italic">First time doing this</div>
                )}

                {ex.notes && <p className="text-[11px] italic text-muted mt-1">{ex.notes}</p>}

                {/* Set rows */}
                <div className="mt-2.5 space-y-1.5">
                  {rows.map((row, i) => {
                    const isDone = dones[i] ?? false;
                    return (
                      <div key={i} className={`flex items-center gap-1 text-sm rounded-lg px-1 py-1 -mx-1 transition-colors ${isDone ? 'bg-accent/10' : ''}`}>
                        <span className="text-[10px] text-muted w-5 shrink-0 text-center">{i + 1}</span>

                        {/* Weight */}
                        <div className="flex items-center bg-panel-2 border border-border rounded">
                          <button onClick={() => { touchStart(); nudge(ex.key, i, 'w', -2.5); }} className="px-1.5 py-1 text-muted hover:text-white text-sm" aria-label="weight down">−</button>
                          <input
                            type="number" step="0.5" inputMode="decimal" placeholder="wt"
                            value={row.w ?? ''}
                            onFocus={touchStart}
                            onChange={e => setCell(ex.key, i, 'w', e.target.value)}
                            className="w-12 bg-transparent text-center py-1 focus:outline-none tabular-nums"
                          />
                          <button onClick={() => { touchStart(); nudge(ex.key, i, 'w', 2.5); }} className="px-1.5 py-1 text-muted hover:text-white text-sm" aria-label="weight up">+</button>
                        </div>

                        {/* Reps */}
                        <div className="flex items-center bg-panel-2 border border-border rounded">
                          <button onClick={() => { touchStart(); nudge(ex.key, i, 'r', -1); }} className="px-1.5 py-1 text-muted hover:text-white text-sm" aria-label="reps down">−</button>
                          <input
                            type="number" inputMode="numeric" placeholder="reps"
                            value={row.r ?? ''}
                            onFocus={touchStart}
                            onChange={e => setCell(ex.key, i, 'r', e.target.value)}
                            className="w-11 bg-transparent text-center py-1 focus:outline-none tabular-nums"
                          />
                          <button onClick={() => { touchStart(); nudge(ex.key, i, 'r', 1); }} className="px-1.5 py-1 text-muted hover:text-white text-sm" aria-label="reps up">+</button>
                        </div>

                        {/* RIR */}
                        <div className="flex items-center bg-panel-2 border border-border rounded">
                          <button onClick={() => { touchStart(); nudge(ex.key, i, 'rir', -0.5); }} className="px-1 py-1 text-muted text-xs" aria-label="rir down">−</button>
                          <input
                            type="number" step="0.5" inputMode="decimal" placeholder="RIR"
                            value={row.rir ?? ''}
                            onFocus={touchStart}
                            onChange={e => setCell(ex.key, i, 'rir', e.target.value)}
                            className="w-9 bg-transparent text-center py-1 focus:outline-none tabular-nums text-xs"
                          />
                          <button onClick={() => { touchStart(); nudge(ex.key, i, 'rir', 0.5); }} className="px-1 py-1 text-muted text-xs" aria-label="rir up">+</button>
                        </div>

                        {/* Checkbox */}
                        <button
                          onClick={() => toggleDone(ex, i)}
                          aria-label={isDone ? 'undo set' : 'mark set done'}
                          className={`ml-auto w-8 h-8 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
                            isDone ? 'bg-accent border-accent text-black' : 'border-muted/50 text-transparent hover:border-accent'
                          }`}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="5 12 10 17 19 7" />
                          </svg>
                        </button>

                        {/* Remove */}
                        <button onClick={() => removeSet(ex.key, i)} className="text-muted-2 hover:text-danger text-xs px-1" aria-label="remove set">×</button>
                      </div>
                    );
                  })}
                  <button onClick={() => addSet(ex.key)} className="text-tiny text-accent hover:underline">+ set</button>
                </div>
              </div>
            );
          })}
        </section>
      )}

      {/* Non-gym: dispatch to modality-specific form */}
      {!isGym && nonGym.kind === 'cardio' && (
        <section className="mt-4">
          <CardioLog
            type={plan.type as CardioType}
            plan={plan}
            value={nonGym.data}
            onChange={v => setNonGym({ kind: 'cardio', data: v })}
            onTouchStart={touchStart}
          />
        </section>
      )}
      {!isGym && nonGym.kind === 'yoga' && (
        <section className="mt-4">
          <YogaLog
            plan={plan}
            value={nonGym.data}
            onChange={v => setNonGym({ kind: 'yoga', data: v })}
            onTouchStart={touchStart}
          />
        </section>
      )}
      {!isGym && nonGym.kind === 'climb' && (
        <section className="mt-4">
          <ClimbLog
            plan={plan}
            value={nonGym.data}
            onChange={v => setNonGym({ kind: 'climb', data: v })}
            onTouchStart={touchStart}
          />
        </section>
      )}
      {!isGym && nonGym.kind === 'mobility' && (
        <section className="mt-4">
          <MobilityLog
            plan={plan}
            value={nonGym.data}
            onChange={v => setNonGym({ kind: 'mobility', data: v })}
            onTouchStart={touchStart}
          />
        </section>
      )}
      {!isGym && nonGym.kind === 'sauna_cold' && (
        <section className="mt-4">
          <SaunaColdLog
            plan={plan}
            value={nonGym.data}
            onChange={v => setNonGym({ kind: 'sauna_cold', data: v })}
            onTouchStart={touchStart}
          />
        </section>
      )}

      {/* Sentiment + notes */}
      <section className="mt-4 rounded-xl bg-panel border border-border p-3">
        <div className="text-[11px] text-muted mb-1">How did it feel?</div>
        <div className="flex gap-1.5">
          {[1, 2, 3, 4, 5].map(n => (
            <button key={n} onClick={() => setSentiment(s => s === n ? null : n)} className={`flex-1 py-2 rounded text-sm border ${sentiment === n ? 'bg-accent text-black border-accent' : 'bg-panel-2 border-border'}`}>
              {['😵','😕','😐','🙂','💪'][n - 1]}
            </button>
          ))}
        </div>
        <textarea
          placeholder="Notes (energy, soreness, what went well, what to change)"
          value={notes}
          onChange={e => setNotes(e.target.value)}
          className="w-full mt-3 bg-panel-2 border border-border rounded px-2 py-2 text-sm min-h-[60px]"
        />
      </section>

      {err && <p className="text-tiny text-danger mt-3">{err}</p>}

      <div className="mt-4 grid grid-cols-2 gap-2">
        <button onClick={() => save('skipped')} disabled={busy} className="bg-panel border border-border rounded-lg py-3 text-sm disabled:opacity-50">Mark skipped</button>
        <button onClick={() => save('done')} disabled={busy} className="bg-accent text-black font-semibold rounded-lg py-3 disabled:opacity-50">{busy ? 'Saving…' : 'Save as done'}</button>
      </div>

      {/* Rest timer dock */}
      {restTimer && (
        <div className="fixed left-0 right-0 bottom-[calc(env(safe-area-inset-bottom)+64px)] z-40 px-3 pointer-events-none">
          <div className="max-w-xl mx-auto pointer-events-auto">
            <div className={`rounded-xl border shadow-pop backdrop-blur px-3 py-2.5 flex items-center gap-2 ${
              restLeftMs <= 0 ? 'bg-accent text-black border-accent' : 'bg-panel/95 border-border-strong'
            }`}>
              <div className="min-w-0 flex-1">
                <div className={`text-[10px] uppercase tracking-wider ${restLeftMs <= 0 ? 'text-black/70' : 'text-muted'}`}>
                  {restLeftMs <= 0 ? 'Rest over — next set' : 'Rest'}
                </div>
                <div className="text-lg font-mono tabular-nums font-semibold leading-tight">
                  {restLeftMs <= 0 ? 'GO' : fmtElapsed(restLeftMs)}
                  {restExName && (
                    <span className={`ml-2 text-tiny font-normal ${restLeftMs <= 0 ? 'text-black/70' : 'text-muted-2'} truncate inline-block align-middle max-w-[40vw]`}>
                      · {prettyName(restExName)}
                    </span>
                  )}
                </div>
              </div>
              <button onClick={() => bumpRest(-15)} className={`text-tiny px-2 py-1 rounded border ${restLeftMs <= 0 ? 'border-black/20' : 'border-border bg-panel-2'}`}>−15</button>
              <button onClick={() => bumpRest(15)} className={`text-tiny px-2 py-1 rounded border ${restLeftMs <= 0 ? 'border-black/20' : 'border-border bg-panel-2'}`}>+15</button>
              <button onClick={dismissRest} className={`text-tiny px-2 py-1 rounded ${restLeftMs <= 0 ? 'bg-black text-accent' : 'bg-panel-2 border border-border'}`}>Skip</button>
            </div>
          </div>
        </div>
      )}

      {/* Cue sheet */}
      <BottomSheet open={!!cueSheet} onClose={() => setCueSheet(null)} title={cueSheet ? prettyName(cueSheet.exercise_id) : ''}>
        {cueSheet && <CueSheetBody ex={cueSheet} />}
      </BottomSheet>

      {/* Swap sheet */}
      <BottomSheet open={!!swapSheet} onClose={() => setSwapSheet(null)} title={swapSheet ? `Swap ${prettyName(swapSheet.exercise_id)}` : 'Swap'}>
        {swapSheet && (
          <SwapSheetBody
            ex={swapSheet}
            bannedIds={bannedIds}
            onPick={id => swapExercise(swapSheet, id)}
          />
        )}
      </BottomSheet>
    </main>
  );
}

/* ────────────────────────── Subcomponents ────────────────────────── */

function CueSheetBody({ ex }: { ex: FlatEx }) {
  const entry = getExercise(ex.exercise_id);
  if (!entry) {
    return (
      <div className="text-small text-muted">
        No library entry yet for <span className="font-mono text-muted-2">{ex.exercise_id}</span>.
      </div>
    );
  }
  return (
    <div className="space-y-4 text-small">
      <div className="text-tiny text-muted uppercase tracking-wider">{entry.primary_muscle} · {entry.pattern.replace('_', ' ')}</div>
      <Section title="How to do it" items={entry.how_to} />
      <Section title="Cues" items={entry.cues} />
      <Section title="Common mistakes" items={entry.mistakes} />
      {entry.safety && entry.safety.length > 0 && <Section title="Safety" items={entry.safety} accent />}
      <div className="pt-2">
        <Link href={`/exercise/${encodeURIComponent(ex.exercise_id)}`} className="text-tiny text-accent hover:underline">
          View full detail & history →
        </Link>
      </div>
    </div>
  );
}

function Section({ title, items, accent }: { title: string; items: string[]; accent?: boolean }) {
  return (
    <div>
      <div className={`text-tiny uppercase tracking-wider mb-1 ${accent ? 'text-accent' : 'text-muted'}`}>{title}</div>
      <ul className="list-disc pl-5 space-y-1 text-muted-2">
        {items.map((s, i) => <li key={i}>{s}</li>)}
      </ul>
    </div>
  );
}

function SwapSheetBody({ ex, bannedIds, onPick }: { ex: FlatEx; bannedIds: Set<string>; onPick: (id: string) => void }) {
  const original = getExercise(ex.original_id);
  const candidates: ExerciseEntry[] = Object.values(EXERCISE_LIBRARY)
    .filter(e => e.id !== ex.exercise_id)
    .filter(e => !bannedIds.has(e.id))
    .filter(e => !original || e.pattern === original.pattern)
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="space-y-2">
      <div className="text-tiny text-muted">
        Showing alternatives that work the same movement pattern
        {original ? ` (${original.pattern.replace('_', ' ')})` : ''}.
      </div>
      {candidates.length === 0 && (
        <div className="text-small text-muted italic py-4 text-center">No matching alternatives in the library yet.</div>
      )}
      <div className="space-y-1.5">
        {candidates.map(c => (
          <button
            key={c.id}
            onClick={() => onPick(c.id)}
            className="w-full text-left rounded-lg bg-panel-2 border border-border hover:border-accent px-3 py-2"
          >
            <div className="font-medium text-small">{c.name}</div>
            <div className="text-tiny text-muted">{c.primary_muscle}{c.equipment ? ` · ${c.equipment.join(', ')}` : ''}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
