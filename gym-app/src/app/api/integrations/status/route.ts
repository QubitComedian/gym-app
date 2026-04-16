/**
 * GET /api/integrations/status
 *
 * Returns a compact summary for the /you/integrations page:
 *   {
 *     strava: { connected, status, last_synced_at, athlete, activity_count },
 *     garmin: { connected, status, last_synced_at, activity_count },
 *   }
 * We never return tokens — only metadata safe for the client.
 */

import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';

type ProviderStatus = {
  connected: boolean;
  status: 'active' | 'error' | 'revoked' | 'pending' | null;
  last_synced_at: string | null;
  last_error: string | null;
  athlete?: any;
  activity_count: number;
};

export async function GET() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { data: accts } = await sb
    .from('integration_accounts')
    .select('provider,status,last_synced_at,last_error,metadata')
    .eq('user_id', user.id);

  // Count imported activities per provider.
  const { data: counts } = await sb
    .from('integration_activities')
    .select('provider')
    .eq('user_id', user.id);
  const countByProvider = new Map<string, number>();
  (counts ?? []).forEach((r) => {
    countByProvider.set(r.provider, (countByProvider.get(r.provider) ?? 0) + 1);
  });

  const byProvider = new Map((accts ?? []).map((a) => [a.provider, a]));

  function make(provider: string): ProviderStatus {
    const a = byProvider.get(provider);
    return {
      connected: !!a,
      status: (a?.status as any) ?? null,
      last_synced_at: a?.last_synced_at ?? null,
      last_error: a?.last_error ?? null,
      athlete: a?.metadata?.athlete ?? null,
      activity_count: countByProvider.get(provider) ?? 0,
    };
  }

  return NextResponse.json({
    strava: make('strava'),
    garmin: make('garmin'),
  });
}
