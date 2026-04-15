/**
 * Seed content — derived from:
 *   1. The trainer brief (the north star; what the user ultimately wants)
 *   2. The user's Google Calendar (P1/P2/P3 — the current hand-crafted program)
 *   3. The v0 gym log (recent actuals, Apr 2–14 2026)
 *
 * Design contract:
 *   - Trainer brief is STATIC north star. Rarely changes. AI consults it on every replan.
 *   - Phases P1/P2/P3 are SEEDED FROM CALENDAR. On first run the app imports these
 *     events verbatim as the source of intent.
 *   - P4+ does NOT exist yet. AI proposes P4 drafts when the user is 1-2 weeks from
 *     P3 ending, grounded in: brief + what was achieved in P1-P3 + macro-periodization.
 *   - RDL is NOT banned (it's central to P2/P3 Lower). exercise_prefs ships empty —
 *     the user populates as they learn their own preferences through the app.
 */

export const TRAINER_BRIEF = {
  profile: { name: 'Thibault', age: 29, height_m: 1.9, starting_kg: 79, current_kg: 85 },
  training_age: 'Beginner — started lifting January 2026',
  north_star: {
    short_term: [
      'Build muscle seriously — capture beginner gains',
      'Reach a lean, muscular, aesthetic physique',
    ],
    mid_term: [
      'Consolidate mass',
      'Lean out without losing strength',
    ],
    long_term: [
      'Triathlon-capable cardio base (run + bike + swim)',
      'Handstands and gymnastic body control',
      'Explosive skills eventually (e.g. backflips)',
      'Excellent mobility / flexibility',
    ],
    end_state: 'Lean, muscular, athletic-looking. Not bulky.',
  },
  limitations: [
    'Poor current mobility / flexibility',
    'Forearm/grip limits hanging core work',
    'Prior injury interruption through March 12, 2026 — P1 was the rebuild',
    'Tall (1.90 m) — hypertrophy visibility takes consistency',
  ],
  style_rules: [
    'Progressive overload in hypertrophy phases',
    'AI proposes, user approves — nothing auto-applies',
    'Calendar event descriptions are the source of intent for the current phase',
    'Within-phase tweaks are session-level; cross-phase shifts require user approval',
  ],
};

// ---------------------------------------------------------------------
// Phases — straight from the user's calendar. Dates taken from the
// recurring-event first/last occurrences discovered during calendar read.
// ---------------------------------------------------------------------
export const PHASES = [
  {
    code: 'P1',
    ordinal: 1,
    name: 'Foundation — post-injury rebuild',
    description:
      'Re-groove movement post-injury. 3 gym + 1 easy run / week. Quality over load, 2-3 RIR on every set.',
    source: 'calendar',
    starts_on: '2026-03-16',
    target_ends_on: '2026-03-29',
    actual_ends_on: '2026-03-29',
    status: 'completed' as const,
    nutrition_rules: { creatine_g: 5 },
    weekly_targets: {
      pull_ups: '4 × 3–4 reps (band-assisted ok)',
      incline_db_press: '3 × 10 @ 20–25 lb',
      ffe_split_squat: '3 × 8/leg @ 35–40 lb',
    },
  },
  {
    code: 'P2',
    ordinal: 2,
    name: 'Hypertrophy — volume & overload',
    description:
      'Full 4-gym split (Push / Pull / Lower / Upper Full) + easy run Wed + quality run Sat. Progressive overload. Pull-up EMOM weeks 3–5, max-rep sets weeks 6–7.',
    source: 'calendar',
    starts_on: '2026-03-30',
    target_ends_on: '2026-05-02',
    actual_ends_on: null,
    status: 'active' as const,
    nutrition_rules: { creatine_g: 5 },
    weekly_targets: {
      pull_ups: 'EMOM 10 min @ 2/min (wks 3–5) → 4–5 sets max reps (wks 6–7)',
      incline_db_press: 'Start 25 lb → aim 32–35 lb by week 7',
      seated_db_ohp: 'Start 25 lb → aim 30–35 lb by week 7',
      neutral_pulldown: 'Start 80 lb → aim 100–110 lb by week 7',
      chest_supported_row: 'Start 30 lb → aim 40–45 lb by week 7',
      ffe_split_squat: 'Start 40 lb → aim 55–60 lb by week 7',
    },
  },
  {
    code: 'P3',
    ordinal: 3,
    name: 'Density / Lean-Out — supersets',
    description:
      'Same 4-gym skeleton reorganized into supersets. Drop-sets on last round of key lifts. ~50 min sessions. Beat P2 weights on main movements. Pull-up goal: 7–9 reps/set by June.',
    source: 'calendar',
    starts_on: '2026-05-04',
    target_ends_on: '2026-06-28',   // ~8 weeks; confirm with user or extract from full calendar sweep
    actual_ends_on: null,
    status: 'upcoming' as const,
    nutrition_rules: {
      creatine_g: 5,
      protein_g_per_day: [160, 170],
      window: 'strict_mon_fri',
      carbs: 'tighten_on_rest_days',
    },
    weekly_targets: {
      pull_ups: '5 × max reps (stop 1 before failure). Goal 7–9/set by June.',
      incline_db_press: '4 × 8–10 @ 30–35+ lb',
      neutral_pulldown: '4 × 8–10 @ 100–110 lb',
      ffe_split_squat: '4 × 8/leg @ 55–65 lb',
      hip_thrust: '4 × 12 @ 95–135 lb',
    },
  },
  // P4+ deliberately left empty — AI drafts when P3 is near complete.
];

