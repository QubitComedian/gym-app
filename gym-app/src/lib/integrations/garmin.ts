/**
 * Garmin Connect integration helpers.
 *
 * Garmin's Health API is OAuth1.0a (not OAuth2). Unlike Strava, you need
 * an approved developer program account, and the actual API calls use
 * HMAC-SHA1 signing. We implement a minimal OAuth1 client here so our
 * route handlers stay clean.
 *
 * Flow:
 *   1. POST to https://connectapi.garmin.com/oauth-service/oauth/request_token
 *      (signed with consumer key/secret) → returns a request_token.
 *   2. Redirect user to .../oauth/authorize?oauth_token=<request_token>
 *   3. User approves; Garmin redirects to our callback with
 *      ?oauth_token=<request_token>&oauth_verifier=<verifier>
 *   4. POST /oauth-service/oauth/access_token (signed) → returns
 *      { oauth_token, oauth_token_secret } — this pair is the persistent
 *      credential we store.
 *   5. Pull activities via /wellness-api/rest/activities (signed per call).
 *
 * We only stub the shape here — the actual HMAC signing is done with
 * Node's built-in crypto module to avoid adding a dependency.
 */

import crypto from 'crypto';

export const GARMIN_REQUEST_TOKEN_URL = 'https://connectapi.garmin.com/oauth-service/oauth/request_token';
export const GARMIN_AUTHORIZE_URL     = 'https://connect.garmin.com/oauthConfirm';
export const GARMIN_ACCESS_TOKEN_URL  = 'https://connectapi.garmin.com/oauth-service/oauth/access_token';
export const GARMIN_API               = 'https://apis.garmin.com';

function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function baseString(method: string, url: string, params: Record<string, string>): string {
  const sorted = Object.keys(params).sort().map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`).join('&');
  return [method.toUpperCase(), percentEncode(url), percentEncode(sorted)].join('&');
}

function sign(base: string, consumerSecret: string, tokenSecret = ''): string {
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return crypto.createHmac('sha1', key).update(base).digest('base64');
}

export function garminAuthorizeUrl(requestToken: string): string {
  return `${GARMIN_AUTHORIZE_URL}?oauth_token=${encodeURIComponent(requestToken)}`;
}

export async function requestGarminToken(): Promise<{ oauth_token: string; oauth_token_secret: string }> {
  const ck = process.env.GARMIN_CONSUMER_KEY;
  const cs = process.env.GARMIN_CONSUMER_SECRET;
  const redirect = process.env.GARMIN_REDIRECT_URI;
  if (!ck || !cs || !redirect) throw new Error('Garmin env not configured');

  const url = GARMIN_REQUEST_TOKEN_URL;
  const params: Record<string, string> = {
    oauth_callback: redirect,
    oauth_consumer_key: ck,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: '1.0',
  };
  const base = baseString('POST', url, params);
  const signature = sign(base, cs, '');
  const authHeader =
    'OAuth ' +
    Object.entries({ ...params, oauth_signature: signature })
      .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
      .join(', ');

  const res = await fetch(url, { method: 'POST', headers: { authorization: authHeader } });
  if (!res.ok) throw new Error(`Garmin request token failed: ${res.status} ${await res.text()}`);
  const text = await res.text();
  const p = new URLSearchParams(text);
  const t = p.get('oauth_token');
  const s = p.get('oauth_token_secret');
  if (!t || !s) throw new Error('Garmin malformed request_token response');
  return { oauth_token: t, oauth_token_secret: s };
}

export async function exchangeGarminVerifier(
  requestToken: string,
  requestTokenSecret: string,
  verifier: string
): Promise<{ oauth_token: string; oauth_token_secret: string }> {
  const ck = process.env.GARMIN_CONSUMER_KEY;
  const cs = process.env.GARMIN_CONSUMER_SECRET;
  if (!ck || !cs) throw new Error('Garmin env not configured');

  const url = GARMIN_ACCESS_TOKEN_URL;
  const params: Record<string, string> = {
    oauth_consumer_key: ck,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: requestToken,
    oauth_verifier: verifier,
    oauth_version: '1.0',
  };
  const base = baseString('POST', url, params);
  const signature = sign(base, cs, requestTokenSecret);
  const authHeader =
    'OAuth ' +
    Object.entries({ ...params, oauth_signature: signature })
      .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
      .join(', ');

  const res = await fetch(url, { method: 'POST', headers: { authorization: authHeader } });
  if (!res.ok) throw new Error(`Garmin access_token failed: ${res.status} ${await res.text()}`);
  const p = new URLSearchParams(await res.text());
  const t = p.get('oauth_token');
  const s = p.get('oauth_token_secret');
  if (!t || !s) throw new Error('Garmin malformed access_token response');
  return { oauth_token: t, oauth_token_secret: s };
}
