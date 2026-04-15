/**
 * Age-out pass (P1.0 / PR-B).
 *
 * Flips past `planned` plans with no matching activity to `missed`.
 * Rest days are exempt — a rest plan is fulfilled by not training, so the
 * absence of an activity isn't a miss.
 *
 * Implemented as a single RPC (migration 0004) because PostgREST can't
 * express the anti-join (`NOT EXISTS (SELECT 1 FROM activities ...)`)
 * cleanly in one round-trip. The function runs under `security invoker`,
 * so RLS still applies to whichever client calls it — user-scoped clients
 * only see their own rows, service-role clients see everything.
 *
 * Idempotent: rerunning produces zero updates (the WHERE clause won't
 * match anything still `planned`).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function ageOut(opts: {
  sb: SupabaseClient;
  userId: string;
  todayIso: string;
}): Promise<{ aged_out: number }> {
  const { sb, userId, todayIso } = opts;

  const { data, error } = await sb.rpc('reconcile_age_out', {
    p_user_id: userId,
    p_today: todayIso,
  });

  if (error) {
    // One failed pass shouldn't blow up a page load. Log and return zero
    // so the caller can still run roll-forward + drop-off. The next
    // reconcile will retry.
    console.error('[reconcile/ageOut] rpc failed', error);
    return { aged_out: 0 };
  }

  // RPC returns an int; Supabase surfaces it as `number | null`.
  const aged = typeof data === 'number' ? data : 0;
  return { aged_out: aged };
}
