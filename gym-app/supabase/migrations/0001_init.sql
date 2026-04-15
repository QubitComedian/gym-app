-- =====================================================================
-- Gym v1 — initial schema
-- =====================================================================
-- Design notes:
-- * `activities` is the universal record of *what you did* (gym/run/bike/yoga/climb/sauna/rest).
-- * `plans` is what Claude intends for the future. A plan is consumed when an activity of the same day+type completes.
-- * `phases` lets Claude respect macro-periodization (bulk → consolidate → cut → athletic transition).
-- * `exercises_catalog` + `exercise_prefs` separate the exercise library from per-user memory.
-- * Every user-owned table has RLS. Auth via Supabase's built-in auth.users.

-- ---------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
create type activity_type as enum (
  'gym', 'run', 'bike', 'swim', 'yoga', 'climb', 'sauna_cold', 'mobility', 'rest', 'other'
);

create type activity_status as enum (
  'planned', 'done', 'skipped', 'moved', 'unplanned', 'superseded'
);

create type exercise_pref_status as enum ('liked', 'neutral', 'banned');

create type phase_status as enum ('upcoming', 'active', 'completed', 'abandoned');

create type proposal_status as enum ('pending', 'approved', 'rejected', 'applied');

-- ---------------------------------------------------------------------
-- Exercises catalog (public reference data)
-- ---------------------------------------------------------------------
create table exercises_catalog (
  id              text primary key,                      -- stable canonical id, e.g. 'incline_db_press'
  name            text not null,                         -- display name
  aliases         text[] default '{}',
  primary_muscles text[] default '{}',
  equipment       text[] default '{}',
  default_cues    text,
  created_at      timestamptz default now()
);

-- ---------------------------------------------------------------------
-- Users: metadata extension. auth.users holds identity.
-- ---------------------------------------------------------------------
create table profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  brief      jsonb,    -- trainer brief: goals, constraints, long-term vision
  settings   jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ---------------------------------------------------------------------