// ---------------------------------------------------------------------
// Calendar events — the hand-crafted intent. One entry per unique recurring
// event series. This is what the first-run calendar import will produce.
// Shape matches calendar_events.prescription + calendar_events metadata.
// ---------------------------------------------------------------------
export const CALENDAR_EVENT_TEMPLATES = [
  // ---- P2 (currently active) ----
  {
    phase_code: 'P2', day_type: 'gym', day_code: 'push', day_of_week: 'MO',
    google_event_id: 's3itfcle6utqaqvn8jc0ducptc',
    summary: '💪 P2 — Push Day: Chest + Shoulders + Triceps',
    estimated_minutes: 55,
    notes_top: 'Progressive overload — beat at least ONE number (weight or reps) vs last session.',
    blocks: [
      { kind: 'single', position: 1, exercise_id: 'incline_db_press',
        set_scheme: { type: 'standard', sets: 4, reps: '8-10' },
        weight_hint: '25 → 32-35 lb by wk 7', rest_s: 90, rir_target: 2,
        notes: '45° incline. 2-sec descent. Upper chest, not shoulders.' },
      { kind: 'single', position: 2, exercise_id: 'flat_db_press',
        set_scheme: { type: 'standard', sets: 3, reps: '10-12' },
        weight_hint: '20-30 lb', rest_s: 75, rir_target: 2,
        notes: 'Or cable chest fly. Full stretch at bottom.' },
      { kind: 'single', position: 3, exercise_id: 'seated_db_ohp',
        set_scheme: { type: 'standard', sets: 4, reps: '8-10' },
        weight_hint: '25 → 30-35 lb by wk 7', rest_s: 120, rir_target: 2,
        notes: 'Primary shoulder mass builder. No shrugging.' },
      { kind: 'single', position: 4, exercise_id: 'db_lateral_raise',
        set_scheme: { type: 'standard', sets: 4, reps: '12-15' },
        weight_hint: '8-12 lb', rest_s: 60, rir_target: 1,
        notes: 'KEY for shoulder caps. Lead with elbow. No momentum.' },
      { kind: 'single', position: 5, exercise_id: 'face_pull',
        set_scheme: { type: 'standard', sets: 3, reps: '15' },
        weight_hint: 'light', rest_s: 60, rir_target: 2,
        notes: 'DO NOT SKIP. Elbows high. Rear delt + posture.' },
      { kind: 'single', position: 6, exercise_id: 'tricep_pressdown',
        set_scheme: { type: 'standard', sets: 3, reps: '12-15' },
        weight_hint: '35-45 lb', rest_s: 60, rir_target: 1 },
      { kind: 'single', position: 7, exercise_id: 'hanging_knee_raise',
        set_scheme: { type: 'standard', sets: 3, reps: '10-12' },
        weight_hint: 'BW', rest_s: 60 },
    ],
    creatine_g: 5,
  },
  {
    phase_code: 'P2', day_type: 'gym', day_code: 'pull', day_of_week: 'TU',
    google_event_id: 'ng1pl08oi85k9jis18su99117c',
    summary: '🔵 P2 — Pull Day: Back + Biceps + Pull-Ups',
    estimated_minutes: 60,
    notes_top: 'PULL-UPS FIRST when freshest. Track pull-up reps every session — #1 metric.',
    blocks: [
      { kind: 'single', position: 1, exercise_id: 'pull_ups_emom',
        set_scheme: { type: 'emom', minutes: 10, reps_per_min: 2, total_reps: 20 },
        weight_hint: 'BW', rir_target: 3,
        notes: 'Weeks 3-5 protocol. Weeks 6-7: switch to 4-5 sets × max reps, 2 min rest.' },
      { kind: 'single', position: 2, exercise_id: 'neutral_pulldown',
        set_scheme: { type: 'standard', sets: 4, reps: '8-10' },
        weight_hint: '80 → 100-110 lb by wk 7', rest_s: 90, rir_target: 2 },
      { kind: 'single', position: 3, exercise_id: 'chest_supported_row',
        set_scheme: { type: 'standard', sets: 4, reps: '10' },
        weight_hint: '30 → 40-45 lb by wk 7', rest_s: 90, rir_target: 2 },
      { kind: 'single', position: 4, exercise_id: 'single_arm_row',
        set_scheme: { type: 'standard', sets: 3, reps: '10/side' },
        weight_hint: '30-50 lb', rest_s: 90, rir_target: 2 },
      { kind: 'single', position: 5, exercise_id: 'incline_db_curl',
        set_scheme: { type: 'standard', sets: 3, reps: '10' },
        weight_hint: '20 → 22-25 lb', rest_s: 75, rir_target: 1 },
      { kind: 'single', position: 6, exercise_id: 'hammer_curl',
        set_scheme: { type: 'standard', sets: 2, reps: '12' },
        weight_hint: '20-25 lb', rest_s: 60 },
      { kind: 'single', position: 7, exercise_id: 'side_plank',
        set_scheme: { type: 'time', sets: 2, seconds_per_side: 60 },
        rest_s: 30 },
    ],
    creatine_g: 5,
  },
  {
    phase_code: 'P2', day_type: 'run', day_code: 'easy_run', day_of_week: 'WE',
    google_event_id: 'a45epafvh9h5e8osih5hkcm9g0',
    summary: '🏃 P2 — Easy Run + Mobility',
    estimated_minutes: 35,
    notes_top: 'Recovery, not training. Keep it easy.',
    run: { km: 5, pace_s_per_km: [330, 360], effort: 'conversational 65-70% HR' },
    mobility: [
      'Half-kneeling hip flexor 45s/side',
      '90/90 hip 60s/side',
      'T-spine foam roll 90s',
      'Wall slides x10 slow',
      'Ankle wall stretch 30s/side',
      'Standing forward fold 60s',
    ],
    creatine_g: 5,
  },
  {
    phase_code: 'P2', day_type: 'gym', day_code: 'lower', day_of_week: 'TH',
    google_event_id: 'm6ndoq4o080t1kkj4duspec3ls',
    summary: '🥒 P2 — Lower Day: Legs + Core',
    estimated_minutes: 55,
    notes_top: 'Athletic lower body. Glute/hamstring dominant. Strength + power, not mass.',
    blocks: [
      { kind: 'single', position: 1, exercise_id: 'ffe_split_squat',
        set_scheme: { type: 'standard', sets: 4, reps: '8/leg' },
        weight_hint: '40 → 55-60 lb by wk 7', rest_s: 120, rir_target: 1 },
      { kind: 'single', position: 2, exercise_id: 'rdl_barbell',
        set_scheme: { type: 'standard', sets: 3, reps: '10' },
        weight_hint: '40-60 lb DBs', rest_s: 120, rir_target: 2,
        notes: '3-SEC SLOW DESCENT. Hips back, not knees down. Feel hamstring stretch.' },
      { kind: 'single', position: 3, exercise_id: 'hamstring_curl',
        set_scheme: { type: 'standard', sets: 4, reps: '10-12' },
        weight_hint: '80 → progress every session', rest_s: 90, rir_target: 1 },
      { kind: 'single', position: 4, exercise_id: 'hip_thrust',
        set_scheme: { type: 'standard', sets: 3, reps: '12' },
        weight_hint: '45-95 lb', rest_s: 90, rir_target: 1 },
      { kind: 'single', position: 5, exercise_id: 'calf_raise',
        set_scheme: { type: 'standard', sets: 3, reps: '15' },
        weight_hint: '50-60 lb', rest_s: 60,
        notes: 'FULL range. 3-sec eccentric. No bounce.' },
      { kind: 'single', position: 6, exercise_id: 'dead_bug',
        set_scheme: { type: 'standard', sets: 3, reps: '8/side' },
        rest_s: 45 },
      { kind: 'single', position: 7, exercise_id: 'hanging_leg_raise',
        set_scheme: { type: 'standard', sets: 3, reps: '10' },
        rest_s: 60 },
    ],
    creatine_g: 5,
  },
  {
    phase_code: 'P2', day_type: 'gym', day_code: 'upper_full', day_of_week: 'FR',
    google_event_id: '5ub469ohg0lq32fk8705lpll60',
    summary: '💪 P2 — Upper Full: Arms + Shoulders',
    estimated_minutes: 55,
    notes_top: 'Arm aesthetics, shoulder 3D look, pull-up frequency.',
    blocks: [
      { kind: 'single', position: 1, exercise_id: 'pull_ups_quality',
        set_scheme: { type: 'standard', sets: 3, reps: 'max-2' },
        weight_hint: 'BW', rest_s: 120, rir_target: 2,
        notes: 'Stop 2 reps before failure. Strict form.' },
      { kind: 'single', position: 2, exercise_id: 'db_lateral_raise',
        set_scheme: { type: 'standard', sets: 4, reps: '12-15' },
        weight_hint: '8-12 lb', rest_s: 60 },
      { kind: 'single', position: 3, exercise_id: 'rear_delt_fly',
        set_scheme: { type: 'standard', sets: 3, reps: '15' },
        weight_hint: 'light', rest_s: 60 },
      { kind: 'single', position: 4, exercise_id: 'incline_db_curl',
        set_scheme: { type: 'standard', sets: 3, reps: '10' },
        weight_hint: '20-22 lb', rest_s: 75 },
      { kind: 'single', position: 5, exercise_id: 'overhead_tricep_ext',
        set_scheme: { type: 'standard', sets: 3, reps: '12' },
        weight_hint: '20-35 lb', rest_s: 75 },
      { kind: 'single', position: 6, exercise_id: 'tricep_pressdown',
        set_scheme: { type: 'standard', sets: 2, reps: '12-15' },
        weight_hint: '35-45 lb', rest_s: 60 },
      { kind: 'single', position: 7, exercise_id: 'ab_circuit',
        set_scheme: { type: 'circuit', rounds: 2,
                      items: ['plank_45s', 'crunches_15', 'side_plank_30s_per_side'] },
        rest_s: 60 },
    ],
    creatine_g: 5,
  },
  {
    phase_code: 'P2', day_type: 'run', day_code: 'quality_run', day_of_week: 'SA',
    google_event_id: '1a0gb3ghetk0dcrvq8cvu10drs',
    summary: '🏃 P2 — Quality Run (Tempo or Intervals)',
    estimated_minutes: 35,
    notes_top: 'The one hard cardio session. Skip if legs are very sore from Thursday.',
    run: {
      options: [
        { name: 'tempo', km: 4, pace_s_per_km: [290, 310] },
        { name: 'intervals', warmup_km: 1, sets: 3, interval_km: 1, interval_pace_s_per_km: [280, 290], rest_s: 90, cooldown_km: 1 },
      ],
    },
    creatine_g: 5,
  },

  // ---- P3 (upcoming) — starts 2026-05-04 ----
  {
    phase_code: 'P3', day_type: 'gym', day_code: 'push', day_of_week: 'MO',
    google_event_id: 'a44quevmst3n8k86sgc6h8c8kg',
    summary: '🔥 P3 — Push Day: Supersets (High Density)',
    estimated_minutes: 50,
    notes_top: 'Supersets. Rest BETWEEN supersets, not within. Beat P2 weights on main movements.',
    blocks: [
      { kind: 'superset', position: 1, rounds: 4, rest_between_s: 75,
        drop_set_on_last: { apply_to_letter: 'A', drop_pct: 20, to_near_failure: true },
        items: [
          { letter: 'A', exercise_id: 'incline_db_press',
            set_scheme: { type: 'standard', reps: '8-10' }, weight_hint: '30-35+ lb' },
          { letter: 'B', exercise_id: 'chest_supported_row',
            set_scheme: { type: 'standard', reps: '10' }, weight_hint: '40-45 lb' },
        ] },
      { kind: 'superset', position: 2, rounds: 3, rest_between_s: 60,
        items: [
          { letter: 'A', exercise_id: 'seated_db_ohp',
            set_scheme: { type: 'standard', reps: '8-10' }, weight_hint: '28-32 lb' },
          { letter: 'B', exercise_id: 'db_lateral_raise',
            set_scheme: { type: 'standard', reps: '12-15' }, weight_hint: '10-14 lb' },
        ] },
      { kind: 'superset', position: 3, rounds: 3, rest_between_s: 60,
        items: [
          { letter: 'A', exercise_id: 'face_pull',
            set_scheme: { type: 'standard', reps: '15' } },
          { letter: 'B', exercise_id: 'tricep_pressdown',
            set_scheme: { type: 'standard', reps: '12-15' }, weight_hint: '40-50 lb' },
        ] },
      { kind: 'single', position: 4, exercise_id: 'hanging_leg_raise',
        set_scheme: { type: 'standard', sets: 3, reps: '12' }, rest_s: 60 },
    ],
    creatine_g: 5,
  },
  {
    phase_code: 'P3', day_type: 'gym', day_code: 'pull', day_of_week: 'TU',
    google_event_id: 'u42lm0kcvr2pj520d0j09eap18',
    summary: '🔥 P3 — Pull Day: Supersets + Pull-Ups',
    estimated_minutes: 55,
    notes_top: 'Pull-ups first, max reps. LOG every rep — goal 7-9/set by June.',
    blocks: [
      { kind: 'single', position: 1, exercise_id: 'pull_ups_quality',
        set_scheme: { type: 'standard', sets: 5, reps: 'max-1' },
        weight_hint: 'BW', rest_s: 120, rir_target: 1 },
      { kind: 'superset', position: 2, rounds: 4, rest_between_s: 75,
        drop_set_on_last: { apply_to_letter: 'A', drop_pct: 20, to_near_failure: true },
        items: [
          { letter: 'A', exercise_id: 'neutral_pulldown',
            set_scheme: { type: 'standard', reps: '8-10' }, weight_hint: '100-110 lb' },
          { letter: 'B', exercise_id: 'single_arm_row',
            set_scheme: { type: 'standard', reps: '10/side' } },
        ] },
      { kind: 'superset', position: 3, rounds: 3, rest_between_s: 60,
        items: [
          { letter: 'A', exercise_id: 'chest_supported_row',
            set_scheme: { type: 'standard', reps: '10' }, weight_hint: '40-45 lb' },
          { letter: 'B', exercise_id: 'face_pull',
            set_scheme: { type: 'standard', reps: '15' } },
        ] },
      { kind: 'superset', position: 4, rounds: 3, rest_between_s: 60,
        items: [
          { letter: 'A', exercise_id: 'incline_db_curl',
            set_scheme: { type: 'standard', reps: '10' }, weight_hint: '20-25 lb' },
          { letter: 'B', exercise_id: 'hammer_curl',
            set_scheme: { type: 'standard', reps: '12' }, weight_hint: '20-25 lb' },
        ] },
      { kind: 'single', position: 5, exercise_id: 'side_plank',
        set_scheme: { type: 'time', sets: 2, seconds_per_side: 60 }, rest_s: 30 },
    ],
    creatine_g: 5,
  },
  {
    phase_code: 'P3', day_type: 'run', day_code: 'easy_run', day_of_week: 'WE',
    google_event_id: '62n7po1shurk9nk55bl3ursr60',
    summary: '🏃 P3 — Easy Run + Mobility',
    estimated_minutes: 35,
    notes_top: 'Active recovery. Protect energy for lifting.',
    run: { km: 5, pace_s_per_km: [330, 360], effort: 'conversational' },
    mobility: [
      'Half-kneeling hip flexor 45s/side',
      '90/90 hip 60s/side',
      'T-spine foam roll 90s',
      'Wall slides x10 slow',
      'Ankle wall stretch 30s/side',
      'Standing forward fold 60s',
    ],
    creatine_g: 5,
    nutrition_note: 'Keep clean Mon-Fri. Protein 160-170g/day.',
  },
  {
    phase_code: 'P3', day_type: 'gym', day_code: 'lower', day_of_week: 'TH',
    google_event_id: '98a5e3isgr9e4ll56a38leddck',
    summary: '🔥 P3 — Lower Day: Supersets',
    estimated_minutes: 50,
    notes_top: 'Supersets applied. Push weights from P2.',
    blocks: [
      { kind: 'superset', position: 1, rounds: 4, rest_between_s: 120,
        items: [
          { letter: 'A', exercise_id: 'ffe_split_squat',
            set_scheme: { type: 'standard', reps: '8/leg' }, weight_hint: '55-65 lb' },
          { letter: 'B', exercise_id: 'hip_thrust',
            set_scheme: { type: 'standard', reps: '12' }, weight_hint: '95-135 lb' },
        ] },
      { kind: 'single', position: 2, exercise_id: 'rdl_barbell',
        set_scheme: { type: 'standard', sets: 3, reps: '10' },
        weight_hint: '50-70 lb DBs', rest_s: 120, rir_target: 2,
        notes: '3-SEC SLOW DESCENT. Non-negotiable.' },
      { kind: 'superset', position: 3, rounds: 3, rest_between_s: 75,
        drop_set_on_last: { apply_to_letter: 'A', drop_pct: 20, to_near_failure: true },
        items: [
          { letter: 'A', exercise_id: 'hamstring_curl',
            set_scheme: { type: 'standard', reps: '10-12' }, weight_hint: '100-120 lb' },
          { letter: 'B', exercise_id: 'calf_raise',
            set_scheme: { type: 'standard', reps: '15' }, weight_hint: '55-65 lb' },
        ] },
      { kind: 'single', position: 4, exercise_id: 'hanging_leg_raise',
        set_scheme: { type: 'standard', sets: 3, reps: '12' }, rest_s: 60 },
      { kind: 'single', position: 5, exercise_id: 'dead_bug',
        set_scheme: { type: 'standard', sets: 3, reps: '8/side' }, rest_s: 45 },
    ],
    creatine_g: 5,
  },
];

