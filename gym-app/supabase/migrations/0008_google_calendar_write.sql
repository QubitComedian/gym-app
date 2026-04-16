-- =====================================================================
-- Gym v1 — migration 0008: Google Calendar write foundation (P1.4 / PR-S)
-- =====================================================================
-- Schema additions for the Google Calendar write path. This migration is
-- SCHEMA-ONLY — it adds columns and tables the worker (PR-T) and UI
-- (PR-U..W) will use, but leaves no worker / route code yet. Existing
-- app behavior is unaffected: new columns default to values that the
-- current code ignores, the new training_preferences table is empty,
-- and the existing /api/calendar/push demo route keeps working.
--
-- Additions:
--   1. calendar_links — per-link sync state (etag, status, last error).
--      Today's single field `checksum` was sufficient for "did the plan
--      change since we wrote it"; the worker needs (a) an etag for
--      conditional writes (412 on drift), (b) a status lane so we can
--      distinguish synced / pending / error / conflict rows in the UI,
--      (c) a last_error surface, (d) attempt bookkeeping for exponential
--      backoff.
--   2. google_tokens — per-user calendar identity and auth health.
--      `training_calendar_id` lets us write to a dedicated "Workouts"
--      calendar separate from the user's primary; `status` lets us gate
--      the worker when tokens are revoked/expired without deleting the
--      row (the refresh-token recovery path needs the old record).
--   3. training_preferences — per-user session-time defaults. Today the
--      push route hardcodes 7am/60min; the real calendar write needs a
--      configurable default plus weekday overrides so a user can say
--      "Mondays and Wednesdays at 06:30, other days at 18:00".
--
-- All new columns/tables follow the same RLS-by-user pattern as the
-- rest of the schema. No backfill required — existing rows read fine
-- with the defaults below.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1a. calendar_links.plan_id — soften cascade from CASCADE to SET NULL.
-- ---------------------------------------------------------------------
-- Rationale: the Google Calendar worker (PR-T) needs the link row to
-- SURVIVE a plan-row deletion so it can delete the remote event. With
-- the current `on delete cascade`, the link row is nuked the moment
-- the plan is deleted, and the worker has no record of the
-- google_event_id to clean up in Google. Changing to `set null` keeps
-- the link as an orphan until the worker reconciles and deletes it.
--
-- This is not user-visible today — the demo /api/calendar/push route
-- filters its link lookup by `.in('plan_id', <active plan ids>)` so
-- orphan rows are simply ignored. The worker (PR-T) will sweep them.
alter table calendar_links
  drop constraint if exists calendar_links_plan_id_fkey;
alter table calendar_links
  add constraint calendar_links_plan_id_fkey
  foreign key (plan_id) references plans(id) on delete set null;

-- ---------------------------------------------------------------------
-- 1b. calendar_links — augment with sync state.
-- ---------------------------------------------------------------------
-- google_etag: the `ETag` header Google returns on events.get /
--   events.insert / events.update. Stored so the worker can send
--   `If-Match: <etag>` on the next update and detect out-of-band edits
--   (user moved the event in Google Calendar by hand). A 412 response
--   triggers a reconcile pass: we re-fetch the event, compare to our
--   projection, and either update our checksum (user edit wins on
--   non-authoritative fields like time) or surface a conflict proposal
--   (fields we own diverged).
--
-- sync_status: lightweight lifecycle for the link row itself.
--   'synced'  — last write succeeded; etag matches Google.
--   'pending' — a plan_upsert/plan_delete job is queued or running.
--   'error'   — last write failed in a way the worker couldn't
--                retry transparently; user-visible in the UI.
--   'conflict'— 412 on write, conflict proposal pending the user's
--                attention. Distinct from 'error' because the data is
--                consistent, just needs a human decision.
--   The worker is the only writer; callers treat this as read-only.
--
-- last_error: human-readable message from the last failed attempt.
--   Cleared on success. Surfaced in the calendar-sync status card.
--
-- last_attempt_at / attempt_count: for exponential backoff math and
--   the status UI ("last retried 3m ago, next in 27m"). attempt_count
--   resets to 0 on success.
alter table calendar_links
  add column if not exists google_etag     text,
  add column if not exists sync_status     text        not null default 'synced',
  add column if not exists last_error      text,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists attempt_count   int         not null default 0;

-- Soft constraint on sync_status values. kept as CHECK rather than a
-- dedicated enum because the worker-vs-migration upgrade path for
-- enum value additions is painful (we learned that with
-- activity_status/'missed' in 0003).
alter table calendar_links
  drop constraint if exists calendar_links_sync_status_chk;
alter table calendar_links
  add constraint calendar_links_sync_status_chk
  check (sync_status in ('synced', 'pending', 'error', 'conflict'));

