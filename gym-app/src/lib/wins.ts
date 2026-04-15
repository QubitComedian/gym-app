/**
 * Session recap — wins detection.
 * Server-side utility that takes the just-saved activity + recent history
 * and returns an ordered list of "wins" to celebrate on the recap screen.
 *
 * Keep this deterministic, cheap, and never negative.
 */

export type WinKind =
  | 'pr'
  | 'volume_up'
  | 'streak'
  | 'first_time'
  | 'intensity'
  | 'distance_pr'
  | 'pace_pr'
  | 'hardest_send'
  | 'modality_milestone'
  | 'first_session';

export type Win = {
  kind: WinKind;
  label: string;
  detail?: string;
};

type Activity = {
  id: string;
  date: string;
  type: string;
  status: string;
  data?: any;
};

type SetRow = { w?: number | string; r?: number | string; rir?: number; note?: string; done?: boolean };

function num(x: any): number | null {
  if (x == null || x === '') return null;
  const n = typeof x === 'number' ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}

function round1(n: number) { return Math.round(n * 10) / 10; }

/* ───────────────────── Gym wins ───────────────────── */

type SetHistory = { date: string; w: number; r: number }[];

function topSetOfSession(rows: SetRow[]): { w: number; r: number } | null {
  let best: { w: number; r: number } | null = null;
  for (const row of rows) {
    const w = num(row.w); const r = num(row.r);
    if (w == null || r == null || r < 1) continue;
    if (!best || w > best.w || (w === best.w && r > best.r)) best = { w, r };
  }
  return best;
}

function flattenSets(act: Activity, exId: string): SetHistory {
  const rows = (act.data?.sets?.[exId] ?? []) as SetRow[];
  const out: SetHistory = [];
  for (const row of rows) {
    const w = num(row.w); const r = num(row.r);
    if (w == null || r == null) continue;
    out.push({ date: act.date, w, r });
  }
  return out;
}

function detectGymWins(
  current: Activity,
  history: Activity[]
): Win[] {
  const wins: Win[] = [];
  const currentSets = current.data?.sets as Record<string, SetRow[]> | undefined;
  if (!currentSets) return wins;

  // PR scan — per exercise, compare top set to all-time history
  const prCandidates: { exId: string; w: number; r: number; prevBest?: number }[] = [];
  for (const [exId, rows] of Object.entries(currentSets)) {
    const top = topSetOfSession(rows);
    if (!top || top.r < 3) continue; // skip singles/doubles unless explicitly prescribed (we can't easily tell → be conservative)
    const historyRows: SetHistory = [];
    for (const a of history) {
      historyRows.push(...flattenSets(a, exId));
    }
    // previous-best weight at reps >= top.r
    const eligible = historyRows.filter(h => h.r >= top.r);
    const prevBest = eligible.length ? Math.max(...eligible.map(h => h.w)) : 0;
    if (top.w > prevBest) {
      prCandidates.push({ exId, w: top.w, r: top.r, prevBest: prevBest || undefined });
    }
  }
  // Cap PRs at 2, heaviest first
  prCandidates.sort((a, b) => b.w - a.w);
  for (const c of prCandidates.slice(0, 2)) {
    const delta = c.prevBest ? ` · +${round1(c.w - c.prevBest)}kg` : '';
    wins.push({
      kind: 'pr',
      label: `${exNameSafe(c.exId)} ${c.w} × ${c.r} — PR`,
      detail: delta || undefined,
    });
  }

  // First-time exercise (present in current, absent from last 120 days)
  const currentExIds = new Set(Object.keys(currentSets));
  const historicExIds = new Set<string>();
  for (const a of history) {
    for (const k of Object.keys(a.data?.sets ?? {})) historicExIds.add(k);
  }
  for (const id of currentExIds) {
    if (!historicExIds.has(id)) {
      wins.push({ kind: 'first_time', label: `New exercise: ${exNameSafe(id)}` });
      break; // at most one first-time callout per session
    }
  }

  // Volume up — total tonnage vs mean of last 3 same-type sessions
  const currentTonnage = tonnageOf(current);
  if (currentTonnage > 0) {
    const peers = history
      .filter(a => a.type === current.type && a.status === 'done')
      .slice(0, 3)
      .map(tonnageOf)
      .filter(x => x > 0);
    if (peers.length >= 2) {
      const mean = peers.reduce((a, b) => a + b, 0) / peers.length;
      if (mean > 0 && currentTonnage > mean * 1.05) {
        const deltaKg = Math.round(currentTonnage - mean);
        wins.push({
          kind: 'volume_up',
          label: `Volume +${deltaKg} kg`,
          detail: `vs recent ${peers.length}-session average`,
        });
      }
    }
  }

  // Intensity — mean RIR dropped by ≥1 vs last 3
  const currentRir = meanRirOf(current);
  if (currentRir != null) {
    const peerRirs = history
      .filter(a => a.type === current.type && a.status === 'done')
      .slice(0, 3)
      .map(meanRirOf)
      .filter((x): x is number => x != null);
    if (peerRirs.length >= 2) {
      const peerMean = peerRirs.reduce((a, b) => a + b, 0) / peerRirs.length;
      if (peerMean - currentRir >= 1) {
        wins.push({ kind: 'intensity', label: 'Hardest push in a while', detail: `avg RIR ${round1(currentRir)}` });
      }
    }
  }

  return wins;
}

