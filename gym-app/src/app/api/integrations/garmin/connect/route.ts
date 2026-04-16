/**
 * GET /api/integrations/garmin/connect
 *
 * Starts the Garmin OAuth1.0a flow:
 *   1. Request a request_token (signed) from Garmin
 *   2. Stash the request_token_secret in a short-lived cookie (we need it
 *      at callback time to sign the access_token request)
 *   3. Redirect to Garmin's authorize URL
 *
 * Garmin's consumer key/secret come from env (GARMIN_CONSUMER_KEY / _SECRET).
 * The user will be told to complete approval on Garmin's domain, then Garmin
 * redirects back to GARMIN_REDIRECT_URI with ?oauth_token=&oauth_verifier=
 */

import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { requestGarminToken, garminAuthorizeUrl } from '@/lib/integrations/garmin';

export const runtime = 'nodejs';

export async function GET() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.redirect(new URL('/signin', process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'));

  try {
    const { oauth_token, oauth_token_secret } = await requestGarminToken();
    const res = NextResponse.redirect(garminAuthorizeUrl(oauth_token));
    // Stash the request_token_secret — we need it at callback time.
    res.cookies.set('garmin_oauth_secret', oauth_token_secret, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 10 * 60,
    });
    // Also tie the flow to this user so a second tab can't hijack.
    res.cookies.set('garmin_oauth_user', user.id, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 10 * 60,
    });
    return res;
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Garmin not configured' }, { status: 500 });
  }
}
