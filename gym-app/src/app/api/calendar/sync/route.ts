import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { classifyEvent, getCalendarClient } from '@/lib/google/calendar';
import { addDays, format, subDays } from 'date-fns';

export const maxDuration = 60;

const GYM_KEYWORDS = /(💪|🔵|push.*day|pull.*day|lower.*day|upper.*full|easy.*run|quality.*run|gym|workout|training)/i;

export async function POST(req: Request) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const calendarId = body.calendar_id || 'primary';
  const days = Math.min(Math.max(Number(body.days) || 90, 7), 365);

  let cal;
  try { cal = await getCalendarClient(user.id); }
  catch (e: any) { return NextResponse.json({ error: e.message }, { status: 400 }); }

  const timeMin = subDays(new Date(), 30).toISOString();
  const timeMax = addDays(new Date(), days).toISOString();

  let imported = 0, skipped = 0;
  let pageToken: string | undefined = undefined;

  do {
    const res: any = await cal.events.list({
      calendarId, timeMin, timeMax,
      singleEvents: false, maxResults: 250, pageToken,
    });
    for (const ev of res.data.items ?? []) {
      const summary = ev.summary || '';
      if (!GYM_KEYWORDS.test(summary)) { skipped++; continue; }
      const { type, day_code } = classifyEvent(summary);
      const id = ev.id || ev.iCalUID;
      if (!id) { skipped++; continue; }

      await sb.from('calendar_events').upsert({
        user_id: user.id,
        google_calendar_id: calendarId,
        google_event_id: id,
        summary,
        description_raw: ev.description ?? null,
        day_type: type,
        day_code,
        recurrence: ev.recurrence ? { rules: ev.recurrence } : null,
        first_occurrence: ev.start?.dateTime ?? ev.start?.date ?? null,
        last_seen_at: new Date().toISOString(),
        // prescription: parsing description into structured blocks is a future PR;
        // for now keep raw text accessible.
        prescription: { notes_top: ev.description ?? '', blocks: [] },
      }, { onConflict: 'user_id,google_event_id' });
      imported++;
    }
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  return NextResponse.json({ ok: true, imported, skipped });
}
