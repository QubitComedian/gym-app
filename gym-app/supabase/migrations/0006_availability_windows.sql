-- =====================================================================
-- Gym v1 — migration 0006: availability_windows (P1.3 / PR-M)
-- =====================================================================
-- Introduces user-declared availability windows: travel, injury, pause.
-- When one is active, the reconciler's roll-forward pass writes window-
-- shaped plan rows in place of the normal template (bodyweight variant,
-- rest, or nothing, depending on window.strategy). All non-reconciler
-- engines (template-diff, phase-transition, drop-off gap math) treat
-- plans tagged `source='availability_window'` as preserved — the user
-- committed to this shape and nothing downstream should overwrite it.
--
-- Design notes
-- ------------
--   * Windows are "applied at creation" — there is no pending AI
--     proposal accept step. The user declares "I'm traveling Apr 20-27"
--     and the plan rows for that window are written immediately. An
--     `ai_proposals` row of kind='availability_change' is logged with
--     status='applied' for audit + rollback.
--   * Strategy resolution (kind → default strategy): travel→bodyweight,
--     injury→rest, pause→rest. `strategy='auto'` means "apply the
--     default for the given kind"; explicit values override. The pure
--     resolver lives in src/lib/reconcile/rollForward.pure.ts.
--   * `plans.source='availability_window'` is the preservation tag. It
--     is propagated through preservation rules in template-diff and
--     phase-transition (updated in this PR) — a travel window that
--     straddles a template edit or a phase boundary is never silently
--     rewritten.
--   * `plans.window_id` is a nullable FK so we can cascade a delete or
--     rollback back to affected plan rows without scanning by source +
--     date range. `on delete set null` preserves plan history in the
--     event a window is hard-deleted.
--   * Adding 'bodyweight' to `activity_type` — this is the first-class
--     plan type a travel window emits. Alternative strategies (rest,
--     suppress) re-use existing types or emit no row at all; see
--     resolveWindowStrategy in rollForward.pure.ts.
--   * Windows are inclusive on both ends (`starts_on <= ends_on`).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Extend activity_type enum with 'bodyweight'. Safe to re-run —
--    `add value if not exists` is a no-op if the value is already there.
-- ---------------------------------------------------------------------
alter type activity_type add value if not exists 'bodyweight';

-- ---------------------------------------------------------------------
-- 2. availability_windows table
-- ---------------------------------------------------------------------
create table if not exists availability_windows (
  id            uuid        primary key default uuid_generate_v4(),
  user_id       uuid        not null references auth.users(id) on delete cascade,

  -- Inclusive date range. Single-day windows have starts_on = ends_on.
  starts_on     date        not null,
  ends_on       date        not null,

  -- What kind of disruption this window represents. Drives the default
  -- strategy + the UI chip/icon.
  kind          text        not null check (kind in ('travel','injury','pause')),

  -- How roll-forward should rewrite plan rows in the window. 'auto'
  -- resolves to the kind default at materialization time:
  --   travel  → 'bodyweight'
  --   injury  → 'rest'
  --   pause   → 'rest'
  -- 'suppress' emits no plan row (reserved for edge cases — e.g. a full
  -- rest pause where even a rest entry clutters the UI).
  strategy      text        not null default 'auto'
                              check (strategy in ('auto','bodyweight','rest','suppress')),

  -- Free-form note the user enters ("Tokyo trip", "Strained achilles").
  -- Rendered on the Today chip + the window list.
  note          text,

  -- Catch-all for structured extras (hotel gym y/n, injured_area, etc.).
  -- Kept separate from the top-level columns so schema evolution is cheap.
  metadata      jsonb       not null default '{}'::jsonb,

  -- 'active' is the default. 'cancelled' is set when the user removes a
  -- window via rollback (preserves the audit trail instead of hard-delete).
  -- Cancelled windows are ignored by roll-forward.
  status        text        not null default 'active'
                              check (status in ('active','cancelled')),

  created_at    timestamptz not null default now(),
  cancelled_at  timestamptz,

  check (starts_on <= ends_on)
);

-- Roll-forward hot path: "any active window overlapping [today, today+21]
-- for this user". An index on (user_id, status, ends_on, starts_on)
-- lets the planner filter cancelled rows + range-prune with one seek.
create index if not exists availability_windows_user_active_range_idx
  on availability_windows (user_id, status, ends_on, starts_on);

alter table availability_windows enable row level security;
create policy own_availability_windows on availability_windows
  for all using (auth.uid() = user_id);

comment on table availability_windows is
  'User-declared travel / injury / pause periods. The reconciler rewrites '
  'plans in active windows to window-shaped variants (bodyweight / rest / '
  'suppress). Applied at creation — no pending proposal gate.';

-- ---------------------------------------------------------------------
-- 3. plans.window_id — link back to the window that produced the row.
--    Nullable; most plans have no window. When the window is deleted
--    we null the FK rather than cascade-delete the plan (we want the
--    plan's history intact and the reconciler will roll-forward fresh
--    rows on the next pass).
-- ---------------------------------------------------------------------
alter table plans
  add column if not exists window_id uuid references availability_windows(id) on delete set null;

-- Partial index: only plans with a non-null window_id benefit from it,
-- and that's a small fraction of the table.
create index if not exists plans_window_id_idx
  on plans(user_id, window_id) where window_id is not null;

-- ---------------------------------------------------------------------
-- 4. Document the 'availability_window' value for plans.source.
--    The column is already text (see 0002_calendar_truth.sql); no DDL
--    change needed. This comment keeps the allowed set discoverable.
-- ---------------------------------------------------------------------
comment on column plans.source is
  'Where this plan row came from: '
  '''calendar'' | ''template'' | ''ai_proposed'' | ''manual'' | ''availability_window''. '
  'The preservation rules in the template-diff and phase-transition '
  'engines treat ''manual'', ''ai_proposed'', and ''availability_window'' '
  'as user-committed — never silently overwritten.';

-- ---------------------------------------------------------------------
-- 5. ai_proposals.kind — we store the audit row with kind='availability_change'
--    status='applied' at creation time. No schema change needed (kind is
--    text); document for discoverability.
-- ---------------------------------------------------------------------
comment on column ai_proposals.kind is
  'Proposal flavor: ''adjust'' | ''return_from_gap'' | ''template_change'' | '
  '''phase_transition'' | ''availability_change''. The last is applied-at-creation; '
  'it exists for audit + single-action rollback, not an accept gate.';
