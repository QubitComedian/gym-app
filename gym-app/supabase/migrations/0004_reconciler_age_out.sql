-- =====================================================================
-- Gym v1 — migration 0004: reconciler age-out SQL function (P1.0 / PR-B)
-- =====================================================================
-- The reconciler's age-out pass flips past `planned` plans with no
-- matching activity to `missed`. PostgREST can't express the anti-join
-- cleanly, and splitting it into N round-trips is a waste, so we expose
-- a single SECURITY INVOKER function the TS layer calls via `.rpc()`.
--
-- Semantics (see src/lib/reconcile/ageOut.ts):
--   * Scoped to one user; caller's RLS still applies.
--   * `p_today` is the user's LOCAL today (computed server-side via the
--     user's profiles.timezone). Plans with date < p_today are candidates.
--   * Only `status='planned'` rows flip. Already-missed/done/skipped are
--     untouched — this makes the function safely idempotent.
--   * `type='rest'` rows never flip: a rest day is fulfilled by not
--     training, so the absence of an activity isn't a miss.
--   * An activity "satisfies" a plan iff `activities.plan_id = plans.id`.
--     Unplanned activities on the same date do NOT count — the user has
--     a separate logging path for retroactive attachment if they want
--     credit.
--
-- Returns the number of rows updated.
-- =====================================================================

create or replace function reconcile_age_out(
  p_user_id uuid,
  p_today   date
) returns int
language plpgsql
security invoker
as $$
declare
  affected int;
begin
  with updated as (
    update plans p
       set status     = 'missed',
           updated_at = now()
     where p.user_id = p_user_id
       and p.date    < p_today
       and p.status  = 'planned'
       and p.type   <> 'rest'
       and not exists (
         select 1 from activities a where a.plan_id = p.id
       )
    returning 1
  )
  select count(*)::int into affected from updated;

  return coalesce(affected, 0);
end;
$$;

comment on function reconcile_age_out(uuid, date) is
  'Reconciler age-out pass. Flips past planned (non-rest) plans with no '
  'matching activity to ''missed''. Returns affected row count. '
  'See src/lib/reconcile/ageOut.ts.';