export const PROGRAM_CONFIG = {
  split: {
    // Phase-aware mapping: day_code → which template applies given active phase.
    // The actual prescription is looked up by (phase_code, day_code) from CALENDAR_EVENT_TEMPLATES.
    weekly_pattern: {
      MO: { type: 'gym', day_code: 'push' },
      TU: { type: 'gym', day_code: 'pull' },
      WE: { type: 'run', day_code: 'easy_run' },
      TH: { type: 'gym', day_code: 'lower' },
      FR: { type: 'gym', day_code: 'upper_full' },   // P1 had Upper B here; P2/P3 is Upper Full
      SA: { type: 'run', day_code: 'quality_run' },
      SU: { type: 'rest', day_code: null },
    },
  },
  weekly_cardio_target: { runs_per_week: 2, easy_km: 5, quality_km: 4 },
};

// Exercise preferences — ships empty. The user populates via the app as they learn.
// RDL was PREVIOUSLY assumed banned; that was wrong. It's central to P2/P3 Lower.
export const EXERCISE_PREFS: Array<{
  exercise_id: string; label: string;
  status: 'liked' | 'neutral' | 'banned'; reason?: string;
}> = [];

// ---------------------------------------------------------------------
// Recent actuals — last ~2 weeks from the v0 log. Used to prove the app
// end-to-end and give "last time" hints on day one.
// ---------------------------------------------------------------------
export const SEED_HISTORY = [
  {
    date: '2026-04-14', type: 'gym' as const, status: 'done' as const, sentiment: 3,
    notes: 'Arms cooked quickly. 30 lb chest rows too easy — bump to 35 next pull day.',
    data: { day_code: 'pull', sets: {
      pull_ups_emom: Array.from({length:10}, () => ({ w:0, r:2, rir:3 })),
      neutral_pulldown: [{w:90,r:10,rir:2},{w:90,r:10,rir:2},{w:90,r:10,rir:1},{w:90,r:10,rir:1}],
      chest_supported_row: [{w:30,r:10,rir:3,note:'too easy'},{w:30,r:10,rir:3},{w:30,r:10,rir:3},{w:30,r:10,rir:3}],
      single_arm_row: [{w:40,r:10,rir:2},{w:40,r:10,rir:2},{w:50,r:10,rir:1}],
      incline_db_curl: [{w:22.5,r:8,rir:0,note:'failure'},{w:20,r:6,rir:0,note:'failure on 7'},{w:17.5,r:6,rir:0,note:'failure on 7'}],
      hammer_curl: [{w:17.5,r:12,rir:1},{w:17.5,r:12,rir:1}],
      side_plank: [{w:0,r:60,rir:1},{w:0,r:60,rir:1}],
    }},
  },
  {
    date: '2026-04-13', type: 'gym' as const, status: 'done' as const, sentiment: 4,
    notes: 'Good push session. OHP set 1 at 30 lb felt heavy — drop back to 25 and build volume first.',
    data: { day_code: 'push', sets: {
      incline_db_press: [{w:25,r:10,rir:3},{w:25,r:10,rir:3},{w:25,r:10,rir:3},{w:30,r:10,rir:0,note:'close to failure'}],
      flat_db_press: [{w:25,r:10,rir:2},{w:25,r:10,rir:2},{w:25,r:10,rir:2}],
      seated_db_ohp: [{w:30,r:8,rir:0},{w:25,r:9,rir:0},{w:25,r:8,rir:1},{w:25,r:6,rir:0,note:'failed on 7'}],
      db_lateral_raise: [{w:12.5,r:12,rir:0},{w:10,r:14,rir:0},{w:10,r:12,rir:1},{w:10,r:10,rir:1}],
      face_pull: [{w:25,r:15,rir:1},{w:25,r:15,rir:1},{w:25,r:15,rir:1}],
      tricep_pressdown: [{w:35,r:15,rir:2},{w:40,r:15,rir:1},{w:45,r:12,rir:1}],
      hanging_knee_raise: [{w:0,r:12,rir:2},{w:0,r:12,rir:1},{w:0,r:12,rir:0,note:'forearms fail'}],
    }},
  },
  {
    date: '2026-04-10', type: 'gym' as const, status: 'done' as const, sentiment: 4,
    notes: 'Light day, good volume.',
    data: { day_code: 'upper_full', sets: {
      pull_ups_quality: [{w:0,r:4,rir:2},{w:0,r:4,rir:2},{w:0,r:4,rir:2}],
      db_lateral_raise: [{w:10,r:13,rir:1},{w:10,r:13,rir:1},{w:10,r:13,rir:1},{w:10,r:12,rir:1}],
      rear_delt_fly: [{w:10,r:15,rir:2},{w:10,r:15,rir:2},{w:10,r:15,rir:2}],
      incline_db_curl: [{w:20,r:10,rir:1},{w:20,r:10,rir:1},{w:20,r:10,rir:1}],
      overhead_tricep_ext: [{w:25,r:12,rir:1},{w:25,r:12,rir:1},{w:25,r:12,rir:1}],
      tricep_pressdown: [{w:25,r:15,rir:1},{w:25,r:15,rir:1}],
    }},
  },
  {
    date: '2026-04-09', type: 'gym' as const, status: 'done' as const, sentiment: 4,
    notes: 'Switched to lying hamstring curl — way better engagement. Reset weight.',
    data: { day_code: 'lower', sets: {
      ffe_split_squat: [{w:40,r:8,rir:1},{w:40,r:8,rir:1},{w:40,r:8,rir:1},{w:40,r:8,rir:0}],
      rdl_barbell: [{w:40,r:10,rir:2},{w:50,r:10,rir:1},{w:60,r:10,rir:1}],
      hamstring_curl: [{w:65,r:12,rir:2,note:'first time on LYING curl'},{w:65,r:12,rir:1},{w:65,r:12,rir:1},{w:65,r:10,rir:0}],
      hip_thrust: [{w:55,r:12,rir:1},{w:55,r:12,rir:1},{w:55,r:12,rir:1}],
      calf_raise: [{w:55,r:15,rir:1},{w:55,r:15,rir:1},{w:55,r:15,rir:1}],
    }},
  },
  {
    date: '2026-04-08', type: 'run' as const, status: 'done' as const, sentiment: 4, notes: '',
    data: { distance_km: 5, duration_s: 1645, avg_pace_s_per_km: 329, rpe: 5 },
  },
  {
    date: '2026-04-07', type: 'gym' as const, status: 'done' as const, sentiment: 3, notes: '',
    data: { day_code: 'pull', sets: {
      pull_ups_emom: Array.from({length:10}, () => ({ w:0, r:2, rir:3 })),
      neutral_pulldown: [{w:80,r:10,rir:2},{w:80,r:10,rir:2},{w:80,r:10,rir:1},{w:80,r:10,rir:1}],
      chest_supported_row: [{w:30,r:10,rir:2},{w:30,r:10,rir:2},{w:30,r:10,rir:2},{w:30,r:10,rir:2}],
      single_arm_row: [{w:35,r:10,rir:2},{w:35,r:10,rir:2},{w:35,r:10,rir:2}],
      incline_db_curl: [{w:20,r:9,rir:0},{w:20,r:7,rir:0},{w:15,r:8,rir:0}],
      hammer_curl: [{w:20,r:12,rir:1},{w:25,r:12,rir:0}],
      side_plank: [{w:0,r:60,rir:1},{w:0,r:60,rir:1}],
    }},
  },
  {
    date: '2026-04-06', type: 'run' as const, status: 'done' as const, sentiment: 3, notes: '',
    data: { distance_km: 5, duration_s: 1700, avg_pace_s_per_km: 340, rpe: 4 },
  },
  {
    date: '2026-04-05', type: 'gym' as const, status: 'done' as const, sentiment: 4, notes: '',
    data: { day_code: 'push', sets: {
      incline_db_press: [{w:30,r:10,rir:1},{w:30,r:10,rir:1},{w:30,r:9,rir:0},{w:30,r:8,rir:0}],
      flat_db_press: [{w:20,r:12,rir:1},{w:20,r:12,rir:1},{w:20,r:12,rir:1}],
      seated_db_ohp: [{w:25,r:10,rir:1},{w:25,r:10,rir:1},{w:25,r:9,rir:0},{w:25,r:8,rir:0}],
      db_lateral_raise: [{w:10,r:12,rir:1},{w:10,r:12,rir:1},{w:10,r:12,rir:1},{w:10,r:12,rir:1}],
      face_pull: [{w:0,r:15,rir:1},{w:0,r:15,rir:1},{w:0,r:15,rir:1}],
      tricep_pressdown: [{w:35,r:15,rir:1},{w:35,r:15,rir:1},{w:35,r:15,rir:1}],
      hanging_knee_raise: [{w:0,r:12,rir:1},{w:0,r:12,rir:1},{w:0,r:10,rir:1}],
    }},
  },
  {
    date: '2026-04-03', type: 'gym' as const, status: 'done' as const, sentiment: 4, notes: '',
    data: { day_code: 'upper_full', sets: {
      pull_ups_quality: [{w:0,r:3,rir:2},{w:0,r:3,rir:2},{w:0,r:3,rir:2}],
      db_lateral_raise: [{w:10,r:13,rir:1},{w:10,r:13,rir:1},{w:10,r:13,rir:1},{w:10,r:13,rir:1}],
      rear_delt_fly: [{w:20,r:15,rir:2},{w:20,r:15,rir:2},{w:20,r:15,rir:2}],
      incline_db_curl: [{w:20,r:10,rir:0},{w:20,r:10,rir:0},{w:20,r:6,rir:0,note:'failure'}],
      overhead_tricep_ext: [{w:25,r:12,rir:1},{w:25,r:12,rir:1},{w:25,r:12,rir:1}],
      tricep_pressdown: [{w:45,r:12,rir:1},{w:45,r:12,rir:1}],
    }},
  },
  {
    date: '2026-04-02', type: 'gym' as const, status: 'done' as const, sentiment: 4, notes: '',
    data: { day_code: 'lower', sets: {
      ffe_split_squat: [{w:40,r:8,rir:1},{w:40,r:8,rir:1},{w:40,r:8,rir:1},{w:40,r:8,rir:1}],
      hamstring_curl: [{w:90,r:12,rir:1,note:'seated version (pre Apr-9 switch)'},{w:90,r:12,rir:1},{w:90,r:10,rir:0},{w:90,r:10,rir:0}],
      hip_thrust: [{w:50,r:12,rir:1},{w:50,r:12,rir:1},{w:50,r:12,rir:1}],
      calf_raise: [{w:50,r:15,rir:1},{w:50,r:15,rir:1},{w:50,r:15,rir:1}],
    }},
  },
];
