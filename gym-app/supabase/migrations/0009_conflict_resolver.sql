-- 0009_conflict_resolver.sql
--
-- Schema support for the conflict resolver (P1.4 / PR-U).
--
-- The PR-T worker marks `calendar_links.sync_status='conflict'` when
-- Google returns 412 (etag mismatch). PR-U's resolver queries these
-- rows, re-fetches the Google event, classifies the conflict, and
-- either force-pushes (trivial) or creates a `kind='conflict'`
-- proposal (meaningful edit).
--
-- This migration adds:
--
--   1. An index on calendar_links for efficient conflict discovery.
--      The PR-S index (0008) only covers `('pending','error')`;
--      conflict rows need their own lookup path.
--
--   2. A `remote_snapshot` JSONB column on calendar_links to cache the
--      last-known Google event state at conflict time. The resolver
--      writes this when it fetches the event; proposals reference it
--      for the "accept Google edit" option without a second fetch.
--
--   3. Update the ai_proposals kind index comment to document
--      'conflict' as a supported kind (the index itself already
--      covers any text value; this is just documentation).

-- 1. Conflict discovery index.
-- Covers `SELECT ... WHERE sync_status='conflict'` ordered by user.
create index if not exists calendar_links_conflict_idx
  on calendar_links (user_id)
  where sync_status = 'conflict';

-- 2. Remote snapshot column.
-- Stores the Google event's {summary, description, start, end, etag}
-- at the moment the resolver fetched it. NULL when no conflict has
-- been fetched yet.
alter table calendar_links
  add column if not exists remote_snapshot jsonb;

comment on column calendar_links.remote_snapshot is
  'Last-fetched Google event state at conflict time. Written by the conflict resolver (PR-U); read by the proposal UI for the "accept Google edit" option.';
