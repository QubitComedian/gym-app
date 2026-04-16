/**
 * GET + PUT /api/training-preferences (P1.4 / PR-V).
 *
 * CRUD for the training_preferences table: session start time,
 * duration, per-weekday overrides, and color scheme. The worker and
 * projector use these to determine when and how long each Google
 * Calendar event should be.
 *
 * GET — returns the current row (or defaults if none exists).
 * PUT — upserts the row with Zod-validated input.
 */

import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { z } from 'zod';
import { DEFAULT_PREFERENCES } from '@/lib/google/project';

// =====================================================================
// Validation
// =====================================================================

const DayOverrideSchema = z.object({
  start: z.string().regex(/^\d{1,2}:\d{2}(:\d{2})?$/).optional(),
  minutes: z.number().int().min(15).max(480).optional(),
});

const PreferencesSchema = z.object({
  session_start_time: z
    .string()
    .regex(/^\d{1,2}:\d{2}(:\d{2})?$/, 'Must be HH:MM or HH:MM:SS')
    .optional(),
  session_duration_minutes: z
    .number()
    .int()
    .min(15)
    .max(480)
    .optional(),
  day_overrides: z
    .record(
      z.string().regex(/^[1-7]$/, 'Keys must be ISO weekday 1-7'),
      DayOverrideSchema,
    )
    .optional(),
  color_scheme: z.string().nullable().optional(),
});

// =====================================================================
// GET — read current preferences (or defaults)
// =====================================================================

export async function GET() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { data, error } = await sb
    .from('training_preferences')
    .select('session_start_time, session_duration_minutes, day_overrides, color_scheme, updated_at')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) {
    console.error('[training-preferences] read failed', error);
    return NextResponse.json({ error: 'Failed to load preferences' }, { status: 500 });
  }

  // Return defaults if no row exists yet.
  if (!data) {
    return NextResponse.json({
      session_start_time: DEFAULT_PREFERENCES.session_start_time,
      session_duration_minutes: DEFAULT_PREFERENCES.session_duration_minutes,
      day_overrides: DEFAULT_PREFERENCES.day_overrides,
      color_scheme: DEFAULT_PREFERENCES.color_scheme,
      updated_at: null,
    });
  }

  return NextResponse.json(data);
}

// =====================================================================
// PUT — upsert preferences
// =====================================================================

export async function PUT(req: Request) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = PreferencesSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Build the upsert payload — only include fields that were sent.
  const update: Record<string, unknown> = {};
  const d = parsed.data;
  if (d.session_start_time !== undefined) update.session_start_time = d.session_start_time;
  if (d.session_duration_minutes !== undefined) update.session_duration_minutes = d.session_duration_minutes;
  if (d.day_overrides !== undefined) update.day_overrides = d.day_overrides;
  if (d.color_scheme !== undefined) update.color_scheme = d.color_scheme;

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
  }

  const { error } = await sb
    .from('training_preferences')
    .upsert({
      user_id: user.id,
      ...update,
    });

  if (error) {
    console.error('[training-preferences] upsert failed', error);
    return NextResponse.json({ error: 'Failed to save preferences' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
