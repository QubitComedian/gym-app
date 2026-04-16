/**
 * GET /api/calendar/status (P1.4 / PR-V).
 *
 * Returns the user's Google Calendar connection status for the
 * integrations settings page.
 */

import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { getCalendarStatus } from '@/lib/google/connect';

export async function GET() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const status = await getCalendarStatus(sb, user.id);
  return NextResponse.json(status);
}
