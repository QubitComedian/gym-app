import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { z } from 'zod';

const Body = z.object({
  exercise_id: z.string().nullable().optional(),
  label: z.string(),
  status: z.enum(['liked','neutral','banned']),
  reason: z.string().optional(),
});

export async function POST(req: Request) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 });
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const { error } = await sb.from('exercise_prefs').upsert({
    user_id: user.id,
    exercise_id: parsed.data.exercise_id ?? null,
    label: parsed.data.label,
    status: parsed.data.status,
    reason: parsed.data.reason ?? null,
  }, { onConflict: 'user_id,exercise_id,label' });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
