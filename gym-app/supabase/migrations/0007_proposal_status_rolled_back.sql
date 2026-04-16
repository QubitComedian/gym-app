-- =====================================================================
-- Gym v1 — migration 0007: proposal_status 'rolled_back' (P1.3 / PR-O)
-- =====================================================================
-- Availability-window changes are applied at creation time and logged as
-- ai_proposals rows with kind='availability_change', status='applied'.
-- The rollback path in /api/proposals/[id] (action='rollback') needs to
-- mark the original row so the UI can disable its rollback button and
-- we can prevent double-rollback races.
--
-- Adding 'rolled_back' to the proposal_status enum captures that state
-- without needing a separate `rolled_back_at` column (a follow-up
-- 'availability_change' proposal of intent='rollback' with
-- `diff.rollback_of` pointing back at this id carries the timestamp).
--
-- Safe to re-run — `add value if not exists` is a no-op.
-- =====================================================================

alter type proposal_status add value if not exists 'rolled_back';

comment on type proposal_status is
  'Lifecycle of an ai_proposals row: '
  '''pending'' | ''approved'' | ''rejected'' | ''applied'' | ''rolled_back''. '
  '''rolled_back'' is used for audit entries that were applied then later '
  'reversed by the availability rollback path.';
