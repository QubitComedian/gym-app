import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { getCalendarClient } from '@/lib/google/calendar';
import { addDays, format } from 'date-fns';
import crypto from 'crypto';
import { buildEvent, type Phase } from '@/lib/google/eventFormat';

export const maxDuration = 60;

/**
 * Checksum covers inputs that should invalidate a cached calendar hold.
 * We bump the prefix to "v2" so the first push after this deploy rewrites
 * all existing events with the new human-friendly titles and descriptions.
 */
function checksumPlan(p: any) {
  return crypto
    .createHash('sha1')
    .update('v2|' + JSON.stringify({ d: p.date, t: p.type, c: p.day_code, p: p.prescription }))
    .digest('hex');
}

export async function POST(req: Request) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const calendarId = body.calendar_id || 'primary';
  const horizonDays = Math.min(Math.max(Number(body.horizon_days) || 14, 1), 60);
  const startTime = body.start_hour ? Number(body.start_hour) : 7;
  const timeZone: string = body.time_zone || 'UTC';
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;

  let cal;
  try { cal = await getCalendarClient(user.id); }
  catch (e: any) { return NextResponse.json({ error: e.message }, { status: 400 }); }

  const today = format(new Date(), 'yyyy-MM-dd');
  const horizon = format(addDays(new Date(), horizonDays), 'yyyy-MM-dd');

  // Pull plans AND their phase for context-aware summaries/descriptions.
  const { data: plans } = await sb
    .from('plans')
    .select('id,date,type,day_code,prescription,phase_id')
    .eq('user_id', user.id)
    .eq('status', 'planned')
    .neq('type', 'rest')
    .gte('date', today)
    .lte('date', horizon)
    .order('date');
  if (!plans?.length) return NextResponse.json({ ok: true, written: 0, updated: 0, skipped: 0 });

  // Resolve phases in one shot so we can show "Phase: …" in the description footer.
  const phaseIds = Array.from(new Set((plans ?? []).map((p) => p.phase_id).filter(Boolean)));
  const { data: phasesRows } = phaseIds.length
    ? await sb.from('phases').select('id,code,name').in('id', phaseIds as string[])
    : { data: [] as any[] };
  const phaseById = new Map((phasesRows ?? []).map((p) => [p.id, { code: p.code, name: p.name }]));

  const { data: links } = await sb
    .from('calendar_links')
    .select('*')
    .eq('user_id', user.id)
    .in('plan_id', plans.map((p) => p.id));
  const linkByPlan = new Map((links ?? []).map((l) => [l.plan_id, l]));

  let written = 0, updated = 0, skipped = 0;
  const errors: Array<{ plan_id: string; error: string }> = [];

  for (const p of plans) {
    const link = linkByPlan.get(p.id);
    const checksum = checksumPlan(p);
    if (link && link.checksum === checksum) { skipped++; continue; }

    const startISO = `${p.date}T${String(startTime).padStart(2, '0')}:00:00`;
    const endHour = String(startTime + 1).padStart(2, '0');
    const endISO = `${p.date}T${endHour}:00:00`;

    const phase: Phase = p.phase_id ? (phaseById.get(p.phase_id) ?? null) : null;
    const { summary, description } = buildEvent(p as any, phase, { appUrl });

    try {
      if (link) {
        await cal.events.update({
          calendarId: link.google_calendar_id,
          eventId: link.google_event_id,
          requestBody: {
            summary,
            description,
            start: { dateTime: startISO, timeZone },
            end:   { dateTime: endISO,   timeZone },
          },
        });
        await sb.from('calendar_links')
          .update({ checksum, last_synced_at: new Date().toISOString() })
          .eq('id', link.id);
        updated++;
      } else {
        const res = await cal.events.insert({
          calendarId,
          requestBody: {
            summary,
            description,
            start: { dateTime: startISO, timeZone },
            end:   { dateTime: endISO,   timeZone },
          },
        });
        await sb.from('calendar_links').insert({
          user_id: user.id,
          plan_id: p.id,
          google_calendar_id: calendarId,
          google_event_id: res.data.id!,
          checksum,
          last_synced_at: new Date().toISOString(),
        });
        written++;
      }
    } catch (e: any) {
      errors.push({ plan_id: p.id, error: e?.message || 'unknown' });
    }
  }

  // `upserted` is a convenience for the UI toast — the existing /you page
  // reads `j.upserted` to show "X events pushed". We keep `written/updated/skipped`
  // separately for debugging.
  const upserted = written + updated;
  return NextResponse.json({ ok: true, written, updated, skipped, upserted, errors });
}
