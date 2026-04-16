/**
 * POST /api/integrations/strava/disconnect
 *
 * Revokes the access token on Strava's side (best-effort) and deletes the row.
 * We keep the integration_activities rows — they already map to real activities
 * and shouldn't disappear just because the connection ended.
 */

import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export async function POST() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { data: acct } = await sb
    .from('integration_accounts')
    .select('access_token')
    .eq('user_id', user.id)
    .eq('provider', 'strava')
    .maybeSingle();

  // Best-effort revoke — ignore errors because we want to delete locally regardless.
  if (acct?.access_token) {
    try {
      await fetch('https://www.strava.com/oauth/deauthorize', {
        method: 'POST',
        headers: { authorization: `Bearer ${acct.access_token}` },
      });
    } catch { /* ignore */ }
  }

  await sb.from('integration_accounts').delete()
    .eq('user_id', user.id)
    .eq('provider', 'strava');

  return NextResponse.json({ ok: true });
}