export function tonnageOf(a: { data?: any }): number {
  const sets = a.data?.sets as Record<string, SetRow[]> | undefined;
  if (!sets) return 0;
  let total = 0;
  for (const rows of Object.values(sets)) {
    for (const row of rows) {
      const w = num(row.w); const r = num(row.r);
      if (w != null && r != null) total += w * r;
    }
  }
  return total;
}

function meanRirOf(a: Activity): number | null {
  const sets = a.data?.sets as Record<string, SetRow[]> | undefined;
  if (!sets) return null;
  const rirs: number[] = [];
  for (const rows of Object.values(sets)) {
    for (const row of rows) {
      if (row.rir != null) {
        const n = num(row.rir);
        if (n != null) rirs.push(n);
      }
    }
  }
  return rirs.length ? rirs.reduce((a, b) => a + b, 0) / rirs.length : null;
}

/* ───────────────────── Cardio wins ───────────────────── */

function paceToSeconds(pace?: string): number | null {
  if (!pace) return null;
  // "5:30/km" or "1:45/100m"
  const m = pace.match(/^(\d+):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function detectCardioWins(current: Activity, history: Activity[]): Win[] {
  const wins: Win[] = [];
  const d = current.data ?? {};
  const type = current.type;

  // Distance PR (run/bike)
  if (type === 'run' || type === 'bike') {
    const km = num(d.distance_km);
    if (km != null) {
      const peers = history.filter(a => a.type === type && a.status === 'done');
      const prevMax = Math.max(0, ...peers.map(a => num(a.data?.distance_km) ?? 0));
      if (km > prevMax && km >= 2) {
        wins.push({ kind: 'distance_pr', label: `Longest ${type} yet · ${km}km` });
      }
    }
  }

  // Distance PR (swim, in meters)
  if (type === 'swim') {
    const m = num(d.distance_m);
    if (m != null) {
      const peers = history.filter(a => a.type === 'swim' && a.status === 'done');
      const prevMax = Math.max(0, ...peers.map(a => num(a.data?.distance_m) ?? 0));
      if (m > prevMax && m >= 500) {
        wins.push({ kind: 'distance_pr', label: `Longest swim yet · ${m}m` });
      }
    }
  }

  // Pace PR — same or greater distance, faster pace
  const currentPaceS = paceToSeconds(d.pace);
  if (currentPaceS != null) {
    const currentDist =
      type === 'swim' ? (num(d.distance_m) ?? 0) / 100 : (num(d.distance_km) ?? 0);
    if (currentDist > 0) {
      const peers = history.filter(a => a.type === type && a.status === 'done');
      let beaten = 0;
      for (const p of peers) {
        const pDist =
          type === 'swim' ? (num(p.data?.distance_m) ?? 0) / 100 : (num(p.data?.distance_km) ?? 0);
        const pPace = paceToSeconds(p.data?.pace);
        if (pPace != null && pDist >= currentDist * 0.9 && pPace > currentPaceS) beaten++;
      }
      if (peers.length >= 3 && beaten >= peers.length * 0.8) {
        wins.push({ kind: 'pace_pr', label: `Fastest pace at this distance · ${d.pace}` });
      }
    }
  }

  return wins;
}

/* ───────────────────── Climb wins ───────────────────── */

function gradeRank(g: string): number {
  // V-scale
  const vm = g.match(/^V(\d+)/i);
  if (vm) return 100 + Number(vm[1]); // V0=100, V5=105, V12=112
  // French (5a, 5b+, 6a, 6b+, 7a, …)
  const fm = g.match(/^(\d)([abc])?\+?/i);
  if (fm) {
    const base = Number(fm[1]) * 10;
    const letter = fm[2] ? { a: 0, b: 3, c: 6 }[fm[2].toLowerCase() as 'a' | 'b' | 'c'] : 0;
    const plus = g.includes('+') ? 1.5 : 0;
    return base + (letter ?? 0) + plus;
  }
  return 0;
}

function detectClimbWins(current: Activity, history: Activity[]): Win[] {
  const wins: Win[] = [];
  const hs = current.data?.hardest_send as string | undefined;
  if (!hs) return wins;
  const rank = gradeRank(hs);
  if (rank === 0) return wins;

  const peers = history.filter(a => a.type === 'climb' && a.status === 'done');
  const prevMax = Math.max(0, ...peers.map(a => gradeRank(a.data?.hardest_send ?? '')));
  if (rank > prevMax) {
    wins.push({ kind: 'hardest_send', label: `Hardest send yet · ${hs}` });
  }
  return wins;
}

/* ───────────────────── Modality milestones (yoga/mobility/sauna) ───────────────────── */

function detectMilestoneWins(current: Activity, history: Activity[]): Win[] {
  const wins: Win[] = [];
  const type = current.type;
  if (!['yoga', 'mobility', 'sauna_cold'].includes(type)) return wins;

  // How many sessions of this type this calendar month (including this one)
  const curDate = new Date(current.date + 'T00:00:00');
  const monthStart = new Date(curDate.getFullYear(), curDate.getMonth(), 1);
  const sameMonthCount =
    1 +
    history.filter(a => {
      if (a.type !== type || a.status !== 'done') return false;
      const d = new Date(a.date + 'T00:00:00');
      return d >= monthStart && d < curDate;
    }).length;

  if ([4, 8, 12, 16, 20].includes(sameMonthCount)) {
    const label =
      type === 'sauna_cold'
        ? `${sameMonthCount} recovery sessions this month`
        : type === 'yoga'
        ? `${sameMonthCount} yoga sessions this month`
        : `${sameMonthCount} mobility sessions this month`;
    wins.push({ kind: 'modality_milestone', label });
  }
  return wins;
}

/* ───────────────────── Streak ───────────────────── */

export function currentStreak(current: Activity, history: Activity[]): number {
  // Consecutive days with any done activity, counting back from current.date
  const doneDates = new Set<string>([current.date]);
  for (const a of history) {
    if (a.status === 'done') doneDates.add(a.date);
  }
  let streak = 0;
  let d = new Date(current.date + 'T00:00:00');
  while (doneDates.has(toIso(d))) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/* ───────────────────── Per-exercise deltas ───────────────────── */

export type ExerciseDelta = {
  exercise_id: string;
  top_set?: { w: number; r: number };
  prev_top_set?: { w: number; r: number; date: string };
  delta_kg?: number;
};

export function deltasFor(current: Activity, history: Activity[]): ExerciseDelta[] {
  const currentSets = current.data?.sets as Record<string, SetRow[]> | undefined;
  if (!currentSets) return [];
  const out: ExerciseDelta[] = [];
  for (const [exId, rows] of Object.entries(currentSets)) {
    const top = topSetOfSession(rows);
    if (!top) { out.push({ exercise_id: exId }); continue; }
    // Previous session that logged this exercise
    let prev: { w: number; r: number; date: string } | undefined;
    for (const a of history) {
      const rs = a.data?.sets?.[exId] as SetRow[] | undefined;
      if (rs && rs.length) {
        const pt = topSetOfSession(rs);
        if (pt) { prev = { ...pt, date: a.date }; break; }
      }
    }
    out.push({
      exercise_id: exId,
      top_set: top,
      prev_top_set: prev,
      delta_kg: prev ? round1(top.w - prev.w) : undefined,
    });
  }
  return out;
}

/* ───────────────────── Public API ───────────────────── */

export function detectWins(current: Activity, history: Activity[]): Win[] {
  // First-ever session gets its own distinct hero
  const priorDone = history.filter(a => a.status === 'done');
  if (priorDone.length === 0) {
    return [{ kind: 'first_session', label: 'First session logged' }];
  }

  const wins: Win[] = [];
  if (current.type === 'gym') wins.push(...detectGymWins(current, history));
  else if (['run', 'bike', 'swim'].includes(current.type)) wins.push(...detectCardioWins(current, history));
  else if (current.type === 'climb') wins.push(...detectClimbWins(current, history));
  wins.push(...detectMilestoneWins(current, history));

  // Streak milestone — every 3 days of streak, celebrate
  const streak = currentStreak(current, history);
  if (streak >= 3 && [3, 5, 7, 10, 14, 21, 30, 45, 60, 90].includes(streak)) {
    wins.push({ kind: 'streak', label: `${streak}-day streak` });
  }

  // Priority ordering & cap at 3
  const priority: Record<WinKind, number> = {
    pr: 1,
    hardest_send: 2,
    distance_pr: 3,
    pace_pr: 4,
    first_time: 5,
    first_session: 6,
    streak: 7,
    volume_up: 8,
    intensity: 9,
    modality_milestone: 10,
  };
  wins.sort((a, b) => (priority[a.kind] ?? 99) - (priority[b.kind] ?? 99));
  return wins.slice(0, 3);
}

function exNameSafe(id: string): string {
  if (!id) return '';
  return id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
