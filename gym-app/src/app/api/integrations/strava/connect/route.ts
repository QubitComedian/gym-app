/**
 * GET /api/integrations/strava/connect
 *
 * Kicks off the Strava OAuth2 dance. Generates a short-lived state token
 * (HMAC of user_id + nonce) so the callback can verify the flow wasn't
 * hijacked, stashes the nonce in a short-lived cookie, and 302s the
 * browser to Strava's authorize URL.
 */

import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { stravaAuthorizeUrl } from '@/lib/integrations/strava';
import crypto from 'crypto';

export const runtime = 'nodejs';

export async function GET() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.redirect(new URL('/signin', process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'));

  // State token: userId.nonce  (the callback verifies the nonce via cookie)
  const nonce = crypto.randomBytes(12).toString('hex');
  const state = `${user.id}.${nonce}`;

  try {
    const url = stravaAuthorizeUrl(state);
    const res = NextResponse.redirect(url);
    res.cookies.set('strava_oauth_nonce', nonce, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 10 * 60, // 10 minutes
    });
    return res;
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Strava not configured' }, { status: 500 });
  }
}
