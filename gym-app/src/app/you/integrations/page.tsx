/**
 * /you/integrations — one place for every third-party connection.
 *
 * Bundles:
 *   - Strava (IntegrationCards — handles connect/sync/disconnect client-side)
 *   - Google Calendar (GoogleSection — push planned sessions + status)
 *
 * Previously Google was floating on /you directly, split from Strava.
 * Co-locating them makes integrations discoverable and matches the
 * user's mental model of "settings > integrations > provider".
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import IntegrationCards from '@/components/IntegrationCards';
import { GoogleSection } from '@/components/you/sections';
import { loadGoogleStatus } from '../loader';

export const dynamic = 'force-dynamic';

export default async function IntegrationsPage() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect('/login');

  const google = await loadGoogleStatus(user.id);

  return (
    <main className="max-w-xl mx-auto px-4 pt-5 pb-28 space-y-5">
      <header>
        <Link href="/you" className="text-tiny text-muted hover:text-ink">← You</Link>
        <h1 className="text-2xl font-bold tracking-tight mt-1">Integrations</h1>
        <p className="text-small text-muted-2 mt-1 leading-relaxed">
          Connect Strava to auto-log activities and push your training plan to
          Google Calendar. Data only flows IN from fitness providers — we never
          post workouts back to Strava.
        </p>
      </header>

      <IntegrationCards />

      <GoogleSection google={google} />

      <section className="card">
        <div className="section-eyebrow">How it works</div>
        <ul className="text-small text-muted-2 leading-relaxed space-y-2 mt-2">
          <li>
            <span className="text-ink font-medium">Initial sync.</span> The first sync pulls up to 90 days of history. After
            that we only fetch what&apos;s new since the last run.
          </li>
          <li>
            <span className="text-ink font-medium">Dedup.</span> We key off the provider&apos;s own activity id, so reconnecting
            never creates duplicates.
          </li>
          <li>
            <span className="text-ink font-medium">Tokens.</span> OAuth tokens are stored encrypted at rest and are only ever
            read by our server during a sync.
          </li>
          <li>
            <span className="text-ink font-medium">Disconnect.</span> Removing the connection keeps your already-imported
            activities. The raw payload history stays in the audit table, but we
            stop pulling new data immediately.
          </li>
        </ul>
      </section>
    </main>
  );
}
