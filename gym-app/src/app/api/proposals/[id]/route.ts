/**
 * Proposal apply / reject handler.
 *
 * Accepts two shapes of proposal, keyed on `ai_proposals.kind`:
 *
 *   - kind='adjust'          (original flow, the default)
 *       POST body: { action: 'apply' | 'reject' | 'dismiss' }
 *       'apply' uses the top-level { updates, creates, deletes } on diff.
 *
 *   - kind='return_from_gap' (P1.0 / PR-D)
 *       POST body: { action: 'accept_option', option_id: string }
 *                 | { action: 'reject' | 'dismiss' }
 *       'accept_option' pulls `diff.options[i].diff` (one of shift_week,
 *       reentry_soft, reentry_full, jump_back_in, reassess) and applies
 *       its sub-diff. Zero-op diffs (jump_back_in) still mark the proposal
 *       applied so the banner dismisses. Options with action='reassess'
 *       short-circuit the diff apply and return a redirect to /check-in.
 *
 * Side effects after a successful apply:
 *   - When a return_from_gap is accepted, any still-pending 'adjust'
 *     proposal created before the gap's last_done_date is auto-rejected
 *     as stale — those suggestions were about sessions the user has now
 *     stopped caring about. Comment on the superseded rationale for ops.
 *   - Reconcile is kicked fire-and-forget so age-out / roll-forward
 *     settle into the post-apply state before the next page load.
 */

import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { reconcile } from '@/lib/reconcile';

type Diff = {
  updates?: Array<{
    plan_id?: string;
    patch?: { prescription?: unknown; date?: string; type?: string; day_code?: string | null };
  }>;
  creates?: Array<{
    date: string;
    type: string;
    day_code?: string | null;
    prescription?: unknown;
  }>;
  deletes?: string[];
  rationale?: string;
  // return_from_gap only:
  kind?: string;
  options?: Array<{
    id: string;
    action?: 'reassess';
    diff: {
      updates?: Diff['updates'];
      creates?: Diff['creates'];
      deletes?: Diff['deletes'];
      rationale?: string;
    };
  }>;
  last_done_date?: string;
};

type Body = {
  action?: 'apply' | 'accept_option' | 'reject' | 'dismiss';
  option_id?: string;
};

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 });

  const body: Body = await req.json().catch(() => ({}));
  const action = body.action;

  const { data: prop } = await sb
    .from('ai_proposals')
    .select('*')
    .eq('user_id', user.id)
    .eq('id', params.id)
    .maybeSingle();
  if (!prop) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (prop.status !== 'pending') {
    return NextResponse.json({ error: 'already ' + prop.status }, { status: 400 });
  }

  // -------- rejection / dismissal ---------------------------------------
  if (action === 'reject' || action === 'dismiss') {
    await sb.from('ai_proposals').update({ status: 'rejected' }).eq('id', prop.id);
    return NextResponse.json({ ok: true });
  }

  const diff: Diff = (prop.diff as Diff) || {};
  const kind: string = prop.kind ?? 'adjust';

  // -------- return_from_gap: option-based apply -------------------------
  if (action === 'accept_option') {
    if (kind !== 'return_from_gap') {
      return NextResponse.json({ error: 'accept_option only valid for return_from_gap' }, { status: 400 });
    }
    if (!body.option_id) {
      return NextResponse.json({ error: 'option_id required' }, { status: 400 });
    }
    const option = (diff.options ?? []).find((o) => o.id === body.option_id);
    if (!option) {
      return NextResponse.json({ error: `unknown option_id ${body.option_id}` }, { status: 400 });
    }

    // 'reassess' is a UI redirect — no plan diff to apply. Still mark the
    // proposal applied so the hero dismisses; the /check-in flow (future
    // PR) owns the actual replan.
    if (option.action === 'reassess') {
      await sb
        .from('ai_proposals')
        .update({
          status: 'applied',
          applied_at: new Date().toISOString(),
          rationale: appendNote(prop.rationale, `User chose: reassess`),
        })
        .eq('id', prop.id);
      fireAndForgetReconcile(user.id);
      return NextResponse.json({ ok: true, redirect: '/check-in' });
    }

    await applyDiff(sb, user.id, option.diff, prop.rationale);
    await sb
      .from('ai_proposals')
      .update({
        status: 'applied',
        applied_at: new Date().toISOString(),
        rationale: appendNote(prop.rationale, `User chose: ${option.id}`),
      })
      .eq('id', prop.id);

    await supersedeStaleAdjusts(sb, user.id, diff.last_done_date ?? null);
    fireAndForgetReconcile(user.id);
    return NextResponse.json({ ok: true });
  }

  // -------- legacy 'apply' (adjust proposals) ---------------------------
  if (action !== 'apply') {
    return NextResponse.json({ error: 'bad action' }, { status: 400 });
  }
  if (kind === 'return_from_gap') {
    return NextResponse.json(
      { error: 'return_from_gap requires action=accept_option + option_id' },
      { status: 400 }
    );
  }

  await applyDiff(sb, user.id, diff, prop.rationale);
  await sb
    .from('ai_proposals')
    .update({ status: 'applied', applied_at: new Date().toISOString() })
    .eq('id', prop.id);

  fireAndForgetReconcile(user.id);
  return NextResponse.json({ ok: true });
}

