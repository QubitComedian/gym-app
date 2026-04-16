/**
 * Nightly reconcile cron (updated PR-W).
 *
 * Hit by Vercel Cron at 04:00 UTC (see vercel.json). Three phases:
 *
 *   1. **Reconcile** — per-user reconcile pass (ageOut, rollForward,
 *      dropOff, phaseTransition). Bypasses the 30-min freshness gate.
 *   2. **Full calendar scan** — rebuild the Google Calendar sync queue
 *      from scratch (catch anything the intraday worker missed) and
 *      detect meeting conflicts on users' primary calendars.
 *
 * Uses the service-role client (RLS bypass) since the call is
 * unauthenticated from a user perspective — Vercel authenticates with
 * a shared bearer token (CRON_SECRET). In dev, GET with no header is
 * allowed for manual kicking if CRON_SECRET is unset.
 *
 * Per-user failures are swallowed and logged; one bad profile
 * shouldn't stop the rest of the cohort from being reconciled.
 */

import { NextResponse } from 'next/server';
import { supabaseServiceRole } from '@/lib/supabase/server';
import { reconcile } from '@/lib/reconcile';
import { nightlyFullScan } from '@/lib/google/fullscan';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const got = req.headers.get('authorization') ?? '';
    if (got !== `Bearer ${expected}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const sb = supabaseServiceRole();
  const { data: profiles, error } = await sb
    .from('profiles')
    .select('user_id');
  if (error) {
    console.error('[cron/reconcile] profile fetch failed', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const now = new Date();
  let ran = 0;
  let skipped = 0;
  let failed = 0;
  let agedOut = 0;
  let rolled = 0;
  let dropOff = 0;

  for (const p of (profiles ?? []) as Array<{ user_id: string }>) {
    try {
      const res = await reconcile(sb, p.user_id, now, 'nightly_cron');
      if (res.skipped) {
        skipped += 1;
      } else {
        ran += 1;
        agedOut += res.aged_out;
        rolled += res.rolled_forward;
        if (res.drop_off_detected) dropOff += 1;
      }
    } catch (e) {
      failed += 1;
      console.error('[cron/reconcile] user failed', p.user_id, e);
    }
  }

  // Phase 2: nightly full calendar scan.
  // Runs after the per-user reconcile loop so any new plans from
  // rollForward are included in the sync-rebuild diff.
  const fullscan = await nightlyFullScan(sb);

  return NextResponse.json({
    ok: true,
    profiles: profiles?.length ?? 0,
    ran,
    skipped,
    failed,
    aged_out: agedOut,
    rolled_forward: rolled,
    drop_off_detected: dropOff,
    fullscan,
  });
}
