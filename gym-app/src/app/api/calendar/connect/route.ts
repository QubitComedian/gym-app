/**
 * POST /api/calendar/connect (P1.4 / PR-V).
 *
 * Creates a dedicated training calendar on Google and enqueues a full
 * backfill. Called by the /you/integrations page after the user has
 * already completed OAuth (the auth/callback route stores tokens).
 *
 * Idempotent: safe to call twice — re-uses the existing calendar if
 * it still exists on Google.
 */

import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { connectCalendar } from '@/lib/google/connect';

export const maxDuration = 30;

export async function POST() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  try {
    const result = await connectCalendar(sb, user.id);
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    const status = e?.code ?? e?.response?.status;
    if (status === 401 || status === 403) {
      return NextResponse.json(
        { error: 'Google access denied. Please sign out and back in to re-grant calendar access.' },
        { status: 403 },
      );
    }
    console.error('[calendar/connect] failed', e?.message);
    return NextResponse.json({ error: e?.message ?? 'Unknown error' }, { status: 500 });
  }
}
