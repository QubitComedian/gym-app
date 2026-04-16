/**
 * GET /api/integrations/garmin/callback
 *
 * Garmin redirects here with ?oauth_token=<requestToken>&oauth_verifier=<verifier>.
 * We sign an access_token request with the request_token_secret we stashed
 * in the cookie during /connect, and persist the resulting pair.
 */

import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { exchangeGarminVerifier } from '@/lib/integrations/garmin';

export const runtime = 'nodejs';

function redirectTo(appUrl: string, query: string) {
  return NextResponse.redirect(new URL(`/you/integrations?${query}`, appUrl));
}

export async function GET(req: Request) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const url = new URL(req.url);
  const requestToken = url.searchParams.get('oauth_token');
  const verifier = url.searchParams.get('oauth_verifier');

  if (!requestToken || !verifier) {
    return redirectTo(appUrl, 'garmin=error&reason=missing_params');
  }

  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.redirect(new URL('/signin', appUrl));

  const cookieHeader = req.headers.get('cookie') ?? '';
  const secret = cookieHeader.match(/garmin_oauth_secret=([^;]+)/)?.[1];
  const flowUser = cookieHeader.match(/garmin_oauth_user=([^;]+)/)?.[1];
  if (!secret) return redirectTo(appUrl, 'garmin=error&reason=missing_secret');
  if (flowUser && flowUser !== user.id) return redirectTo(appUrl, 'garmin=error&reason=user_mismatch');

  let tokens;
  try {
    tokens = await exchangeGarminVerifier(requestToken, secret, verifier);
  } catch (e: any) {
    console.error('[garmin/callback] exchange failed', e?.message);
    return redirectTo(appUrl, 'garmin=error&reason=exchange_failed');
  }

  const { error: dbErr } = await sb.from('integration_accounts').upsert(
    {
      user_id: user.id,
      provider: 'garmin',
      access_token: tokens.oauth_token,
      token_secret: tokens.oauth_token_secret,
      refresh_token: null,
      expires_at: null, // Garmin OAuth1 tokens don't expire unless revoked
      status: 'active',
      last_error: null,
      metadata: { connected_at: new Date().toISOString() },
    },
    { onConflict: 'user_id,provider' },
  );
  if (dbErr) {
    console.error('[garmin/callback] upsert failed', dbErr);
    return redirectTo(appUrl, 'garmin=error&reason=db_error');
  }

  const res = redirectTo(appUrl, 'garmin=connected');
  res.cookies.set('garmin_oauth_secret', '', { path: '/', maxAge: 0 });
  res.cookies.set('garmin_oauth_user',   '', { path: '/', maxAge: 0 });
  return res;
}
