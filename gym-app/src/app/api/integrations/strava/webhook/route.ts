/**
 * Strava push subscription webhook.
 *
 * Strava calls:
 *   GET  → verification handshake. Return { "hub.challenge": <value> }.
 *   POST → event notification. Shape:
 *          { aspect_type: "create"|"update"|"delete",
 *            event_time: 1234, object_id: 123, object_type: "activity"|"athlete",
 *            owner_id: 456, subscription_id: 789, updates: {...} }
 *
 * We don't pull the full activity here (Strava's activity-level fetch requires
 * an access_token per-athlete); instead we mark the athlete's integration_account
 * as dirty by bumping `metadata.pending_events` and letting the next /sync call
 * catch up. This keeps the webhook endpoint < 1s which is what Strava requires.
 */

import { NextResponse } from 'next/server';
import { supabaseServiceRole } from '@/lib/supabase/server';

export const runtime = 'nodejs';

// GET: handshake. Strava sends hub.mode=subscribe&hub.verify_token=&hub.challenge=
export async function GET(req: Request) {
  const url = new URL(req.url);
  const verifyToken = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  const mode = url.searchParams.get('hub.mode');

  const expected = process.env.STRAVA_VERIFY_TOKEN;
  if (mode !== 'subscribe' || !expected || verifyToken !== expected || !challenge) {
    return NextResponse.json({ error: 'verify_failed' }, { status: 403 });
  }
  return NextResponse.json({ 'hub.challenge': challenge });
}

// POST: event. We have ~2s to ack — do the minimum and return 200.
export async function POST(req: Request) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: true }); }

  // Only care about activity-level creates/updates/deletes for athletes we know.
  const ownerId = body?.owner_id ? String(body.owner_id) : null;
  if (!ownerId) return NextResponse.json({ ok: true });

  const sb = supabaseServiceRole();
  const { data: acct } = await sb
    .from('integration_accounts')
    .select('id, metadata')
    .eq('provider', 'strava')
    .eq('provider_user_id', ownerId)
    .maybeSingle();
  if (!acct) return NextResponse.json({ ok: true }); // not our user

  const pending = Array.isArray(acct.metadata?.pending_events) ? acct.metadata.pending_events : [];
  pending.push({
    at: new Date().toISOString(),
    aspect_type: body.aspect_type,
    object_id: body.object_id,
    object_type: body.object_type,
    updates: body.updates ?? null,
  });
  // Trim so we never store > 100 pending events.
  const trimmed = pending.slice(-100);
  await sb.from('integration_accounts').update({
    metadata: { ...(acct.metadata ?? {}), pending_events: trimmed },
  }).eq('id', acct.id);

  return NextResponse.json({ ok: true });
}