-- Programs: the user's current program config.
-- ---------------------------------------------------------------------
create table programs (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  active     boolean default true,
  -- config shape:
  -- {
  --   "split": { "rotation": ["A","B","C","D"],
  --              "days": { "A": { "name": "Push", "exercises": [{ "exercise_id": "incline_db_press", "sets": 4, "rep_range": "8-10", "weight_hint": "25-30 lb", "notes": "..." }] }, ... } },
  --   "progression_rules": { ... },
  --   "weekly_cardio_target": { "runs_per_week": 2, "easy_km": [5,7] }
  -- }
  config     jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index programs_user_active_idx on programs(user_id) where active = true;

-- ---------------------------------------------------------------------
-- Phases: macro periodization.
-- ---------------------------------------------------------------------
create table phases (
  id           uuid primary key default uuid_generate_v4(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  program_id   uuid references programs(id) on delete set null,
  ordinal      int not null,                  -- 1,2,3,...
  name         text not null,                 -- 'Muscle base — bulk', 'Consolidate', 'Lean out', 'Athletic transition'
  description  text,
  goals        jsonb default '{}'::jsonb,     -- { bodyweight_target_kg, lift_focus[], cardio_emphasis }
  starts_on    date,
  target_ends_on date,
  actual_ends_on date,
  status       phase_status default 'upcoming',
  created_at   timestamptz default now()
);

create index phases_user_ordinal_idx on phases(user_id, ordinal);

-- ---------------------------------------------------------------------
-- Plans: future-tense activities Claude has proposed.
-- ---------------------------------------------------------------------
create table plans (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  phase_id        uuid references phases(id) on delete set null,
  date            date not null,
  type            activity_type not null,
  day_code        text,                       -- 'A' | 'B' | 'C' | 'D' for gym; null otherwise
  prescription    jsonb not null default '{}'::jsonb,  -- full prescription snapshot (exercises, sets, weights, notes)
  status          activity_status not null default 'planned',
  version         int not null default 1,
  parent_plan_id  uuid references plans(id) on delete set null,  -- prior version when replanned
  ai_rationale    text,                        -- why Claude put this here (last update)
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create index plans_user_date_idx on plans(user_id, date);
create index plans_user_status_date_idx on plans(user_id, status, date);

-- ---------------------------------------------------------------------
-- Activities: what actually happened.
-- ---------------------------------------------------------------------
create table activities (
  id           uuid primary key default uuid_generate_v4(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  plan_id      uuid references plans(id) on delete set null,  -- null = unplanned
  date         date not null,
  type         activity_type not null,
  status       activity_status not null default 'done',
  source       text default 'app',             -- 'app' | 'calendar' | 'import' | 'ai-generated'
  sentiment    smallint,                       -- 1..5
  notes        text,
  -- Type-specific data:
  -- gym:         { day_code, sets: { exercise_id: [{ w, r, rir, note, side? }, ...] }, skipped_exercises: [] }
  -- run|bike:    { distance_km, duration_s, avg_pace_s_per_km, rpe, hr_avg?, route? }
  -- yoga:        { duration_min, intensity, notes }
  -- climb:       { duration_min, location, top_grade, routes?: [...] }
  -- sauna_cold:  { sauna_min, cold_min, cycles }
  -- mobility:    { duration_min, protocol }
  -- rest:        {}
  data         jsonb not null default '{}'::jsonb,
  started_at   timestamptz,
  completed_at timestamptz default now(),
  created_at   timestamptz default now()
);

create index activities_user_date_idx on activities(user_id, date desc);
create index activities_plan_id_idx on activities(plan_id);

-- ---------------------------------------------------------------------
-- Exercise preferences: the user's living memory.
-- ---------------------------------------------------------------------
create table exercise_prefs (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  exercise_id text,                             -- references exercises_catalog.id when applicable
  label      text not null,                     -- free text display name (covers things not in catalog)
  status     exercise_pref_status not null default 'neutral',
  reason     text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, exercise_id, label)
);

-- ---------------------------------------------------------------------
-- AI proposals: Claude's suggested diff awaiting user approval.
-- ---------------------------------------------------------------------
create table ai_proposals (
  id                uuid primary key default uuid_generate_v4(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  triggered_by      text not null,                     -- 'review' | 'replan' | 'missed' | 'unplanned' | 'manual'
  source_activity_id uuid references activities(id) on delete set null,
  -- Diff shape:
  -- {
  --   "updates": [ { "plan_id": "...", "prescription": {...}, "date": "...", "status": "..." } ],
  --   "creates": [ { "date": "...", "type": "gym", "day_code": "B", "prescription": {...} } ],
  --   "deletes": [ "plan_id1" ],
  --   "rationale": "human-readable summary"
  -- }
  diff              jsonb not null,
  rationale         text,
  status            proposal_status not null default 'pending',
  applied_at        timestamptz,
  created_at        timestamptz default now()
);

-- ---------------------------------------------------------------------
-- Calendar sync: idempotent Google Calendar link.
-- ---------------------------------------------------------------------
create table calendar_links (
  id               uuid primary key default uuid_generate_v4(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  plan_id          uuid references plans(id) on delete cascade,
  activity_id      uuid references activities(id) on delete cascade,
  google_event_id  text not null,
  google_calendar_id text not null default 'primary',
  checksum         text not null,                -- hash of prescription used to write the event
  last_synced_at   timestamptz default now(),
  created_at       timestamptz default now(),
  unique (user_id, google_event_id)
);

create index calendar_links_plan_idx on calendar_links(plan_id);

-- ---------------------------------------------------------------------
-- Google OAuth tokens (encrypted at rest via Supabase pgcrypto).
-- ---------------------------------------------------------------------
create table google_tokens (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  access_token   text not null,
  refresh_token  text not null,
  expires_at     timestamptz not null,
  scope          text,
  channel_id     text,                            -- Google Calendar watch channel
  resource_id    text,
  watch_expires_at timestamptz,
  updated_at     timestamptz default now()
);

-- ---------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------
alter table profiles enable row level security;
alter table programs enable row level security;
alter table phases enable row level security;
alter table plans enable row level security;
alter table activities enable row level security;
alter table exercise_prefs enable row level security;
alter table ai_proposals enable row level security;
alter table calendar_links enable row level security;
alter table google_tokens enable row level security;

create policy own_profile on profiles for all using (auth.uid() = user_id);
create policy own_programs on programs for all using (auth.uid() = user_id);
create policy own_phases on phases for all using (auth.uid() = user_id);
create policy own_plans on plans for all using (auth.uid() = user_id);
create policy own_activities on activities for all using (auth.uid() = user_id);
create policy own_prefs on exercise_prefs for all using (auth.uid() = user_id);
create policy own_proposals on ai_proposals for all using (auth.uid() = user_id);
create policy own_calendar on calendar_links for all using (auth.uid() = user_id);
create policy own_tokens on google_tokens for all using (auth.uid() = user_id);

-- exercises_catalog is shared-readable; only service role writes.
alter table exercises_catalog enable row level security;
create policy catalog_read on exercises_catalog for select using (true);

-- ---------------------------------------------------------------------
-- Helpers: updated_at trigger
-- ---------------------------------------------------------------------
create or replace function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger profiles_touch before update on profiles for each row execute function set_updated_at();
create trigger programs_touch before update on programs for each row execute function set_updated_at();
create trigger plans_touch    before update on plans    for each row execute function set_updated_at();
create trigger prefs_touch    before update on exercise_prefs for each row execute function set_updated_at();
create trigger tokens_touch   before update on google_tokens for each row execute function set_updated_at();
