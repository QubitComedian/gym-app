/**
 * Calendar-sync cron (P1.4 / PR-T + PR-U).
 *
 * Hit by Vercel Cron every 5 minutes (see vercel.json). Two phases:
 *
 *   1. **Drain** — process queued `plan_upsert` / `plan_delete` jobs.
 *   2. **Resolve conflicts** — for any `calendar_links` rows the
 *      worker marked `sync_status='conflict'` (412 etag mismatch),
 *      fetch the current Google event, classify the conflict, and
 *      either force-push (trivial) or create a proposal (meaningful).
 *
 * Uses the service-role client (RLS bypass) since the call is
 * unauthenticated from a user perspective — Vercel authenticates with
 * the shared CRON_SECRET bearer token. In dev, GET with no header is
 * allowed for manual kicking if CRON_SECRET is unset.
 */

import { NextResponse } from 'next/server';
import { supabaseServiceRole } from '@/lib/supabase/server';
import { drainSyncJobs } from '@/lib/google/worker';
import { resolveConflicts } from '@/lib/google/conflict';

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

  // Phase 1: drain the sync_jobs queue.
  const drain = await drainSyncJobs(sb);

  // Phase 2: resolve any etag conflicts left by the worker.
  // Runs in the same cron invocation so conflicts are addressed within
  // the same 5-minute cycle that created them — the user sees a
  // proposal (or auto-resolution) before their next page load.
  const conflicts = await resolveConflicts(sb);

  return NextResponse.json({ ok: true, drain, conflicts });
}
