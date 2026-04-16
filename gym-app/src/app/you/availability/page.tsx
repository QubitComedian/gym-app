/**
 * /you/availability — server entry point for the availability windows list.
 *
 * Loads the user's windows (active + cancelled + past), derives the
 * "today" ISO in their timezone, and hands everything to the client
 * component for list rendering + create/edit/cancel flows.
 *
 * Past / cancelled windows are included but client-side they're
 * collapsed under a "Recent" disclosure — the UI foregrounds what's
 * coming up and what's active now.
 */

import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { formatInTimeZone } from '@/lib/reconcile/tz';
import AvailabilityClient from './AvailabilityClient';
import type { WindowRow } from './types';

export const dynamic = 'force-dynamic';

export default async function AvailabilityPage() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect('/login');

  // Profile → timezone → today (matches the server apply path so the UI's
  // "active vs upcoming" sort agrees with what the backend enforces).
  const { data: profile } = await sb
    .from('profiles')
    .select('timezone')
    .eq('user_id', user.id)
    .maybeSingle();
  const tz = (profile?.timezone as string | null) || 'UTC';
  const todayIso = formatInTimeZone(new Date(), tz, 'yyyy-MM-dd');

  const { data } = await sb
    .from('availability_windows')
    .select('id, starts_on, ends_on, kind, strategy, note, metadata, status, created_at, cancelled_at')
    .eq('user_id', user.id)
    .order('starts_on', { ascending: false });

  const windows = (data ?? []) as WindowRow[];

  return <AvailabilityClient windows={windows} todayIso={todayIso} />;
}
