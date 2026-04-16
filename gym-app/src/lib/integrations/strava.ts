/**
 * Strava OAuth2 + activities helpers.
 *
 * Strava's flow:
 *   1. Redirect user to https://www.strava.com/oauth/authorize with scope
 *      `read,activity:read_all` and our client_id + redirect_uri.
 *   2. Strava redirects back to our callback with ?code=xxx
 *   3. POST to https://www.strava.com/oauth/token to exchange code → tokens.
 *   4. Store { access_token, refresh_token, expires_at, athlete_id } on
 *      integration_accounts.
 *   5. Pull activities from /api/v3/athlete/activities (page by page) or
 *      listen on webhooks for /push_subscriptions.
 *
 * All the Strava-specific types live here so API routes stay compact.
 */

export const STRAVA_AUTH_URL = 'https://www.strava.com/oauth/authorize';
export const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
export const STRAVA_API = 'https://www.strava.com/api/v3';

export function stravaAuthorizeUrl(state: string): string {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const redirect = process.env.STRAVA_REDIRECT_URI;
  if (!clientId || !redirect) throw new Error('Strava env not configured');
  const qs = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirect,
    scope: 'read,activity:read_all,profile:read_all',
    state,
    approval_prompt: 'auto',
  });
  return `${STRAVA_AUTH_URL}?${qs.toString()}`;
}

export type StravaTokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_at: number;   // unix seconds
  athlete?: {
    id: number;
    firstname?: string;
    lastname?: string;
  };
};

export async function exchangeStravaCode(code: string): Promise<StravaTokenResponse> {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Strava env not configured');

  const res = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`Strava token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function refreshStravaToken(refreshToken: string): Promise<StravaTokenResponse> {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Strava env not configured');
  const res = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Strava refresh failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export type StravaActivity = {
  id: number;
  name: string;
  type: string;            // "Run", "Ride", "Swim", "WeightTraining", "Yoga", …
  sport_type?: string;
  start_date: string;       // ISO UTC
  start_date_local: string; // ISO local
  elapsed_time: number;     // seconds
  moving_time: number;
  distance: number;         // meters
  total_elevation_gain?: number;
  average_heartrate?: number;
  max_heartrate?: number;
  average_watts?: number;
  calories?: number;
};

export async function listStravaActivities(
  accessToken: string,
  opts: { afterEpoch?: number; perPage?: number; page?: number } = {}
): Promise<StravaActivity[]> {
  const { afterEpoch, perPage = 30, page = 1 } = opts;
  const qs = new URLSearchParams({
    per_page: String(perPage),
    page: String(page),
  });
  if (afterEpoch) qs.set('after', String(afterEpoch));
  const res = await fetch(`${STRAVA_API}/athlete/activities?${qs.toString()}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Strava list failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Map a raw Strava sport_type into our internal `activities.type` enum. */
export function mapStravaTypeToInternal(s: Pick<StravaActivity, 'type' | 'sport_type'>): string {
  const raw = (s.sport_type || s.type || '').toLowerCase();
  if (raw.includes('run')) return 'run';
  if (raw.includes('ride') || raw.includes('bike') || raw.includes('cycle')) return 'bike';
  if (raw.includes('swim')) return 'swim';
  if (raw.includes('weight') || raw === 'workout') return 'gym';
  if (raw.includes('yoga')) return 'yoga';
  if (raw.includes('climb') || raw.includes('boulder')) return 'climb';
  if (raw.includes('walk') || raw.includes('hike')) return 'mobility';
  return 'gym';
}
