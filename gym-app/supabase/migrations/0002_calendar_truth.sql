-- =====================================================================
-- Gym v1 — migration 0002: align schema with Google Calendar ground truth
-- =====================================================================
-- Changes:
--   * phases: add code, nutrition_rules, weekly_targets
--   * plans/activities prescription supports supersets, drop-sets, EMOM sets,
--     per-exercise progression targets (encoded in jsonb — no schema change)
--   * calendar_events: table to mirror the user's existing calendar events
--     (the source of intent). Supports import + reconciliation loop.
--   * profiles.brief: already jsonb; no change needed — but we document the shape.

-- ---------------------------------------------------------------------
-- phases: phase code (P1/P2/P3/P4...) + nutrition + weekly-pullup goal etc.
-- ---------------------------------------------------------------------
alter table phases
  add column if not exists code text,                        -- 'P1' | 'P2' | 'P3' | 'P4' ...
  add column if not exists nutrition_rules jsonb default '{}'::jsonb,
                                                             -- { protein_g_per_day: 165, creatine_g: 5,
                                                             --   carbs: "tighten_rest_days", window: "mon_fri_strict" }
  add column if not exists weekly_targets jsonb default '{}'::jsonb,
                                                             -- { pull_ups: "5x max, 5-7 reps/set by week X",
                                                             --   incline_db: "30-35 lb by week 7" }
  add column if not exists source text default 'calendar';   -- 'calendar' | 'ai_proposed' | 'manual'

create unique index if not exists phases_user_code_uq on phases(user_id, code) where code is not null;

-- ---------------------------------------------------------------------
-- calendar_events: mirror of the user's existing gym events in Google Calendar.
-- This is the source of INTENT (the hand-crafted program). The `plans` table
-- is the materialized per-day prescription derived from this + AI adjustments.
-- ---------------------------------------------------------------------
create table if not exists calendar_events (
  id                  uuid primary key default uuid_generate_v4(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  phase_id            uuid references phases(id) on delete set null,
  google_calendar_id  text not null,
  google_event_id     text not null,                         -- recurring event master id
  summary             text not null,                         -- '💪 P2 — Push Day: ...'
  description_raw     text,                                  -- full text of the event description
  prescription        jsonb not null default '{}'::jsonb,    -- parsed structure (see shape below)
  day_type            activity_type not null default 'gym',
  day_code            text,                                  -- 'push' | 'pull' | 'lower' | 'upper_full' | 'easy_run' | 'quality_run'
  recurrence          jsonb,                                 -- RRULE + BYDAY etc.
  first_occurrence    timestamptz,
  last_seen_at        timestamptz default now(),
  imported_at         timestamptz default now(),
  unique (user_id, google_event_id)
);
-- Parsed prescription shape (for both calendar_events and plans.prescription):
-- {
--   "blocks": [
--     { "kind": "single",  "position": 1,
--       "exercise_id": "pull_ups_emom",
--       "set_scheme": { "type": "emom", "minutes": 10, "reps_per_min": 2, "total_reps": 20 },
--       "weight_hint": "BW", "rir_target": 3, "notes": "Strict form only." },
--     { "kind": "superset", "position": 2, "rounds": 4, "rest_between_s": 75,
--       "drop_set_on_last": { "drop_pct": 20, "to_near_failure": true },
--       "items": [
--         { "letter": "A", "exercise_id": "incline_db_press",
--           "set_scheme": { "type": "standard", "reps": "8-10" }, "weight_hint": "30-35 lb" },
--         { "letter": "B", "exercise_id": "chest_supported_row",
--           "set_scheme": { "type": "standard", "reps": "10" }, "weight_hint": "40-45 lb" }
--       ]
--     }
--   ],
--   "creatine_g": 5,
--   "estimated_minutes": 50,
--   "notes_top": "Aim to beat Phase 2 weights on all main movements."
-- }

create index if not exists calendar_events_user_day_idx on calendar_events(user_id, day_type, day_code);

-- ---------------------------------------------------------------------
-- plans: link back to source calendar event (so we know the prescription origin)
-- ---------------------------------------------------------------------
alter table plans
  add column if not exists calendar_event_id uuid references calendar_events(id) on delete set null,
  add column if not exists source text default 'calendar';  -- 'calendar' | 'ai_proposed' | 'manual'

-- ---------------------------------------------------------------------
-- RLS on new table
-- ---------------------------------------------------------------------
alter table calendar_events enable row level security;
create policy own_calendar_events on calendar_events for all using (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- Documentation of profiles.brief expected shape (no schema change):
-- {
--   "profile": { "age": 29, "height_m": 1.9, "starting_kg": 79, "current_kg": 85 },
--   "training_age": "Beginner — started lifting January 2026",
--   "north_star": {
--     "short_term":   ["Beginner muscle gain", "Lean aesthetic physique"],
--     "mid_term":     ["Consolidate mass", "Lean out without losing strength"],
--     "long_term":    ["Triathlon-capable cardio base", "Handstands + gymnastic control",
--                      "Explosive skills (backflips)", "Excellent mobility"],
--     "end_state":    "Lean, muscular, athletic-looking. Not bulky."
--   },
--   "limitations":  ["Poor mobility currently", "Forearm/grip limits hanging core",
--                    "Prior injury interruption through Mar 12 2026"],
--   "style_rules":  ["Progressive overload in hypertrophy phases",
--                    "AI must propose, not auto-apply, outside active phase session tweaks"]
-- }
