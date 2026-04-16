-- =====================================================================
-- Gym v1 — migration 0005: weekly_templates (P1.1 / PR-E)
-- =====================================================================
-- Lifts the weekly training template out of `programs.config.split.weekly_pattern`
-- into a first-class per-phase table. Rationale:
--   * Phase shape is phase-specific (strength vs cut vs maintenance have
--     different weekly loads). Storing one pattern on the program row makes
--     phase transitions (P1.2) awkward.
--   * The user-edit flow (P1.1) wants version bumps and RLS on a tiny row,
--     not on the whole programs.config blob.
--   * The reconciler + drop-off paths will read per-phase patterns via a
--     loader (src/lib/templates/loader.ts) with a fallback to the legacy
--     programs.config.split.weekly_pattern during rollout.
--
-- Shape of `pattern` jsonb (same as before):
--   {
--     "MO": { "type": "gym", "day_code": "push" },
--     "TU": { "type": "gym", "day_code": "pull" },
--     ...
--     "SU": { "type": "rest", "day_code": null }
--   }
-- Keys are the user's DOW codes: SU | MO | TU | WE | TH | FR | SA.
-- Missing keys mean "no slot for that day" — the reconciler skips that date.
-- `type='rest'` is the user's off-day; there is no separate "off" slot.
-- =====================================================================

create table if not exists weekly_templates (
  id          uuid        primary key default uuid_generate_v4(),
  user_id     uuid        not null references auth.users(id) on delete cascade,
  phase_id    uuid        not null references phases(id)      on delete cascade,
  pattern     jsonb       not null default '{}'::jsonb,
  version     int         not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, phase_id)
);

create index if not exists weekly_templates_user_idx on weekly_templates(user_id);

comment on table weekly_templates is
  'Per-phase weekly training pattern. One row per (user_id, phase_id). '
  'The reconciler reads these patterns instead of programs.config to materialize '
  'future plans. Updates trigger an audit proposal (kind=template_change).';

alter table weekly_templates enable row level security;
create policy own_weekly_templates on weekly_templates for all using (auth.uid() = user_id);

create trigger weekly_templates_touch
  before update on weekly_templates
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- Backfill: copy programs.config.split.weekly_pattern into a row per
-- (user_id, phase_id) for every phase belonging to the user's program.
--
-- Uses ON CONFLICT DO NOTHING so the migration is safely re-runnable.
-- Phases without a program or with empty config are still backfilled as
-- an empty `{}` pattern — callers treat that as "no template yet."
-- ---------------------------------------------------------------------
insert into weekly_templates (user_id, phase_id, pattern)
select
  ph.user_id,
  ph.id as phase_id,
  coalesce(pg.config -> 'split' -> 'weekly_pattern', '{}'::jsonb) as pattern
from phases ph
left join programs pg
  on pg.id = ph.program_id
 and pg.active = true
on conflict (user_id, phase_id) do nothing;
