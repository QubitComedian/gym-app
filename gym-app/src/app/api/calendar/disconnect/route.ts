/**
 * POST /api/calendar/disconnect (P1.4 / PR-V).
 *
 * Stops Google Calendar sync. Sets token status to 'revoked' and
 * clears training_calendar_id. Does NOT delete the Google calendar
 * or its events — past events stay in place (design doc §8).
 */

import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { disconnectCalendar } from '@/lib/google/connect';

export async function POST() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const result = await disconnectCalendar(sb, user.id);
  return NextResponse.json({ ok: true, ...result });
}
