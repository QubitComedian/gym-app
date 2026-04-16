/**
 * Google Calendar event formatter (v2).
 *
 * Produces rich, human-readable calendar holds for planned sessions:
 *
 *   - `summary` is a descriptive sentence, not a jargon token. Examples:
 *       • "Push day — Chest, shoulders & triceps"
 *       • "Easy run · 8 km · Zone 2"
 *       • "Full-body mobility — 25 min reset"
 *   - `description` is a richly-formatted multi-section block with full
 *     sentences explaining each movement, the aim of the session, and
 *     what the user should feel. It reads like a coach note, not a stats
 *     dump.
 *
 * The goal is that someone looking at their Google Calendar widget on
 * their phone (or even via the email reminder) should understand the
 * session without opening the app.
 *
 * Pure functions — no network, no DB. Takes in the plan + prescription
 * and returns { summary, description }.
 */

export type Plan = {
  id?: string;
  date: string;
  type: string;
  day_code: string | null;
  prescription: any;
};

export type Phase = {
  code?: string | null;
  name?: string | null;
} | null;

/* ─── helpers ─────────────────────────────────────────────────────────── */

function humanizeExerciseId(id: string | undefined | null): string {
  if (!id) return '';
  return id
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function emojiForType(type: string): string {
  switch (type) {
    case 'gym': return '🏋️';
    case 'run': return '🏃';
    case 'bike': return '🚴';
    case 'swim': return '🏊';
    case 'yoga': return '🧘';
    case 'climb': return '🧗';
    case 'mobility': return '🌀';
    case 'sauna_cold': return '🔥❄️';
    case 'rest': return '😌';
    default: return '✨';
  }
}

function prettyPacePair(p: any): string {
  if (!p) return '';
  if (typeof p === 'number') return `${Math.floor(p / 60)}:${String(p % 60).padStart(2, '0')}/km`;
  if (Array.isArray(p) && p.length === 2) {
    const a = p[0], b = p[1];
    const f = (n: number) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
    return `${f(a)}–${f(b)}/km`;
  }
  return '';
}

function fmtScheme(s: any): string {
  if (!s) return '';
  if (s.type === 'standard') return `${s.sets ?? '?'} sets of ${s.reps ?? '?'} reps`;
  if (s.type === 'emom') return `EMOM ${s.minutes} min · ${s.reps_per_min} reps every minute${s.total_reps ? ` (${s.total_reps} total)` : ''}`;
  if (s.type === 'time') {
    if (s.seconds_per_side) return `${s.sets ?? 1} × ${s.seconds_per_side}s per side`;
    return `${s.sets ?? 1} × ${s.seconds ?? '?'}s hold`;
  }
  if (s.type === 'circuit') return `${s.rounds ?? '?'} circuit rounds`;
  return '';
}

function restLine(rest_s: number | undefined | null): string {
  if (rest_s == null) return '';
  if (rest_s < 60) return `Rest ~${rest_s}s between sets.`;
  const m = Math.round(rest_s / 60);
  return `Rest ~${m} min between sets.`;
}

function rirNote(rir: number | undefined | null): string {
  if (rir == null) return '';
  if (rir <= 0) return 'Push to failure on the last set.';
  if (rir === 1) return 'Leave 1 rep in reserve — just shy of failure.';
  if (rir === 2) return 'Leave about 2 reps in reserve — quality over grit.';
  return `Leave ~${rir} reps in reserve.`;
}

/* ─── session-intent blurbs ───────────────────────────────────────────── */

const GYM_INTENT: Record<string, string> = {
  push:        'Today is about the anterior chain: chest, shoulders and triceps. Move well before you move heavy — warm up the cuff and get the bar path clean, then earn the top sets.',
  pull:        'Back & biceps focus. Prioritise scapular control on every rep — initiate from the mid-back, finish elbows behind the ribs. Rows set the tone, pulls finish the work.',
  lower:       'Lower-body day. Squat / hinge / single-leg — in that order of priority. Keep the first working set conservative; the second tells you if load is right.',
  upper_full:  'Upper-body volume with a finisher. Move with intent through warm-ups, aim for clean reps in the main lifts, then accept a bit of mess on the accessory circuit.',
};

const RUN_INTENT: Record<string, string> = {
  easy_run:     'Conversational pace — if you can\'t chat in full sentences, slow down. This is mitochondrial volume, not a workout. Nose-breathe for the first 10 minutes.',
  quality_run:  'A workout, not a jog. Warm up thoroughly, hit the target range on the reps, and stop the session if form starts to fall apart. Quality > extending distance.',
  long_run:     'Long and steady. Eat carbs 60–90 min beforehand, sip fluid every 15–20 minutes, and keep the last 2 km the strongest — no death march.',
};

const MOBILITY_INTENT =
  'A recovery-oriented reset. Favour slow breath (4s in / 6s out), spend real time in each shape, and let the nervous system wind down. This is not a stretching workout — it\'s restoration.';
const YOGA_INTENT =
  'Breath-paced flow. Match movement to breath, don\'t chase depth. The goal is improved control through a bigger range, not a bendier pretzel.';
const SWIM_INTENT =
  'Feel for the water first. Smooth technique > hard effort — you can always close out harder on the final 100s if form is holding.';
const BIKE_INTENT =
  'Cadence is more important than raw power today. Find a spin that feels like 85–95 rpm and stay there. Keep the upper body quiet.';
const CLIMB_INTENT =
  'Warm up easy and long — stiff fingers are injured fingers. Climb for smoothness; hard attempts only after you feel moving well.';
const SAUNA_COLD_INTENT =
  'Contrast block for recovery and discipline. Breathe through the discomfort in the cold, stay relaxed in the heat. Stop if anything feels off.';

function gymIntentFor(day_code: string | null | undefined): string {
  if (!day_code) return 'A focused strength block. Move well, then move heavy.';
  return GYM_INTENT[day_code] ??
    `A ${humanizeExerciseId(day_code).toLowerCase()} strength block — move cleanly, earn the top sets.`;
}

function runIntentFor(day_code: string | null | undefined): string {
  if (!day_code) return 'Solid running day. Warm up thoroughly and close the last kilometre smooth.';
  return RUN_INTENT[day_code] ??
    `A ${humanizeExerciseId(day_code).toLowerCase()} session. Warm up, execute, cool down.`;
}

/* ─── summary (event title) builder ───────────────────────────────────── */

export function buildSummary(plan: Plan, phase?: Phase): string {
  const e = emojiForType(plan.type);
  const suffix = phase?.code ? `  ·  ${phase.code}` : '';

  switch (plan.type) {
    case 'gym': {
      const code = plan.day_code;
      const label = code === 'push'       ? 'Push day — Chest, shoulders & triceps'
                 : code === 'pull'       ? 'Pull day — Back & biceps'
                 : code === 'lower'      ? 'Lower body — Squat, hinge & single-leg'
                 : code === 'upper_full' ? 'Upper-body full — Volume + finisher'
                 : code ? `Gym — ${humanizeExerciseId(code)}`
                 : 'Gym session';
      const n = plan.prescription?.blocks?.length ?? 0;
      return `${e} ${label}${n ? `  ·  ${n} block${n === 1 ? '' : 's'}` : ''}${suffix}`;
    }
    case 'run': {
      const r = plan.prescription?.run ?? {};
      const km = r.km ?? r.distance_km;
      const min = r.duration_min;
      const dist = km != null ? `${km} km` : min != null ? `${min} min` : '';
      const kindLabel =
        plan.day_code === 'easy_run'    ? 'Easy run' :
        plan.day_code === 'quality_run' ? 'Quality run' :
        plan.day_code === 'long_run'    ? 'Long run'    :
        'Run';
      return `${e} ${kindLabel}${dist ? `  ·  ${dist}` : ''}${suffix}`;
    }
    case 'bike': {
      const b = plan.prescription?.bike ?? {};
      const km = b.km ?? b.distance_km;
      const min = b.duration_min;
      const dist = km != null ? `${km} km` : min != null ? `${min} min` : '';
      return `${e} Bike${dist ? `  ·  ${dist}` : ''}${suffix}`;
    }
    case 'swim': {
      const s = plan.prescription?.swim ?? {};
      const d = s.distance_m ? `${s.distance_m} m` : s.duration_min ? `${s.duration_min} min` : '';
      return `${e} Swim${d ? `  ·  ${d}` : ''}${suffix}`;
    }
    case 'yoga': {
      const y = plan.prescription?.yoga ?? {};
      return `${e} Yoga${y.duration_min ? `  ·  ${y.duration_min} min` : ''}${y.focus ? ` (${y.focus})` : ''}${suffix}`;
    }
    case 'climb': {
      const c = plan.prescription?.climb ?? {};
      return `${e} Climbing${c.duration_min ? `  ·  ${c.duration_min} min` : ''}${c.style ? ` (${c.style})` : ''}${suffix}`;
    }
    case 'mobility': {
      const m = plan.prescription?.mobility;
      const d = Array.isArray(m) ? null : m?.duration_min;
      const focus = Array.isArray(m) ? null : m?.focus;
      return `${e} Mobility reset${d ? `  ·  ${d} min` : ''}${focus ? ` (${focus})` : ''}${suffix}`;
    }
    case 'sauna_cold': {
      const s = plan.prescription?.sauna_cold ?? {};
      return `${e} Sauna & cold plunge${s.rounds ? `  ·  ${s.rounds} rounds` : ''}${suffix}`;
    }
    case 'rest':
      return `${e} Rest day — recovery & sleep`;
    default:
      return `${e} ${humanizeExerciseId(plan.type)}${suffix}`;
  }
}

/* ─── description builder ─────────────────────────────────────────────── */

/** Small visual section header inside plain text (Google Calendar doesn't support Markdown). */
function section(title: string): string {
  return `━━━ ${title.toUpperCase()} ━━━`;
}

function describeGym(p: any, day_code: string | null | undefined): string {
  const parts: string[] = [];
  parts.push(section('The session'));
  parts.push(gymIntentFor(day_code));
  if (p?.notes_top) parts.push('', p.notes_top);

  parts.push('', section('Your work'));
  const blocks = p?.blocks ?? [];
  blocks.forEach((b: any, idx: number) => {
    const n = idx + 1;
    if (b.kind === 'single') {
      const name = humanizeExerciseId(b.exercise_id);
      const scheme = fmtScheme(b.set_scheme);
      const header = `${n}. ${name} — ${scheme}${b.weight_hint ? ` @ ${b.weight_hint}` : ''}`;
      const subs: string[] = [];
      if (b.rir_target != null) subs.push(rirNote(b.rir_target));
      if (b.rest_s != null) subs.push(restLine(b.rest_s));
      if (b.notes) subs.push(`Coach note: ${b.notes}`);
      parts.push(header);
      if (subs.length) parts.push('   ' + subs.filter(Boolean).join(' '));
    } else if (b.kind === 'superset') {
      parts.push(`${n}. Superset — ${b.rounds} round${b.rounds === 1 ? '' : 's'}${b.rest_between_s ? ` (rest ~${b.rest_between_s}s between rounds)` : ''}`);
      for (const it of b.items ?? []) {
        parts.push(`   ${it.letter}) ${humanizeExerciseId(it.exercise_id)} — ${fmtScheme(it.set_scheme)}${it.weight_hint ? ` @ ${it.weight_hint}` : ''}${it.notes ? `   //   ${it.notes}` : ''}`);
      }
      if (b.drop_set_on_last) {
        const pct = b.drop_set_on_last.drop_pct;
        parts.push(`   On the last round, strip ~${pct ?? 20}% of the load and keep going until technical failure — this is where adaptation lives.`);
      }
    }
  });

  parts.push('', section('How to execute'));
  parts.push('• Take 5–10 minutes to warm up and hit a ramp-up set on your first main lift.');
  parts.push('• If a set feels 2+ reps harder than expected, stop there and let the next set be the answer.');
  parts.push('• Log the session in the app right after your cooldown while the details are fresh.');
  if (p?.creatine_g) parts.push(`• Remember creatine today — ~${p.creatine_g}g with water or coffee.`);
  if (p?.estimated_minutes) parts.push(`• Budget: ≈ ${p.estimated_minutes} minutes end-to-end.`);

  return parts.filter((x) => x != null).join('\n');
}

function describeRun(p: any, day_code: string | null | undefined): string {
  const parts: string[] = [];
  const r = p?.run ?? {};
  parts.push(section('The session'));
  parts.push(runIntentFor(day_code));
  if (r.notes) parts.push('', r.notes);

  parts.push('', section('Target'));
  if (r.km ?? r.distance_km) parts.push(`Distance: ${r.km ?? r.distance_km} km`);
  if (r.duration_min) parts.push(`Duration: ${r.duration_min} min`);
  const pace = prettyPacePair(r.pace_s_per_km);
  if (pace) parts.push(`Pace: ${pace}`);
  if (r.effort) parts.push(`Effort: ${r.effort}`);
  if (r.zone) parts.push(`Zone: ${r.zone}`);
  if (r.warmup_km) parts.push(`Warm-up: ${r.warmup_km} km easy`);
  if (r.cooldown_km) parts.push(`Cool-down: ${r.cooldown_km} km easy`);

  if (r.intervals?.length) {
    parts.push('', section('Intervals'));
    for (const iv of r.intervals) {
      const work = iv.work_km ? `${iv.work_km} km` : iv.work_s ? `${iv.work_s}s` : '';
      const ivPace = prettyPacePair(iv.pace_s_per_km);
      const rest = iv.rest_s ? `${iv.rest_s}s float/jog` : '';
      parts.push(`• ${iv.repeats}× ${work}${ivPace ? ` @ ${ivPace}` : ''}${rest ? `, ${rest}` : ''}${iv.note ? `   //   ${iv.note}` : ''}`);
    }
  }
  if (r.route) parts.push('', `Suggested route: ${r.route}`);

  parts.push('', section('How to execute'));
  parts.push('• Check the weather and wear layers you can shed — warm-up should feel pleasantly warm, not hot.');
  parts.push('• Eat a small carb snack 30–60 min before anything harder than Z2.');
  parts.push('• Start the watch on time but give yourself the first 5–10 min as true warm-up — don\'t race the first split.');

  if (p.estimated_minutes) parts.push('', `≈ ${p.estimated_minutes} minutes total.`);
  return parts.join('\n');
}

function describeBike(p: any): string {
  const b = p?.bike ?? {};
  const lines: string[] = [];
  lines.push(section('The session'));
  lines.push(BIKE_INTENT);
  if (b.notes) lines.push('', b.notes);
  lines.push('', section('Target'));
  if (b.km ?? b.distance_km) lines.push(`Distance: ${b.km ?? b.distance_km} km`);
  if (b.duration_min) lines.push(`Duration: ${b.duration_min} min`);
  if (b.avg_power_w) lines.push(`Average power: ~${b.avg_power_w} W`);
  if (b.zone) lines.push(`Zone: ${b.zone}`);
  if (p.estimated_minutes) lines.push('', `≈ ${p.estimated_minutes} minutes total.`);
  return lines.join('\n');
}

function describeSwim(p: any): string {
  const s = p?.swim ?? {};
  const lines: string[] = [];
  lines.push(section('The session'));
  lines.push(SWIM_INTENT);
  if (s.notes) lines.push('', s.notes);
  lines.push('', section('Target'));
  if (s.distance_m) lines.push(`Distance: ${s.distance_m} m`);
  if (s.duration_min) lines.push(`Duration: ${s.duration_min} min`);
  if (s.stroke) lines.push(`Primary stroke: ${s.stroke}`);
  if (s.sets?.length) {
    lines.push('', section('Sets'));
    for (const set of s.sets) {
      lines.push(`• ${set.repeats}× ${set.distance_m}m${set.stroke ? ` ${set.stroke}` : ''}${set.rest_s ? `, rest ${set.rest_s}s` : ''}${set.pace ? ` @ ${set.pace}` : ''}`);
    }
  }
  return lines.join('\n');
}

function describeYoga(p: any): string {
  const y = p?.yoga ?? {};
  const lines: string[] = [];
  lines.push(section('The session'));
  lines.push(YOGA_INTENT);
  if (y.notes) lines.push('', y.notes);
  lines.push('', section('Focus'));
  if (y.duration_min) lines.push(`Duration: ${y.duration_min} min`);
  if (y.style) lines.push(`Style: ${y.style}`);
  if (y.focus) lines.push(`Focus: ${y.focus}`);
  return lines.join('\n');
}

function describeClimb(p: any): string {
  const c = p?.climb ?? {};
  const lines: string[] = [];
  lines.push(section('The session'));
  lines.push(CLIMB_INTENT);
  if (c.notes) lines.push('', c.notes);
  lines.push('', section('Plan'));
  if (c.duration_min) lines.push(`Duration: ${c.duration_min} min`);
  if (c.style) lines.push(`Style: ${c.style}`);
  if (c.grade_target) lines.push(`Grade target: ${c.grade_target}`);
  return lines.join('\n');
}

function describeMobility(p: any): string {
  const m = p?.mobility;
  const routine: any[] = Array.isArray(m) ? m.map((e: any) => (typeof e === 'string' ? { exercise: e } : e)) : (m?.routine ?? []);
  const duration = Array.isArray(m) ? null : m?.duration_min;
  const focus = Array.isArray(m) ? null : m?.focus;
  const lines: string[] = [];
  lines.push(section('The session'));
  lines.push(MOBILITY_INTENT);
  lines.push('', section('Routine'));
  if (duration) lines.push(`Duration: ${duration} min`);
  if (focus) lines.push(`Focus area: ${focus}`);
  if (routine.length) {
    lines.push('');
    routine.forEach((it: any, i: number) => {
      const t = it.duration_s ? `${it.duration_s}s` : it.reps ? `${it.reps} reps` : '';
      lines.push(`${i + 1}. ${humanizeExerciseId(it.exercise)}${t ? ` — ${t}` : ''}${it.notes ? `  (${it.notes})` : ''}`);
    });
  }
  return lines.join('\n');
}

function describeSaunaCold(p: any): string {
  const s = p?.sauna_cold ?? {};
  const lines: string[] = [];
  lines.push(section('The session'));
  lines.push(SAUNA_COLD_INTENT);
  if (s.notes) lines.push('', s.notes);
  lines.push('', section('Protocol'));
  if (s.rounds) lines.push(`Rounds: ${s.rounds}`);
  if (s.sauna_min_per_round) lines.push(`Sauna: ~${s.sauna_min_per_round} min/round`);
  if (s.cold_min_per_round) lines.push(`Cold: ~${s.cold_min_per_round} min/round`);
  return lines.join('\n');
}

function describeRest(p: any): string {
  const lines: string[] = [];
  lines.push(section('Rest day'));
  lines.push(
    'Today is deliberate recovery. Move gently if you want — a walk outside, 10 minutes of breathing, a cooking-while-standing kind of day — but do nothing that lights up the CNS. Sleep is the workout.'
  );
  if (p?.notes_top) lines.push('', p.notes_top);
  lines.push('', section('Checklist'));
  lines.push('• Aim for 8 hours in bed with lights low by 10 pm.');
  lines.push('• Eat enough — rest days still need protein. Don\'t under-fuel.');
  lines.push('• Hydration target: ~30–35 ml/kg body weight.');
  return lines.join('\n');
}

/* ─── public entry points ─────────────────────────────────────────────── */

export function buildDescription(
  plan: Plan,
  phase?: Phase,
  opts?: { appUrl?: string }
): string {
  const p = plan.prescription ?? {};
  let body = '';
  switch (plan.type) {
    case 'gym':        body = describeGym(p, plan.day_code); break;
    case 'run':        body = describeRun(p, plan.day_code); break;
    case 'bike':       body = describeBike(p); break;
    case 'swim':       body = describeSwim(p); break;
    case 'yoga':       body = describeYoga(p); break;
    case 'climb':      body = describeClimb(p); break;
    case 'mobility':   body = describeMobility(p); break;
    case 'sauna_cold': body = describeSaunaCold(p); break;
    case 'rest':       body = describeRest(p); break;
    default:
      body = `${section('The session')}\nA ${humanizeExerciseId(plan.type)} session. Follow your body; trust the phase.`;
  }

  const footer: string[] = ['', section('About this hold')];
  if (phase?.name || phase?.code) {
    footer.push(`Phase: ${phase.name ?? ''}${phase.code ? ` (${phase.code})` : ''}`.trim());
  }
  footer.push(
    'This event was placed on your calendar by your training app. Modify the session inside the app rather than here — calendar edits get reconciled on the next sync.'
  );
  if (opts?.appUrl) {
    footer.push(`Open the session: ${opts.appUrl}/today`);
  }

  return `${body}\n${footer.join('\n')}`;
}

export function buildEvent(plan: Plan, phase?: Phase, opts?: { appUrl?: string }) {
  return {
    summary: buildSummary(plan, phase),
    description: buildDescription(plan, phase, opts),
  };
}
