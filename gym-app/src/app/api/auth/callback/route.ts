import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';

/**
 * OAuth callback from Supabase → Google.
 * Exchanges the code for a session, then stores the Google provider tokens
 * in `google_tokens` so later server-side jobs can call Calendar API.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) return NextResponse.redirect(`${url.origin}/login?err=nocode`);

  const supabase = supabaseServer();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(`${url.origin}/login?err=${encodeURIComponent(error.message)}`);

  // Persist Google provider tokens so we can call Calendar API off-session.
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.provider_token && session.user) {
    await supabase.from('google_tokens').upsert({
      user_id: session.user.id,
      access_token: session.provider_token,
      refresh_token: session.provider_refresh_token ?? '',
      expires_at: new Date(Date.now() + (session.expires_in ?? 3600) * 1000).toISOString(),
      scope: 'https://www.googleapis.com/auth/calendar',
    });
  }

  return NextResponse.redirect(`${url.origin}/`);
}
