/**
 * POST /api/integrations/strava/sync
 *
 * Pulls recent activities from Strava and:
 *   1. Stores raw payloads in integration_activities (dedup by (user, provider, provider_activity_id))
 *   2. Maps them to internal `activities` rows (if not already mapped)
 *   3. Also extracts body weight from athlete profile if Strava has it
 *
 * Handles:
 *   - Expired access token → refresh via refresh_token, update row
 *   - Rate limit (429) → bail gracefully with status='error' + last_error
 *   - Partial page fetches — we pull up to 3 pages (90 activities) per call
 *
 * Query: ?since=epochSeconds to override the default "since last_synced_at"
 */

import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import {
  listStravaActivities,
  refreshStravaToken,
  mapStravaTypeToInternal,
  type StravaActivity,
} from '@/lib/integrations/strava';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: Request) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const sinceOverride = url.searchParams.get('since');

  const { data: acct, error: acctErr } = await sb
    .from('integration_accounts')
    .select('*')
    .eq('user_id', user.id)
    .eq('provider', 'strava')
    .maybeSingle();
  if (acctErr) return NextResponse.json({ error: acctErr.message }, { status: 500 });
  if (!acct) return NextResponse.json({ error: 'not_connected' }, { status: 400 });

  // Refresh if token is within 2 minutes of expiring.
  let accessToken: string = acct.access_token;
  let expiresAt: Date | null = acct.expires_at ? new Date(acct.expires_at) : null;
  const needsRefresh = !expiresAt || expiresAt.getTime() - Date.now() < 2 * 60 * 1000;
  if (needsRefresh && acct.refresh_token) {
    try {
      const refreshed = await refreshStravaToken(acct.refresh_token);
      accessToken = refreshed.access_token;
      expiresAt = new Date(refreshed.expires_at * 1000);
      await sb.from('integration_accounts').update({
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        expires_at: expiresAt.toISOString(),
        status: 'active',
        last_error: null,
      }).eq('id', acct.id);
    } catch (e: any) {
      await sb.from('integration_accounts').update({
        status: 'error',
        last_error: `refresh failed: ${e?.message}`,
      }).eq('id', acct.id);
      return NextResponse.json({ error: 'refresh_failed', detail: e?.message }, { status: 500 });
    }
  }

  // Decide `after` watermark. If the user has never synced, default to 90 days
  // back so we don't pull 10 years of data on first connect.
  const lastSynced = acct.last_synced_at ? new Date(acct.last_synced_at) : null;
  const defaultAfter = Math.floor((Date.now() - 90 * 86400 * 1000) / 1000);
  const afterEpoch = sinceOverride
    ? Number(sinceOverride)
    : lastSynced
      ? Math.max(Math.floor(lastSynced.getTime() / 1000) - 3600, defaultAfter) // 1h overlap
      : defaultAfter;

  // Pull up to 3 pages of 30 activities (90 total). Each page is cheap.
  const pulled: StravaActivity[] = [];
  for (let page = 1; page <= 3; page++) {
    try {
      const items = await listStravaActivities(accessToken, { afterEpoch, perPage: 30, page });
      if (!items.length) break;
      pulled.push(...items);
      if (items.length < 30) break;
    } catch (e: any) {
      await sb.from('integration_accounts').update({
        status: 'error',
        last_error: `list failed: ${e?.message}`,
      }).eq('id', acct.id);
      return NextResponse.json({ error: 'list_failed', detail: e?.message }, { status: 502 });
    }
  }

  let newRaw = 0, newActivities = 0, duplicates = 0;

  for (const s of pulled) {
    const internalType = mapStravaTypeToInternal(s);
    const providerActivityId = String(s.id);

    // Raw upsert
    const { data: existingRaw } = await sb
      .from('integration_activities')
      .select('id, activity_id')
      .eq('user_id', user.id)
      .eq('provider', 'strava')
      .eq('provider_activity_id', providerActivityId)
      .maybeSingle();

    if (existingRaw) {
      duplicates++;
      continue;
    }

    // Insert raw record first so we have a parking spot even if mapping fails.
    const { data: rawRow, error: rawErr } = await sb.from('integration_activities').insert({
      user_id: user.id,
      provider: 'strava',
      provider_activity_id: providerActivityId,
      started_at: s.start_date,
      type: internalType,
      name: s.name,
      distance_m: s.distance ?? null,
      duration_s: s.moving_time ?? s.elapsed_time ?? null,
      elevation_gain_m: s.total_elevation_gain ?? null,
      average_hr: s.average_heartrate ? Math.round(s.average_heartrate) : null,
      max_hr: s.max_heartrate ? Math.round(s.max_heartrate) : null,
      average_watts: s.average_watts ?? null,
      payload: s,
      import_status: 'imported',
    }).select('id').maybeSingle();
    if (rawErr) {
      console.warn('[strava/sync] raw insert failed', rawErr.message);
      continue;
    }
    newRaw++;

    // Create canonical activity. Its date/type/data shape must match the
    // activities schema defined in 0001_init.sql:
    //   run|bike: { distance_km, duration_s, avg_pace_s_per_km, rpe, hr_avg?, route? }
    //   yoga|mobility: { duration_min, intensity, notes }
    //   climb: { duration_min, location }
    //   gym: { … (we leave sets empty because Strava doesn't have set-level data) }
    const dateStr = s.start_date.slice(0, 10);
    const durS = s.moving_time ?? s.elapsed_time ?? null;
    const hr = s.average_heartrate ? Math.round(s.average_heartrate) : null;
    let dataShape: Record<string, any> = {};
    if (internalType === 'run' || internalType === 'bike') {
      const km = s.distance ? s.distance / 1000 : null;
      const pace = km && durS ? Math.round(durS / km) : null;
      dataShape = {
        distance_km: km,
        duration_s: durS,
        avg_pace_s_per_km: pace,
        hr_avg: hr,
        elevation_m: s.total_elevation_gain ?? null,
        strava_id: s.id,
      };
    } else if (internalType === 'yoga' || internalType === 'mobility') {
      dataShape = { duration_min: durS ? Math.round(durS / 60) : null, strava_id: s.id };
    } else if (internalType === 'climb') {
      dataShape = { duration_min: durS ? Math.round(durS / 60) : null, strava_id: s.id };
    } else if (internalType === 'swim') {
      dataShape = { distance_m: s.distance ?? null, duration_s: durS, hr_avg: hr, strava_id: s.id };
    } else {
      dataShape = { duration_min: durS ? Math.round(durS / 60) : null, hr_avg: hr, strava_id: s.id };
    }

    const { data: actRow, error: actErr } = await sb.from('activities').insert({
      user_id: user.id,
      date: dateStr,
      type: internalType,
      status: 'done',
      source: 'import',
      notes: s.name,
      data: dataShape,
      started_at: s.start_date,
      completed_at: s.start_date,
    }).select('id').maybeSingle();

    if (actErr) {
      console.warn('[strava/sync] activity insert failed', actErr.message);
      continue;
    }
    newActivities++;

    // Link raw → canonical
    if (actRow && rawRow) {
      await sb.from('integration_activities').update({ activity_id: actRow.id }).eq('id', rawRow.id);
    }
  }

  await sb.from('integration_accounts').update({
    last_synced_at: new Date().toISOString(),
    status: 'active',
    last_error: null,
  }).eq('id', acct.id);

  return NextResponse.json({
    ok: true,
    pulled: pulled.length,
    new_raw: newRaw,
    new_activities: newActivities,
    duplicates,
    since_epoch: afterEpoch,
  });
}
