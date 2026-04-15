-- =====================================================================
-- Gym v1 — migration 0003: reconciler foundation (P1.0)
-- =====================================================================
-- Introduces the minimal schema surface for the plan reconciler:
--   * 'missed' state on plans.status (activity_status enum)
--   * timezone + last_reconciled_at on profiles
--   * kind column on ai_proposals to distinguish 'adjust' / 'return_from_gap' /
--     (future) 'phase_transition' / 'conflict'
--   * sync_jobs queue (schema only — P1.0 only uses kind='reconcile')
-- No reconciler logic lives in SQL. See src/lib/reconcile/.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. plans.status enum — allow 'missed' state.
--    Used by the reconciler's age-out pass to mark past planned sessions
--    that were never logged. Existing values untouched.
-- ---------------------------------------------------------------------
alter type activity_status add value if not exists 'missed';

-- ---------------------------------------------------------------------
-- 2. profiles — add timezone (for user-local "today" math) and
--    last_reconciled_at (for the reconciler's 30-min freshness gate).
-- ---------------------------------------------------------------------
alter table profiles
  add column if not exists timezone           text         not null default 'UTC',
  add column if not exists last_reconciled_at timestamptz;

comment on column profiles.timezone is
  'IANA timezone (e.g. Europe/Paris). Used to compute user-local dates.';
comment on column profiles.last_reconciled_at is
  'Last time reconcile() ran for this user. Used as a 30-min debounce gate.';

-- ---------------------------------------------------------------------
-- 3. ai_proposals.kind — distinguish proposal origins.
--    Existing rows backfill to 'adjust' (the only flow today).
--    Future values: 'return_from_gap' (P1.0), 'phase_transition' (P1.2),
--    'conflict' (P1.5).
-- ---------------------------------------------------------------------
alter table ai_proposals
  add column if not exists kind text not null default 'adjust';

create index if not exists ai_proposals_user_status_kind_idx
  on ai_proposals (user_id, status, kind);

comment on column ai_proposals.kind is
  'Proposal origin/type. Controls which UI banner renders it.';

-- ---------------------------------------------------------------------
-- 4. sync_jobs — minimal queue schema.
--    P1.0 only uses kind='reconcile' (cron entry point).
--    P1.4 (Google Calendar write) will add 'plan_upsert' / 'plan_delete',
--    P1.5 will add 'conflict_scan'.
-- ---------------------------------------------------------------------
create table if not exists sync_jobs (
  id          bigserial   primary key,
  user_id     uuid        not null references auth.users(id) on delete cascade,
  kind        text        not null,
  payload     jsonb       not null default '{}'::jsonb,
  status      text        not null default 'queued',
    -- 'queued' | 'running' | 'done' | 'failed'
  attempt     int         not null default 0,
  run_after   timestamptz not null default now(),
  last_error  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists sync_jobs_claim_idx
  on sync_jobs (status, run_after)
  where status = 'queued';

create index if not exists sync_jobs_user_kind_idx
  on sync_jobs (user_id, kind, status);

comment on table sync_jobs is
  'Work queue for the reconciler and (later) external-calendar sync.';
