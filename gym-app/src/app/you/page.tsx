/**
 * /you — category hub. See HubClient for layout.
 *
 * This page is intentionally thin: the hub's role is to route the user
 * to the right sub-page, not to re-render every section. Deep data
 * fetching lives in loader.ts per-subpage.
 */

import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import HubClient from './HubClient';
import { loadHubSummary } from './loader';

export const dynamic = 'force-dynamic';

export default async function You() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect('/login');

  const summary = await loadHubSummary(user.id);

  return (
    <HubClient
      user={{ email: user.email ?? '', id: user.id }}
      summary={summary}
    />
  );
}