-- Unique constraint on (user_id, plan_id) — every plan has at most one
-- Google event in the training calendar. Today's schema only enforces
-- unique (user_id, google_event_id), which is necessary but not
-- sufficient: two links with the same plan_id pointing at different
-- google events would create duplicate calendar entries. The new
-- constraint makes the worker's upsert atomic via ON CONFLICT.
--
-- `where plan_id is not null` because calendar_links today supports
-- activity-only rows too (activity_id non-null, plan_id null for
-- unplanned logged workouts). Those aren't covered by this constraint.
create unique index if not exists calendar_links_user_plan_uq
  on calendar_links (user_id, plan_id)
  where plan_id is not null;

-- Worker claim index: pick up rows that need attention, ordered by
-- when they're eligible to retry. Partial index keeps it small —
-- 'synced' rows are the vast majority and don't need indexing for
-- this scan.
create index if not exists calendar_links_needs_sync_idx
  on calendar_links (user_id, last_attempt_at)
  where sync_status in ('pending', 'error');

comment on column calendar_links.google_etag is
  'ETag from Google Calendar. Sent as If-Match on conditional updates; 412 = out-of-band edit.';
comment on column calendar_links.sync_status is
  'Lifecycle of this link: synced | pending | error | conflict. Worker-owned.';
comment on column calendar_links.last_error is
  'Last worker error for this row. Cleared on successful sync.';
comment on column calendar_links.attempt_count is
  'Consecutive failed attempts. Drives exponential backoff; reset to 0 on success.';

-- ---------------------------------------------------------------------
-- 2. google_tokens — augment with dedicated calendar id + auth health.
-- ---------------------------------------------------------------------
-- training_calendar_id: id of the user's "Workouts" calendar. NULL
--   means "user has OAuth'd but hasn't picked/created a dedicated
--   calendar yet"; the worker skips enqueueing until it's set. The
--   calendar-setup UI (PR-V) creates a Google Calendar named
--   "Workouts" on first connect and stores the id here.
--
-- status: gate for the worker.
--   'active'  — tokens fresh, syncing allowed.
--   'error'   — refresh flow failed (Google returned invalid_grant,
--                revoked, expired). Worker pauses. UI shows a reconnect
--                banner.
--   'revoked' — user explicitly disconnected. Worker pauses; we keep
--                the row so we know which calendar_links to tombstone
--                on re-connect.
alter table google_tokens
  add column if not exists training_calendar_id text,
  add column if not exists status               text not null default 'active';

alter table google_tokens
  drop constraint if exists google_tokens_status_chk;
alter table google_tokens
  add constraint google_tokens_status_chk
  check (status in ('active', 'error', 'revoked'));

comment on column google_tokens.training_calendar_id is
  'Id of the dedicated "Workouts" Google Calendar. NULL = user has not completed calendar setup.';
comment on column google_tokens.status is
  'active = worker may sync; error = refresh failed; revoked = user disconnected.';

-- ---------------------------------------------------------------------
-- 3. training_preferences — per-user session-time defaults.
-- ---------------------------------------------------------------------
-- Today /api/calendar/push hardcodes 7am + 60min. Real users need (a)
-- a default block, (b) per-weekday overrides ("Monday + Wednesday at
-- 06:30, others at 18:00"). day_overrides is keyed by ISO weekday
-- 1..7 (Mon..Sun) to keep the join with plans.date simple.
--
-- color_scheme controls the Google Calendar event colorId. Nullable =
-- use calendar default. Stored here rather than per-plan because users
-- want one colour for "their workouts" across the board; per-plan
-- overrides (e.g. PR brown for a race) can come later.
create table if not exists training_preferences (
  user_id                  uuid        primary key references auth.users(id) on delete cascade,
  session_start_time       time        not null default '07:00:00',
  session_duration_minutes int         not null default 60,
  -- day_overrides: JSON object keyed by ISO weekday number as string.
  --   { "1": { "start": "06:30", "minutes": 45 },
  --     "3": { "start": "06:30", "minutes": 45 } }
  -- Missing keys fall back to the row's defaults. Validated in app
  -- code (Zod) so the column stays permissive at the DB layer.
  day_overrides            jsonb       not null default '{}'::jsonb,
  color_scheme             text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint training_preferences_duration_chk
    check (session_duration_minutes between 15 and 480)
);

alter table training_preferences enable row level security;

drop policy if exists own_training_preferences on training_preferences;
create policy own_training_preferences on training_preferences
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Reuse the set_updated_at trigger from 0001_init.sql.
drop trigger if exists training_preferences_touch on training_preferences;
create trigger training_preferences_touch
  before update on training_preferences
  for each row execute function set_updated_at();

comment on table training_preferences is
  'Per-user default event time/duration for calendar writes. day_overrides keyed by ISO weekday 1..7.';
comment on column training_preferences.session_start_time is
  'Default event start time in the user profile timezone. Overridden per-weekday by day_overrides.';
comment on column training_preferences.day_overrides is
  'JSON map of ISO weekday string ("1".."7") to { start: "HH:MM", minutes: int }. Empty = use defaults.';
