-- P1.5 — Per-plan time override for conflict rescheduling.
--
-- When a meeting-conflict proposal reschedules a session to morning /
-- evening, the new start time is stored directly on the plan row so
-- the projection (project.ts) uses it instead of the global
-- training_preferences default. Null = use preferences as before.
--
-- This is a non-breaking addition: existing rows default to null and
-- the projection falls through to the preference-based path.

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS time_override time DEFAULT NULL;

COMMENT ON COLUMN plans.time_override IS
  'Per-plan start-time override (HH:MM:SS). When set, projectPlanToEvent '
  'uses this instead of training_preferences. Set by meeting-conflict '
  'reschedule; null = use global preference.';
