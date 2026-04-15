import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import SettingsClient from './SettingsClient';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function Settings() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect('/login');

  const { data: tok } = await sb.from('google_tokens').select('expires_at,scope').eq('user_id', user.id).maybeSingle();
  const { count: eventCount } = await sb.from('calendar_events').select('*', { count: 'exact', head: true }).eq('user_id', user.id);
  const { count: linkCount } = await sb.from('calendar_links').select('*', { count: 'exact', head: true }).eq('user_id', user.id);

  return (
    <main className="max-w-xl mx-auto px-4 py-6 pb-28">
      <Link href="/today" className="text-xs text-muted">← back</Link>
      <h1 className="text-2xl font-bold tracking-tight mt-2 mb-4">Settings</h1>

      <section className="rounded-xl bg-panel border border-border p-4 mb-4">
        <div className="text-[10px] uppercase tracking-wider text-muted mb-1">Google Calendar</div>
        <div className="text-sm">
          {tok ? <>Connected · token expires {new Date(tok.expires_at).toLocaleString()}</> : 'Not connected. Sign out and back in to grant calendar access.'}
        </div>
        <div className="text-xs text-muted mt-1">{eventCount ?? 0} events imported · {linkCount ?? 0} plans pushed</div>
      </section>

      <SettingsClient hasToken={!!tok} />

      <section className="mt-6 text-xs text-muted">
        <p>If your gym events are in a non-primary calendar, paste its calendar ID below before syncing. (You can find it in Google Calendar settings → Integrate calendar → Calendar ID.)</p>
      </section>
    </main>
  );
}
