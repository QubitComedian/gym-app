import { google } from 'googleapis';
import { supabaseServer } from '@/lib/supabase/server';

export async function getCalendarClient(userId: string) {
  const sb = supabaseServer();
  const { data: tok } = await sb.from('google_tokens').select('*').eq('user_id', userId).maybeSingle();
  if (!tok) throw new Error('No Google tokens stored. Sign out and back in to grant calendar access.');

  const oauth2 = new google.auth.OAuth2();
  oauth2.setCredentials({
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || undefined,
    expiry_date: tok.expires_at ? new Date(tok.expires_at).getTime() : undefined,
  });

  // Persist refreshed tokens
  oauth2.on('tokens', async (newTok) => {
    const update: any = {};
    if (newTok.access_token) update.access_token = newTok.access_token;
    if (newTok.refresh_token) update.refresh_token = newTok.refresh_token;
    if (newTok.expiry_date) update.expires_at = new Date(newTok.expiry_date).toISOString();
    if (Object.keys(update).length) await sb.from('google_tokens').update(update).eq('user_id', userId);
  });

  return google.calendar({ version: 'v3', auth: oauth2 });
}

const TYPE_HINTS: { match: RegExp; type: string; day_code?: string }[] = [
  { match: /push/i, type: 'gym', day_code: 'push' },
  { match: /pull/i, type: 'gym', day_code: 'pull' },
  { match: /lower/i, type: 'gym', day_code: 'lower' },
  { match: /(upper.*full|full.*upper)/i, type: 'gym', day_code: 'upper_full' },
  { match: /quality.*run/i, type: 'run', day_code: 'quality_run' },
  { match: /easy.*run/i, type: 'run', day_code: 'easy_run' },
  { match: /\brun\b/i, type: 'run' },
  { match: /\bbike\b|cycling/i, type: 'bike' },
  { match: /\bswim\b/i, type: 'swim' },
  { match: /\byoga\b/i, type: 'yoga' },
  { match: /\bclimb/i, type: 'climb' },
  { match: /sauna|cold/i, type: 'sauna_cold' },
  { match: /mobility|stretch/i, type: 'mobility' },
];

export function classifyEvent(summary: string): { type: string; day_code: string | null } {
  for (const h of TYPE_HINTS) {
    if (h.match.test(summary)) return { type: h.type, day_code: h.day_code ?? null };
  }
  return { type: 'gym', day_code: null };
}
