import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 });

  const { action } = await req.json();   // 'apply' | 'reject'
  const { data: prop } = await sb.from('ai_proposals').select('*').eq('user_id', user.id).eq('id', params.id).maybeSingle();
  if (!prop) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (prop.status !== 'pending') return NextResponse.json({ error: 'already ' + prop.status }, { status: 400 });

  if (action === 'reject') {
    await sb.from('ai_proposals').update({ status: 'rejected' }).eq('id', prop.id);
    return NextResponse.json({ ok: true });
  }

  if (action !== 'apply') return NextResponse.json({ error: 'bad action' }, { status: 400 });

  const diff = prop.diff || {};

  // Apply updates: load existing plan, snapshot version, write new prescription.
  for (const u of diff.updates ?? []) {
    if (!u.plan_id) continue;
    const { data: existing } = await sb.from('plans').select('*').eq('id', u.plan_id).eq('user_id', user.id).maybeSingle();
    if (!existing || existing.status !== 'planned') continue;
    const patch: any = {};
    if (u.patch?.prescription) patch.prescription = u.patch.prescription;
    if (u.patch?.date) patch.date = u.patch.date;
    if (u.patch?.type) patch.type = u.patch.type;
    if (u.patch?.day_code != null) patch.day_code = u.patch.day_code;
    patch.version = (existing.version ?? 1) + 1;
    patch.source = 'ai_proposed';
    patch.ai_rationale = diff.rationale ?? prop.rationale ?? null;
    await sb.from('plans').update(patch).eq('id', u.plan_id);
  }

  // Apply creates
  if (diff.creates?.length) {
    await sb.from('plans').insert(
      diff.creates.map((c: any) => ({
        user_id: user.id,
        date: c.date,
        type: c.type,
        day_code: c.day_code ?? null,
        prescription: c.prescription ?? {},
        status: 'planned',
        source: 'ai_proposed',
        ai_rationale: diff.rationale ?? prop.rationale ?? null,
      }))
    );
  }

  // Apply deletes (only planned ones)
  for (const id of diff.deletes ?? []) {
    await sb.from('plans').delete().eq('id', id).eq('user_id', user.id).eq('status', 'planned');
  }

  await sb.from('ai_proposals').update({ status: 'applied', applied_at: new Date().toISOString() }).eq('id', prop.id);
  return NextResponse.json({ ok: true });
}
