-- =====================================================================
-- Seed data — exercises catalog (shared, no user_id)
-- =====================================================================
-- User-specific seeds (program config, phases, history, prefs) are applied
-- by src/lib/seed/user-seed.ts on first sign-in, because they need the
-- auth.users id, which doesn't exist until the user authenticates.
-- =====================================================================

insert into exercises_catalog (id, name, primary_muscles, equipment, default_cues) values
  ('incline_db_press',    'Incline DB Press',            '{chest,front_delt,tricep}', '{dumbbell,bench}', '45° incline. Elbows at 45° from torso. 2-sec descent. Feel upper chest, not shoulders.'),
  ('flat_db_press',       'Flat DB Press',               '{chest,tricep,front_delt}', '{dumbbell,bench}', 'Slight arch. Drive up to lockout.'),
  ('seated_db_ohp',       'Seated DB Overhead Press',    '{front_delt,side_delt,tricep}', '{dumbbell,bench}', 'No shrugging. Full 2-min rest. Press to just above head.'),
  ('db_lateral_raise',    'DB Lateral Raise',            '{side_delt}', '{dumbbell}', 'Lead with elbow. Stop at shoulder height. No momentum.'),
  ('cable_lateral_raise', 'Cable Lateral Raise',         '{side_delt}', '{cable}', 'Stack minimum may be too light. Prefer DB version.'),
  ('face_pull',           'Face Pull',                   '{rear_delt,rotator_cuff}', '{cable,rope}', 'Elbows high. Pull to face. Externally rotate at end.'),
  ('rear_delt_fly',       'Cable Rear Delt Fly',         '{rear_delt}', '{cable}', 'Full arc. Squeeze rear delt at end.'),
  ('tricep_pressdown',    'Tricep Pressdown',            '{tricep}', '{cable,rope}', 'Elbows pinned. Full extension at bottom.'),
  ('overhead_tricep_ext', 'Overhead Tricep Extension',   '{tricep_long_head}', '{dumbbell,cable}', 'Elbows narrow. Full stretch to full lockout.'),
  ('pull_ups_emom',       'Pull-Ups — EMOM',             '{lat,bicep,mid_back}', '{bar}', 'EMOM protocol. 2 strict reps/min for 10 min. Strict form; chin over bar.'),
  ('pull_ups_quality',    'Pull-Ups (Quality)',          '{lat,bicep,mid_back}', '{bar}', 'Strict only. Full hang. Stop 2 reps before failure.'),
  ('neutral_pulldown',    'Neutral Grip Lat Pulldown',   '{lat,bicep}', '{machine}', 'Full stretch at top. Pull to upper chest. Don''t rock body.'),
  ('chest_supported_row', 'Chest Supported DB Row',      '{mid_back,lat,bicep}', '{dumbbell,bench}', 'Shoulder blades retract first, then arms pull.'),
  ('single_arm_row',      'Single-Arm Cable Row',        '{mid_back,lat,bicep}', '{cable}', 'Brace core. Row to hip. Don''t rotate torso.'),
  ('incline_db_curl',     'Incline DB Curl',             '{bicep_long_head}', '{dumbbell,bench}', 'Fully reclined. Full arm hang. Slow controlled curl.'),
  ('hammer_curl',         'Hammer Curl',                 '{brachialis,bicep}', '{dumbbell}', 'Neutral grip. No swing.'),
  ('ffe_split_squat',     'Front-Foot Elevated Split Squat','{quad,glute}', '{dumbbell,platform}', 'Front foot on 4–6" platform. Back knee straight down. Front knee tracks 2nd toe.'),
  ('sl_rdl',              'Single-Leg RDL',              '{hamstring,glute}', '{dumbbell}', 'Balance hand on rack if needed. Hinge from hips. Feel hamstring.'),
  ('rdl_barbell',         'Romanian Deadlift (barbell)', '{hamstring,glute,lower_back}', '{barbell}', 'Hinge from hips. Soft knee bend. Many lifters find this hard to feel in hamstrings.'),
  ('hamstring_curl',      'Hamstring Curl (lying)',      '{hamstring}', '{machine}', '2-sec return. Hips stay on pad. Lying version > seated for hamstring engagement.'),
  ('hip_thrust',          'Hip Thrust',                  '{glute,hamstring}', '{barbell,bench}', 'Upper back on bench. Drive hips fully up. Hard glute squeeze, 1-sec hold.'),
  ('calf_raise',          'Standing Calf Raise',         '{calf}', '{machine}', 'Full range. 3-sec eccentric. Pause at stretch.'),
  ('hanging_knee_raise',  'Hanging Knee Raise',          '{abs,hip_flexor}', '{bar}', 'Controlled. Progress toward straight-leg.'),
  ('side_plank',          'Side Plank',                  '{obliques,core}', '{bodyweight}', 'Hips stacked. Don''t let hips drop.'),
  ('ab_circuit',          'Ab Circuit',                  '{core}', '{bodyweight}', 'Plank + crunches + side plank circuit.')
on conflict (id) do update set
  name = excluded.name,
  primary_muscles = excluded.primary_muscles,
  equipment = excluded.equipment,
  default_cues = excluded.default_cues;
