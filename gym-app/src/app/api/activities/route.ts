import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { z } from 'zod';

const Body = z.object({
  plan_id: z.string().uuid().optional().nullable(),
  date: z.string(),
  type: z.enum(['gym','run','bike','swim','yoga','climb','sauna_cold','mobility','rest','other']),
  status: z.enum(['done','skipped','moved','unplanned']).default('done'),
  sentiment: z.number().int().min(1).max(5).nullable().optional(),
  notes: z.string().optional(),
  data: z.any().default({}),
});

export async function POST(req: Request) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 });

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  const b = parsed.data;

  const { data: act, error } = await sb.from('activities').insert({
    user_id: user.id,
    plan_id: b.plan_id ?? null,
    date: b.date,
    type: b.type,
    status: b.status,
    sentiment: b.sentiment ?? null,
    notes: b.notes ?? null,
    source: 'app',
    data: b.data ?? {},
    completed_at: new Date().toISOString(),
  }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Mark plan consumed
  if (b.plan_id) {
    await sb.from('plans').update({ status: b.status === 'done' ? 'done' : b.status === 'skipped' ? 'skipped' : 'done' })
      .eq('id', b.plan_id).eq('user_id', user.id);
  }

  return NextResponse.json({ activity_id: act.id });
}