// -------- helpers ------------------------------------------------------

type PlanDiff = {
  updates?: Diff['updates'];
  creates?: Diff['creates'];
  deletes?: Diff['deletes'];
  rationale?: string;
};

async function applyDiff(
  sb: ReturnType<typeof supabaseServer>,
  userId: string,
  diff: PlanDiff,
  fallbackRationale: string | null
) {
  const d = diff;
  const rationale = d.rationale ?? fallbackRationale ?? null;

  // Apply updates: load existing plan, snapshot version, write new prescription.
  for (const u of d.updates ?? []) {
    if (!u.plan_id) continue;
    const { data: existing } = await sb
      .from('plans')
      .select('*')
      .eq('id', u.plan_id)
      .eq('user_id', userId)
      .maybeSingle();
    if (!existing || existing.status !== 'planned') continue;
    const patch: Record<string, unknown> = {};
    if (u.patch?.prescription !== undefined) patch.prescription = u.patch.prescription;
    if (u.patch?.date) patch.date = u.patch.date;
    if (u.patch?.type) patch.type = u.patch.type;
    if (u.patch?.day_code != null) patch.day_code = u.patch.day_code;
    patch.version = ((existing.version as number | null) ?? 1) + 1;
    patch.source = 'ai_proposed';
    patch.ai_rationale = rationale;
    await sb.from('plans').update(patch).eq('id', u.plan_id);
  }

  // Apply creates.
  if (d.creates?.length) {
    await sb.from('plans').insert(
      d.creates.map((c) => ({
        user_id: userId,
        date: c.date,
        type: c.type,
        day_code: c.day_code ?? null,
        prescription: c.prescription ?? {},
        status: 'planned',
        source: 'ai_proposed',
        ai_rationale: rationale,
      }))
    );
  }

  // Apply deletes (soft — only planned rows).
  for (const id of d.deletes ?? []) {
    await sb.from('plans').delete().eq('id', id).eq('user_id', userId).eq('status', 'planned');
  }
}

async function supersedeStaleAdjusts(
  sb: ReturnType<typeof supabaseServer>,
  userId: string,
  lastDoneIso: string | null
) {
  if (!lastDoneIso) return;
  // Adjust proposals created before the last-done date describe a world
  // the user has since stopped inhabiting. Reject them rather than leave
  // them lingering in the pending list.
  const { data: stale } = await sb
    .from('ai_proposals')
    .select('id, rationale')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .eq('kind', 'adjust')
    .lt('created_at', `${lastDoneIso}T23:59:59Z`);

  for (const s of (stale ?? []) as Array<{ id: string; rationale: string | null }>) {
    await sb
      .from('ai_proposals')
      .update({
        status: 'rejected',
        rationale: appendNote(s.rationale, 'Superseded by return_from_gap'),
      })
      .eq('id', s.id);
  }
}

function appendNote(existing: string | null, note: string): string {
  const base = existing?.trim() ?? '';
  return base ? `${base}\n${note}` : note;
}

function fireAndForgetReconcile(userId: string) {
  // Don't await — response time matters more than the reconcile result.
  // Any errors are swallowed by the reconciler's internal try/catch.
  const sb = supabaseServer();
  reconcile(sb, userId, new Date(), 'proposal_applied').catch((e) => {
    console.error('[api/proposals] reconcile hook failed', e);
  });
}
