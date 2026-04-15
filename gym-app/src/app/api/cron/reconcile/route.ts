/**
 * Nightly reconcile cron.
 *
 * Hit by Vercel Cron at 04:00 UTC (see vercel.json). Iterates every
 * profile and runs reconcile(cause='nightly_cron'), which bypasses the
 * 30-min freshness gate so ageOut / rollForward / dropOff run even for
 * users who haven't opened the app today.
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

  return NextResponse.json({
    ok: true,
    profiles: profiles?.length ?? 0,
    ran,
    skipped,
    failed,
    aged_out: agedOut,
    rolled_forward: rolled,
    drop_off_detected: dropOff,
  });
}
