import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { getCalendarClient } from '@/lib/google/calendar';
import { addDays, format } from 'date-fns';
import crypto from 'crypto';

export const maxDuration = 60;

function descFromPrescription(p: any): string {
  if (!p) return '';
  const lines: string[] = [];
  if (p.notes_top) { lines.push(p.notes_top, ''); }
  for (const b of p.blocks ?? []) {
    if (b.kind === 'single') {
      const sch = b.set_scheme || {};
      const schStr = sch.type === 'standard' ? `${sch.sets ?? '?'} × ${sch.reps ?? '?'}` :
        sch.type === 'emom' ? `EMOM ${sch.minutes}′ · ${sch.reps_per_min}/min` :
        sch.type === 'time' ? `${sch.sets ?? 1} × ${sch.seconds_per_side ?? sch.seconds}s` : '';
      lines.push(`• ${b.exercise_id.replace(/_/g, ' ')} — ${schStr}${b.weight_hint ? ` @ ${b.weight_hint}` : ''}${b.rir_target != null ? ` (RIR ${b.rir_target})` : ''}`);
      if (b.notes) lines.push(`    ${b.notes}`);
    } else if (b.kind === 'superset') {
      lines.push(`Superset · ${b.rounds} rounds (rest ${b.rest_between_s ?? 60}s)`);
      for (const it of b.items) {
        const sch = it.set_scheme || {};
        const schStr = sch.type === 'standard' ? `${sch.reps ?? '?'}` : '';
        lines.push(`  ${it.letter}. ${it.exercise_id.replace(/_/g, ' ')} — ${schStr}${it.weight_hint ? ` @ ${it.weight_hint}` : ''}`);
      }
      if (b.drop_set_on_last) lines.push(`  Drop set last round${b.drop_set_on_last.drop_pct ? ` -${b.drop_set_on_last.drop_pct}%` : ''}`);
    }
  }
  if (p.estimated_minutes) lines.push('', `≈ ${p.estimated_minutes} min`);
  return lines.join('\n');
}

function checksumPlan(p: any) {
  return crypto.createHash('sha1').update(JSON.stringify({ d: p.date, t: p.type, c: p.day_code, p: p.prescription })).digest('hex');
}

export async function POST(req: Request) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const calendarId = body.calendar_id || 'primary';
  const horizonDays = Math.min(Math.max(Number(body.horizon_days) || 14, 1), 60);
  const startTime = body.start_hour ? Number(body.start_hour) : 7; // 7am default

  let cal;
  try { cal = await getCalendarClient(user.id); }
  catch (e: any) { return NextResponse.json({ error: e.message }, { status: 400 }); }

  const today = format(new Date(), 'yyyy-MM-dd');
  const horizon = format(addDays(new Date(), horizonDays), 'yyyy-MM-dd');

  const { data: plans } = await sb.from('plans').select('*').eq('user_id', user.id).eq('status', 'planned').neq('type', 'rest').gte('date', today).lte('date', horizon).order('date');
  if (!plans?.length) return NextResponse.json({ ok: true, written: 0, updated: 0, skipped: 0 });

  const { data: links } = await sb.from('calendar_links').select('*').eq('user_id', user.id).in('plan_id', plans.map(p => p.id));
  const linkByPlan = new Map((links ?? []).map(l => [l.plan_id, l]));

  let written = 0, updated = 0, skipped = 0;
  for (const p of plans) {
    const link = linkByPlan.get(p.id);
    const checksum = checksumPlan(p);
    if (link && link.checksum === checksum) { skipped++; continue; }

    const startISO = `${p.date}T${String(startTime).padStart(2,'0')}:00:00`;
    const endHour = String(startTime + 1).padStart(2,'0');
    const endISO = `${p.date}T${endHour}:00:00`;
    const summary = `🏋️ ${p.type}${p.day_code ? ` · ${p.day_code}` : ''}`;
    const description = descFromPrescription(p.prescription);

    if (link) {
      await cal.events.update({
        calendarId: link.google_calendar_id, eventId: link.google_event_id,
        requestBody: { summary, description, start: { dateTime: startISO }, end: { dateTime: endISO } },
      });
      await sb.from('calendar_links').update({ checksum, last_synced_at: new Date().toISOString() }).eq('id', link.id);
      updated++;
    } else {
      const res = await cal.events.insert({
        calendarId,
        requestBody: { summary, description, start: { dateTime: startISO }, end: { dateTime: endISO } },
      });
      await sb.from('calendar_links').insert({
        user_id: user.id, plan_id: p.id, google_calendar_id: calendarId,
        google_event_id: res.data.id!, checksum, last_synced_at: new Date().toISOString(),
      });
      written++;
    }
  }

  return NextResponse.json({ ok: true, written, updated, skipped });
}
