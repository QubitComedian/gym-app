-- =====================================================================
-- Gym v1 — migration 0011: body metrics + third-party integrations
-- =====================================================================
-- New tables:
--   1. body_weights           — user-logged body weight over time
--   2. body_measurements      — user-logged circumference / body-fat %
--   3. integration_accounts   — OAuth tokens for Strava / Garmin / etc.
--   4. integration_activities — activities pulled from integrations,
--                               pre-dedup, for auditing. Imported ones
--                               become rows in the existing `activities`
--                               table.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. body_weights
-- ---------------------------------------------------------------------
create table if not exists body_weights (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null references auth.users(id) on delete cascade,
  measured_on     date        not null,
  weight_kg       numeric(5,2) not null,
  note            text,
  source          text        not null default 'manual',  -- manual | strava | garmin | withings | apple_health
  created_at      timestamptz not null default now(),
  constraint body_weights_weight_kg_chk check (weight_kg > 20 and weight_kg < 400),
  constraint body_weights_source_chk    check (source in ('manual','strava','garmin','withings','apple_health','other'))
);

-- One reading per day per user — if the user logs twice, the second
-- overwrites the first (the UI calls upsert on (user_id, measured_on)).
create unique index if not exists body_weights_user_day_uq
  on body_weights (user_id, measured_on);

alter table body_weights enable row level security;
drop policy if exists own_body_weights on body_weights;
create policy own_body_weights on body_weights
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

comment on table body_weights is
  'Per-day body weight readings. Used by the You page tracker and phase nutrition math.';

-- ---------------------------------------------------------------------
-- 2. body_measurements (nullable columns — users record what they want)
-- ---------------------------------------------------------------------
create table if not exists body_measurements (
  id                uuid        primary key default gen_random_uuid(),
  user_id           uuid        not null references auth.users(id) on delete cascade,
  measured_on       date        not null,
  body_fat_pct      numeric(4,1),
  waist_cm          numeric(5,1),
  hip_cm            numeric(5,1),
  chest_cm          numeric(5,1),
  arm_cm            numeric(5,1),
  thigh_cm          numeric(5,1),
  note              text,
  created_at        timestamptz not null default now()
);
create unique index if not exists body_measurements_user_day_uq
  on body_measurements (user_id, measured_on);
alter table body_measurements enable row level security;
drop policy if exists own_body_measurements on body_measurements;
create policy own_body_measurements on body_measurements
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- 3. integration_accounts (Strava / Garmin / etc.)
-- ---------------------------------------------------------------------
-- One row per (user, provider). We DO keep tokens here (encrypted at
-- rest by Supabase) because the server uses them to pull activities.
-- This is the SAME storage pattern we use for google_tokens — isolated
-- RLS table, no client-side reads.
create table if not exists integration_accounts (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references auth.users(id) on delete cascade,
  provider            text        not null,          -- 'strava' | 'garmin' | 'withings' | 'apple_health'
  provider_user_id    text,                          -- athlete_id, etc.
  access_token        text,
  refresh_token       text,
  token_secret        text,                          -- OAuth1 (Garmin) uses a secret, not a refresh
  expires_at          timestamptz,
  scope               text,
  status              text        not null default 'active',  -- active | error | revoked
  last_synced_at      timestamptz,
  last_error          text,
  metadata            jsonb       not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint integration_accounts_provider_chk
    check (provider in ('strava','garmin','withings','apple_health','other')),
  constraint integration_accounts_status_chk
    check (status in ('active','error','revoked','pending'))
);
create unique index if not exists integration_accounts_user_provider_uq
  on integration_accounts (user_id, provider);
alter table integration_accounts enable row level security;
drop policy if exists own_integration_accounts on integration_accounts;
create policy own_integration_accounts on integration_accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- reuse the shared updated_at trigger
drop trigger if exists integration_accounts_touch on integration_accounts;
create trigger integration_accounts_touch
  before update on integration_accounts
  for each row execute function set_updated_at();

comment on table integration_accounts is
  'OAuth / API credentials for third-party fitness platforms (Strava, Garmin, …).';

-- ---------------------------------------------------------------------
-- 4. integration_activities
-- ---------------------------------------------------------------------
-- Raw pulls from the provider. We store them separately from `activities`
-- because (a) the shapes differ, (b) we might receive duplicates via
-- webhooks before dedup, (c) it gives us an audit trail even if the
-- user deletes the imported activity later.
create table if not exists integration_activities (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references auth.users(id) on delete cascade,
  provider            text        not null,
  provider_activity_id text       not null,
  activity_id         uuid        references activities(id) on delete set null,
  started_at          timestamptz not null,
  type                text,
  name                text,
  distance_m          numeric,
  duration_s          int,
  elevation_gain_m    numeric,
  average_hr          int,
  max_hr              int,
  average_watts       numeric,
  payload             jsonb       not null default '{}'::jsonb,  -- full raw body
  imported_at         timestamptz not null default now(),
  import_status       text        not null default 'imported',   -- imported | skipped | duplicate | error
  created_at          timestamptz not null default now()
);
create unique index if not exists integration_activities_provider_uq
  on integration_activities (user_id, provider, provider_activity_id);
create index if not exists integration_activities_user_started_idx
  on integration_activities (user_id, started_at desc);

alter table integration_activities enable row level security;
drop policy if exists own_integration_activities on integration_activities;
create policy own_integration_activities on integration_activities
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

comment on table integration_activities is
  'Raw activities pulled from Strava / Garmin etc. The activity_id column is filled once we map them into the canonical `activities` table.';
