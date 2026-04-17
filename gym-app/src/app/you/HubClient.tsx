/**
 * HubClient — top-level /you page.
 *
 * Replaces the old flat YouClient that stacked 8 sections in one scroll.
 * Here we present 3 category cards (Profile, Training, Integrations)
 * with a short live preview each, plus the sign-out affordance.
 *
 * Sub-routes handle depth:
 *   /you/profile         identity + body metrics
 *   /you/training        phase, template, availability, exercises
 *   /you/integrations    Strava + Google Calendar
 */

'use client';

import Link from 'next/link';
import { AccountSection, UserHeader } from '@/components/you/sections';
import type { HubSummary } from './loader';

export default function HubClient({
  user,
  summary,
}: {
  user: { email: string; id: string };
  summary: HubSummary;
}) {
  const phasePreview =
    summary.activePhaseName && summary.activePhaseCode
      ? `${summary.activePhaseName} · ${summary.activePhaseCode}`
      : 'No active phase';

  const availabilityPreview = summary.availabilityActive
    ? 'Window active now'
    : summary.availabilityUpcoming > 0
      ? `${summary.availabilityUpcoming} queued`
      : null;

  const trainingBullets = [phasePreview, availabilityPreview].filter(Boolean) as string[];

  const integrationsPreview =
    summary.integrationsConnected === 0
      ? 'Nothing connected yet'
      : `${summary.integrationsConnected} connected`;

  return (
    <main className="max-w-xl mx-auto px-4 pt-5 pb-28 space-y-5">
      <UserHeader email={user.email} />

      <HubCard
        href="/you/profile"
        eyebrow="Profile"
        title="Identity & body"
        bullets={[user.email, 'Log weight · track trend']}
      />

      <HubCard
        href="/you/training"
        eyebrow="Training"
        title="Phase, template, and more"
        bullets={trainingBullets.length > 0 ? trainingBullets : ['Your training setup']}
      />

      <HubCard
        href="/you/integrations"
        eyebrow="Settings · integrations"
        title="Connected apps"
        bullets={[integrationsPreview, 'Strava · Google Calendar']}
      />

      <AccountSection />
    </main>
  );
}

/**
 * Single category card on the hub. Accessible as a link so the whole
 * surface is tappable. Keeps a consistent layout for the three cards so
 * the page reads as a menu, not a mixed list.
 */
function HubCard({
  href,
  eyebrow,
  title,
  bullets,
}: {
  href: string;
  eyebrow: string;
  title: string;
  bullets: string[];
}) {
  return (
    <Link
      href={href}
      className="group block rounded-xl bg-panel border border-border p-4 transition hover:border-muted-2/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-tiny text-muted uppercase tracking-wider">{eyebrow}</div>
          <div className="text-lg font-semibold mt-1">{title}</div>
          {bullets.length > 0 && (
            <ul className="text-small text-muted-2 mt-1 space-y-0.5">
              {bullets.map((b, i) => (
                <li key={i} className="truncate">{b}</li>
              ))}
            </ul>
          )}
        </div>
        <span
          className="shrink-0 text-muted-2 transition group-hover:text-muted text-lg leading-none"
          aria-hidden
        >
          ›
        </span>
      </div>
    </Link>
  );
}
