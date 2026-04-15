/**
 * First-run user seed.
 *
 * Creates, idempotently (uses profile existence as the "already seeded" flag):
 *   - profile with trainer brief (north star)
 *   - active program with phase-aware weekly pattern
 *   - phases P1 (completed), P2 (active), P3 (upcoming) using REAL calendar dates
 *   - calendar_events rows populated from CALENDAR_EVENT_TEMPLATES (the hand-crafted
 *     prescriptions the user has in their Google Calendar)
 *   - exercise_prefs empty (the user populates as they discover preferences)
 *   - historical activities from the v0 log (Apr 2–14 2026)
 *   - forward-planned plans from today through the end of the active phase,
 *     each plan pointing back to its source calendar_event
 *
 * IMPORTANT: No P4+ plans are seeded — the AI drafts P4 when P3 is near complete.
 */
import { supabaseServer } from '@/lib/supabase/server';
import {
  TRAINER_BRIEF, PROGRAM_CONFIG, PHASES, EXERCISE_PREFS, SEED_HISTORY,
  CALENDAR_EVENT_TEMPLATES,
} from './seed-data';
import { addDays, format, isAfter, isBefore, parseISO } from 'date-fns';

const DOW_TO_CODE = ['SU','MO','TU','WE','TH','FR','SA'] as const;

export async function ensureUserSeeded(userId: string) {
  const sb = supabaseServer();

  const { data: existing } = await sb.from('profiles').select('user_id').eq('user_id', userId).maybeSingle();
  if (existing) return;

  // 1. Profile — trainer brief is the north star
  await sb.from('profiles').insert({
    user_id: userId,
    display_name: 'Thibault',
    brief: TRAINER_BRIEF,
  });

  // 2. Program
  const { data: program } = await sb.from('programs').insert({
    user_id: userId,
    name: 'Trainer program — P1/P2/P3',
    active: true,
    config: PROGRAM_CONFIG,
  }).select().single();

  // 3. Phases — real calendar dates, not computed offsets
  const phaseRows = PHASES.map(p => ({
    user_id: userId,
    program_id: program?.id ?? null,
    ordinal: p.ordinal,
    code: p.code,
    name: p.name,
    description: p.description,
    source: p.source,
    starts_on: p.starts_on,
    target_ends_on: p.target_ends_on,
    actual_ends_on: p.actual_ends_on,
    status: p.status,
    goals: {},
    nutrition_rules: p.nutrition_rules ?? {},
    weekly_targets: p.weekly_targets ?? {},
  }));
  const { data: insertedPhases } = await sb.from('phases').insert(phaseRows).select();
  const phaseByCode = new Map((insertedPhases ?? []).map(p => [p.code, p]));

  // 4. Calendar events — the hand-crafted prescriptions
  const calendarEventRows = CALENDAR_EVENT_TEMPLATES.map(t => ({
    user_id: userId,
    phase_id: phaseByCode.get(t.phase_code)?.id ?? null,
    google_calendar_id: 'thibault@nothingaddedlabs.com',
    google_event_id: t.google_event_id,
    summary: t.summary,
    day_type: t.day_type,
    day_code: t.day_code,
    prescription: {
      blocks: (t as any).blocks ?? [],
      run: (t as any).run,
      mobility: (t as any).mobility,
      notes_top: t.notes_top,
      estimated_minutes: t.estimated_minutes,
      creatine_g: t.creatine_g,
    },
    recurrence: { byday: t.day_of_week },
  }));
  const { data: insertedEvents } = await sb.from('calendar_events').insert(calendarEventRows).select();
  const eventByPhaseDay = new Map(
    (insertedEvents ?? []).map(e => [`${e.phase_id}:${e.day_code}`, e])
  );

  // 5. Exercise prefs — ships empty
  if (EXERCISE_PREFS.length > 0) {
    await sb.from('exercise_prefs').insert(EXERCISE_PREFS.map(p => ({ user_id: userId, ...p })));
  }

  // 6. Historical activities
  await sb.from('activities').insert(
    SEED_HISTORY.map(h => ({ user_id: userId, ...h, source: 'import' as const }))
  );

  // 7. Forward plans — from today through end of the currently-upcoming phase.
  //    For each day, look up (active phase on that date, day_code from weekly pattern)
  //    and bind prescription from the matching calendar_event.
  const today = new Date();
  const lastPhaseEnd = PHASES
    .map(p => p.target_ends_on)
    .filter(Boolean)
    .sort()
    .at(-1) as string;
  const horizonEnd = lastPhaseEnd ? parseISO(lastPhaseEnd) : addDays(today, 28);

  const plans: any[] = [];
  for (let d = new Date(today); !isAfter(d, horizonEnd); d = addDays(d, 1)) {
    const isoDate = format(d, 'yyyy-MM-dd');
    const dowCode = DOW_TO_CODE[d.getDay()];
    const slot = (PROGRAM_CONFIG.split.weekly_pattern as any)[dowCode];
    const activePhase = PHASES.find(p =>
      !isBefore(d, parseISO(p.starts_on!)) &&
      (!p.target_ends_on || !isAfter(d, parseISO(p.target_ends_on)))
    );
    const phaseRow = activePhase ? phaseByCode.get(activePhase.code) : null;

    if (slot.type === 'rest' || !activePhase || !phaseRow) {
      plans.push({
        user_id: userId,
        date: isoDate,
        type: slot.type === 'rest' ? 'rest' : slot.type,
        day_code: slot.day_code,
        status: 'planned' as const,
        source: 'calendar',
        prescription: {},
        phase_id: phaseRow?.id ?? null,
      });
      continue;
    }

    const evKey = `${phaseRow.id}:${slot.day_code}`;
    const ev = eventByPhaseDay.get(evKey);
    plans.push({
      user_id: userId,
      date: isoDate,
      type: slot.type,
      day_code: slot.day_code,
      phase_id: phaseRow.id,
      calendar_event_id: ev?.id ?? null,
      source: 'calendar',
      status: 'planned' as const,
      prescription: ev?.prescription ?? {},
      ai_rationale: ev
        ? `Seeded from calendar event "${ev.summary}" (phase ${activePhase.code}).`
        : `No calendar template for ${activePhase.code}/${slot.day_code} — placeholder.`,
    });
  }
  if (plans.length > 0) {
    await sb.from('plans').insert(plans);
  }
}
