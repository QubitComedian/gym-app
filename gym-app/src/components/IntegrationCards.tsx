/**
 * IntegrationCards — Strava & Garmin connect/sync/disconnect tiles.
 *
 * Rendered on /you and on /you/integrations. Fetches /api/integrations/status
 * on mount and after any user action. Never handles tokens client-side.
 */

'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { format, parseISO } from 'date-fns';

type ProviderStatus = {
  connected: boolean;
  status: 'active' | 'error' | 'revoked' | 'pending' | null;
  last_synced_at: string | null;
  last_error: string | null;
  athlete?: any;
  activity_count: number;
};

type StatusResponse = { strava: ProviderStatus; garmin: ProviderStatus };

type ProviderKey = 'strava' | 'garmin';
const META: Record<ProviderKey, { name: string; color: string; description: string; connectHref: string; supportsSync: boolean }> = {
  strava: {
    name: 'Strava',
    color: 'text-coral',
    description: 'Auto-import runs, rides, and swims. HR and pace flow straight into your history.',
    connectHref: '/api/integrations/strava/connect',
    supportsSync: true,
  },
  garmin: {
    name: 'Garmin',
    color: 'text-iris',
    description: 'Connect your Garmin Health account to pull activities and body metrics.',
    connectHref: '/api/integrations/garmin/connect',
    supportsSync: false, // wired later — sync pipeline for Garmin TBD
  },
};

export default function IntegrationCards({ compact = false }: { compact?: boolean }) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<string | null>(null);
  const [bannerTone, setBannerTone] = useState<'ok' | 'error'>('ok');

  async function load() {
    setLoading(true);
    try {
      const res = await fetch('/api/integrations/status', { cache: 'no-store' });
      if (res.ok) setStatus(await res.json());
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }

  // Read query params to display "connected!" or "error" from OAuth callback.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const mk = (provider: ProviderKey) => {
      const v = sp.get(provider);
      if (v === 'connected') { setBanner(`${META[provider].name} connected.`); setBannerTone('ok'); }
      else if (v === 'error') {
        setBanner(`${META[provider].name} couldn't connect (${sp.get('reason') || 'unknown'}).`);
        setBannerTone('error');
      }
    };
    mk('strava'); mk('garmin');
    load();
  }, []);

  return (
    <section className={compact ? 'card' : 'card-raised'}>
      <div className="flex items-center justify-between gap-3 mb-2">
        <div>
          <div className="section-eyebrow">Fitness integrations</div>
          <div className="text-lg font-semibold mt-1">Auto-import activities</div>
        </div>
        {!compact && (
          <Link href="/you/integrations" className="text-tiny text-accent hover:underline">Manage →</Link>
        )}
      </div>

      {banner && (
        <div className={`mb-3 rounded-xl border px-3 py-2 text-small ${
          bannerTone === 'ok'
            ? 'border-accent/40 bg-accent-soft/30 text-accent'
            : 'border-coral/40 bg-coral-soft/30 text-coral'
        }`}>
          {banner}
        </div>
      )}

      <div className="space-y-2">
        <ProviderCard provider="strava" status={status?.strava} loading={loading} onChange={load} />
        <ProviderCard provider="garmin" status={status?.garmin} loading={loading} onChange={load} />
      </div>
    </section>
  );
}

function ProviderCard({
  provider, status, loading, onChange,
}: {
  provider: ProviderKey;
  status: ProviderStatus | undefined;
  loading: boolean;
  onChange: () => void;
}) {
  const [busy, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const meta = META[provider];

  async function sync() {
    setErr(null);
    startTransition(async () => {
      const res = await fetch(`/api/integrations/${provider}/sync`, { method: 'POST' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) setErr(j?.error || 'Sync failed');
      onChange();
    });
  }

  async function disconnect() {
    if (!confirm(`Disconnect ${meta.name}? Existing imported activities will remain.`)) return;
    setErr(null);
    startTransition(async () => {
      const res = await fetch(`/api/integrations/${provider}/disconnect`, { method: 'POST' });
      if (!res.ok) { const j = await res.json().catch(() => ({})); setErr(j?.error || 'Failed'); }
      onChange();
    });
  }

  return (
    <div className="rounded-2xl border border-panel-2 bg-panel-3 p-3 flex items-start gap-3">
      <div className={`h-10 w-10 rounded-xl bg-panel-2 border border-border flex items-center justify-center font-bold ${meta.color}`}>
        {meta.name[0]}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <div className="text-small font-semibold">{meta.name}</div>
          {loading ? (
            <span className="text-tiny text-muted">checking…</span>
          ) : status?.connected ? (
            <span className={`text-tiny px-1.5 py-0.5 rounded-full border ${
              status.status === 'error' ? 'border-coral/40 text-coral bg-coral-soft/30' : 'border-accent/40 text-accent bg-accent-soft/30'
            }`}>
              {status.status === 'error' ? 'error' : 'connected'}
            </span>
          ) : (
            <span className="text-tiny text-muted">not connected</span>
          )}
        </div>
        <div className="text-tiny text-muted-2 mt-0.5 leading-relaxed">{meta.description}</div>

        {status?.connected && (
          <div className="mt-2 text-tiny text-muted space-y-0.5">
            <div>
              {status.activity_count} activit{status.activity_count === 1 ? 'y' : 'ies'} imported
              {status.last_synced_at && (
                <> · last sync {format(parseISO(status.last_synced_at), 'MMM d, HH:mm')}</>
              )}
            </div>
            {status.last_error && (
              <div className="text-coral">Last error: {status.last_error}</div>
            )}
          </div>
        )}

        {err && <div className="mt-2 text-tiny text-coral">{err}</div>}

        <div className="mt-3 flex gap-2 flex-wrap">
          {!status?.connected ? (
            <a href={meta.connectHref} className="btn btn-primary text-tiny">Connect</a>
          ) : (
            <>
              {meta.supportsSync && (
                <button type="button" onClick={sync} disabled={busy} className="btn btn-secondary text-tiny disabled:opacity-50">
                  {busy ? 'Syncing…' : 'Sync now'}
                </button>
              )}
              <button type="button" onClick={disconnect} disabled={busy} className="btn btn-ghost text-tiny disabled:opacity-50">
                Disconnect
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
