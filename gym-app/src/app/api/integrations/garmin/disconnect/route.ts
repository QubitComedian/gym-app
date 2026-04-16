/**
 * POST /api/integrations/garmin/disconnect
 *
 * Just deletes the row. Garmin doesn't expose a first-party revoke endpoint
 * via the Health API (revoking is a user-initiated action in Garmin Connect
 * under "Apps with access"). We surface that caveat in the UI.
 */

import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export async function POST() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  await sb.from('integration_accounts').delete()
    .eq('user_id', user.id)
    .eq('provider', 'garmin');

  return NextResponse.json({ ok: true, note: 'To fully revoke, visit Garmin Connect → Account → Apps with access.' });
}
