/**
 * Weekly-template editor page (P1.1 / PR-G).
 *
 * Loads the editable context server-side so the client component opens
 * pre-populated — no flicker while we fetch initial state.
 *
 * Query: ?phase=<phase_id>  (optional; defaults to the active phase)
 *
 * Unauthenticated users redirect to /login. Unknown phase_id redirects to
 * /you (the editor lives beneath /you so "back" lands in a sensible place).
 */

import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import {
  getWeeklyTemplate,
  getLegacyPattern,
} from '@/lib/templates/loader';
import TemplateEditorClient from './TemplateEditorClient';
import type { WeeklyPattern } from '@/lib/reconcile/rollForward.pure';

export const dynamic = 'force-dynamic';

export default async function TemplatePage({
  searchParams,
}: {
  searchParams: { phase?: string };
}) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect('/login');

  // Resolve phase: explicit param wins, else fall back to active phase.
  const [{ data: requestedPhase }, { data: activePhase }, { data: allPhases }] = await Promise.all([
    searchParams.phase
      ? sb.from('phases').select('id, code, name, status, starts_on, target_ends_on')
          .eq('id', searchParams.phase).eq('user_id', user.id).maybeSingle()
      : Promise.resolve({ data: null }),
    sb.from('phases').select('id, code, name, status, starts_on, target_ends_on')
      .eq('user_id', user.id).eq('status', 'active').maybeSingle(),
    sb.from('phases').select('id, code, name, status, ordinal')
      .eq('user_id', user.id).order('ordinal'),
  ]);

  const phase = requestedPhase ?? activePhase;
  if (!phase) redirect('/you');

  // Initial template + fallback pattern + day_code library (for the dropdown).
  const [row, legacy, { data: events }] = await Promise.all([
    getWeeklyTemplate(sb, user.id, phase.id),
    getLegacyPattern(sb, user.id),
    sb.from('calendar_events')
      .select('id, day_code, summary, phase_id')
      .eq('user_id', user.id)
      .eq('phase_id', phase.id),
  ]);

  const pattern: WeeklyPattern =
    row && row.pattern && Object.keys(row.pattern).length > 0 ? row.pattern : legacy;
  const version = row?.version ?? null;

  // Dedupe day_codes (a phase could have two events with the same code if
  // someone duplicated; surface just one to the editor).
  const seen = new Set<string>();
  const dayCodes = ((events ?? []) as Array<{ day_code: string | null; summary: string | null }>).
    filter((e) => !!e.day_code)
    .filter((e) => {
      if (seen.has(e.day_code!)) return false;
      seen.add(e.day_code!);
      return true;
    })
    .map((e) => ({ day_code: e.day_code as string, summary: e.summary ?? null }));

  return (
    <TemplateEditorClient
      phase={phase}
      allPhases={(allPhases ?? []).filter((p) => p.status !== 'archived')}
      initialPattern={pattern}
      initialVersion={version}
      dayCodes={dayCodes}
    />
  );
}
