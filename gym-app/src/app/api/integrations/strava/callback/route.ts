/**
 * GET /api/integrations/strava/callback
 *
 * Strava bounces the user back here with ?code=…&state=userId.nonce.
 * We:
 *   1. Verify the nonce matches the cookie we set at /connect
 *   2. Exchange the code for tokens
 *   3. Upsert into integration_accounts (one row per (user, 'strava'))
 *   4. Redirect the user back to /you/integrations with a status flag
 *
 * Any error path redirects to /you/integrations?strava=error&reason=…
 * so the UI can render a useful toast instead of a raw 500.
 */

import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { exchangeStravaCode } from '@/lib/integrations/strava';

export const runtime = 'nodejs';

function redirectTo(appUrl: string, query: string) {
  return NextResponse.redirect(new URL(`/you/integrations?${query}`, appUrl));
}

export async function GET(req: Request) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') || '';
  const error = url.searchParams.get('error');
  const scope = url.searchParams.get('scope') || '';

  if (error) return redirectTo(appUrl, `strava=error&reason=${encodeURIComponent(error)}`);
  if (!code) return redirectTo(appUrl, 'strava=error&reason=missing_code');

  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.redirect(new URL('/signin', appUrl));

  // Verify state: "<userId>.<nonce>"
  const [stateUserId, stateNonce] = state.split('.');
  if (stateUserId !== user.id) return redirectTo(appUrl, 'strava=error&reason=state_mismatch');

  const nonceCookie = req.headers.get('cookie')?.match(/strava_oauth_nonce=([^;]+)/)?.[1];
  if (!nonceCookie || nonceCookie !== stateNonce) {
    return redirectTo(appUrl, 'strava=error&reason=nonce_mismatch');
  }

  // Strava requires the activity:read_all scope to list historical activities.
  if (!scope.includes('activity:read_all')) {
    return redirectTo(appUrl, 'strava=error&reason=missing_scope');
  }

  let tokens;
  try {
    tokens = await exchangeStravaCode(code);
  } catch (e: any) {
    console.error('[strava/callback] exchange failed', e?.message);
    return redirectTo(appUrl, `strava=error&reason=exchange_failed`);
  }

  const expiresISO = new Date(tokens.expires_at * 1000).toISOString();

  // Upsert by (user_id, provider)
  const { error: dbErr } = await sb.from('integration_accounts').upsert(
    {
      user_id: user.id,
      provider: 'strava',
      provider_user_id: tokens.athlete?.id ? String(tokens.athlete.id) : null,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: expiresISO,
      scope: 'read,activity:read_all,profile:read_all',
      status: 'active',
      last_error: null,
      metadata: {
        athlete: tokens.athlete ?? null,
        connected_at: new Date().toISOString(),
      },
    },
    { onConflict: 'user_id,provider' },
  );
  if (dbErr) {
    console.error('[strava/callback] upsert failed', dbErr);
    return redirectTo(appUrl, 'strava=error&reason=db_error');
  }

  // Fire-and-forget an initial sync — no await, runs best-effort.
  try {
    fetch(new URL('/api/integrations/strava/sync', appUrl), {
      method: 'POST',
      headers: { cookie: req.headers.get('cookie') ?? '' },
    }).catch(() => { /* best effort */ });
  } catch { /* ignore */ }

  const res = redirectTo(appUrl, 'strava=connected');
  res.cookies.set('strava_oauth_nonce', '', { path: '/', maxAge: 0 });
  return res;
}
