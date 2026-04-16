/**
 * Weekly template loader (P1.1 / PR-E).
 *
 * Reads per-phase weekly patterns from `weekly_templates`. During the
 * P1.1 rollout we also fall back to the legacy
 * `programs.config.split.weekly_pattern` so users whose backfill hasn't
 * run yet (or whose programs row carries an updated pattern the DB
 * hasn't copied over yet) don't see an empty schedule.
 *
 * The reconciler calls these helpers; all pure logic in rollForward /
 * dropOff operates on a `patternByPhase: Map<phase_id, WeeklyPattern>`
 * so tests can supply a map directly and the pure layer never touches
 * Supabase.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WeeklyPattern } from '@/lib/reconcile/rollForward.pure';

/** The rows we care about from `weekly_templates`. */
export type WeeklyTemplateRow = {
  id: string;
  user_id: string;
  phase_id: string;
  pattern: WeeklyPattern;
  version: number;
  updated_at: string;
};

/**
 * Load all per-phase weekly patterns for a user.
 *
 * Returns a Map keyed by `phase_id`. When a phase has no row in
 * `weekly_templates`, we fall back to the legacy program config pattern
 * so the reconciler still emits plans. If both are empty we omit the
 * phase — callers interpret a missing key as "no template; skip dates
 * in this phase" (same behavior as before the P1.1 rewire).
 */
export async function getAllWeeklyPatternsForUser(
  sb: SupabaseClient,
  userId: string
): Promise<ReadonlyMap<string, WeeklyPattern>> {
  const [templatesResp, phasesResp, programResp] = await Promise.all([
    sb
      .from('weekly_templates')
      .select('phase_id, pattern, version, updated_at')
      .eq('user_id', userId),
    sb
      .from('phases')
      .select('id')
      .eq('user_id', userId),
    sb
      .from('programs')
      .select('config')
      .eq('user_id', userId)
      .eq('active', true)
      .maybeSingle(),
  ]);

  if (templatesResp.error) {
    console.error('[templates/loader] load weekly_templates failed', templatesResp.error);
  }

  const out = new Map<string, WeeklyPattern>();

  for (const row of (templatesResp.data ?? []) as Array<{ phase_id: string; pattern: WeeklyPattern }>) {
    if (row.pattern && Object.keys(row.pattern).length > 0) {
      out.set(row.phase_id, row.pattern);
    }
  }

  // Fallback: any phase without a (non-empty) weekly_templates row gets
  // the legacy programs.config.split.weekly_pattern. This keeps the
  // reconciler working for users pre-backfill, and for any phase whose
  // template row is deliberately empty (we'd rather show the legacy
  // shape than a blank schedule).
  const legacy: WeeklyPattern =
    (programResp.data as { config?: { split?: { weekly_pattern?: WeeklyPattern } } } | null)
      ?.config?.split?.weekly_pattern ?? {};

  if (!phasesResp.error && Object.keys(legacy).length > 0) {
    for (const ph of (phasesResp.data ?? []) as Array<{ id: string }>) {
      if (!out.has(ph.id)) out.set(ph.id, legacy);
    }
  }

  return out;
}

/**
 * Load the weekly template row for a specific (user, phase). Used by the
 * editor and diff/apply paths, which need the `version` for optimistic
 * concurrency, not just the pattern itself.
 *
 * Returns null if no row exists yet. Callers that want the legacy
 * fallback pattern should call `getLegacyPattern(sb, userId)` alongside.
 */
export async function getWeeklyTemplate(
  sb: SupabaseClient,
  userId: string,
  phaseId: string
): Promise<WeeklyTemplateRow | null> {
  const { data, error } = await sb
    .from('weekly_templates')
    .select('id, user_id, phase_id, pattern, version, updated_at')
    .eq('user_id', userId)
    .eq('phase_id', phaseId)
    .maybeSingle();

  if (error) {
    console.error('[templates/loader] getWeeklyTemplate failed', error);
    return null;
  }
  return (data as WeeklyTemplateRow | null) ?? null;
}

/** Convenience: the legacy pattern from programs.config, or {}. */
export async function getLegacyPattern(
  sb: SupabaseClient,
  userId: string
): Promise<WeeklyPattern> {
  const { data } = await sb
    .from('programs')
    .select('config')
    .eq('user_id', userId)
    .eq('active', true)
    .maybeSingle();
  return (
    (data as { config?: { split?: { weekly_pattern?: WeeklyPattern } } } | null)
      ?.config?.split?.weekly_pattern ?? {}
  );
}

/**
 * Upsert a weekly template row with optimistic concurrency.
 *
 * Returns `{ ok: true, row }` on success, `{ ok: false, reason: 'version_conflict' }`
 * if the row exists at a different version, or `{ ok: false, reason }` on
 * a generic DB error.
 */
export async function upsertWeeklyTemplate(
  sb: SupabaseClient,
  params: {
    userId: string;
    phaseId: string;
    pattern: WeeklyPattern;
    expectedVersion: number | null; // null when creating for the first time
  }
): Promise<
  | { ok: true; row: WeeklyTemplateRow }
  | { ok: false; reason: 'version_conflict' | 'insert_failed' | 'update_failed' }
> {
  const { userId, phaseId, pattern, expectedVersion } = params;

  if (expectedVersion === null) {
    // Insert path. Unique(user_id, phase_id) prevents dupes.
    const { data, error } = await sb
      .from('weekly_templates')
      .insert({
        user_id: userId,
        phase_id: phaseId,
        pattern,
        version: 1,
      })
      .select('id, user_id, phase_id, pattern, version, updated_at')
      .single();
    if (error) {
      // 23505 = unique violation (someone else raced us). Treat as a
      // version conflict so the caller re-reads + re-applies.
      if ((error as { code?: string }).code === '23505') {
        return { ok: false, reason: 'version_conflict' };
      }
      console.error('[templates/loader] upsertWeeklyTemplate insert failed', error);
      return { ok: false, reason: 'insert_failed' };
    }
    return { ok: true, row: data as WeeklyTemplateRow };
  }

  // Update path. Scope the update to the expected version — if someone
  // else has bumped it, we get zero rows back and bail.
  const { data, error } = await sb
    .from('weekly_templates')
    .update({
      pattern,
      version: expectedVersion + 1,
    })
    .eq('user_id', userId)
    .eq('phase_id', phaseId)
    .eq('version', expectedVersion)
    .select('id, user_id, phase_id, pattern, version, updated_at')
    .maybeSingle();

  if (error) {
    console.error('[templates/loader] upsertWeeklyTemplate update failed', error);
    return { ok: false, reason: 'update_failed' };
  }
  if (!data) return { ok: false, reason: 'version_conflict' };
  return { ok: true, row: data as WeeklyTemplateRow };
}
