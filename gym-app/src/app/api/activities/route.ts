import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { buildAIContext } from '@/lib/ai/context';
import { callClaudeJSON, REVIEW_SYSTEM } from '@/lib/ai/anthropic';
import { reconcile } from '@/lib/reconcile';
import { enqueuePlanSync } from '@/lib/plans/write';
import { z } from 'zod';

export const maxDuration = 60;

const Body = z.object({
  plan_id: z.string().uuid().optional().nullable(),
  date: z.string(),
  type: z.enum(['gym','run','bike','swim','yoga','climb','sauna_cold','mobility','rest','other']),
  status: z.enum(['done','skipped','moved','unplanned']).default('done'),
  sentiment: z.number().int().min(1).max(5).nullable().optional(),
  notes: z.string().optional(),
  data: z.any().default({}),
  auto_review: z.boolean().optional(),
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

  if (b.plan_id) {
    const { error: planUpdErr } = await sb
      .from('plans')
      .update({
        status: b.status === 'skipped' ? 'skipped' : 'done',
      })
      .eq('id', b.plan_id)
      .eq('user_id', user.id);

    // Enqueue a calendar-sync upsert for the plan whose status just
    // changed. The worker (PR-T) will re-project the plan to its
    // Google Calendar event; if nothing visible changed (today we only
    // flipped status), the etag compare will no-op. Keeping the hook
    // here means later UX decisions — strikethrough done events, mark
    // skipped with a color — can ship without another write-path pass.
    // Swallow errors silently: the primary action (activity inserted)
    // has already succeeded.
    if (!planUpdErr) {
      await enqueuePlanSync(sb, user.id, { upsertIds: [b.plan_id] });
    }
  }

  // Auto-review on save-as-done — runs inline (serverless, same context) and
  // posts a pending proposal if Claude recommends changes. The client hears
  // about it via the pending-proposals poller.
  const wantsReview = b.status === 'done' && (b.auto_review ?? true);
  if (wantsReview) {
    try {
      const ctx = await buildAIContext({ userId: user.id });
      const prompt = `Just-completed activity to review:
${JSON.stringify(act, null, 2)}

Full context:
${JSON.stringify(ctx, null, 2)}

Return JSON only.`;
      const result: any = await callClaudeJSON({ system: REVIEW_SYSTEM, user: prompt });
      const diff = result.diff ?? { rationale: 'no change', updates: [], creates: [], deletes: [] };
      const noChanges = !diff.updates?.length && !diff.creates?.length && !diff.deletes?.length;

      await sb.from('ai_proposals').insert({
        user_id: user.id,
        triggered_by: 'auto_review',
        source_activity_id: act.id,
        diff,
        rationale: [
          result.summary ? `Headline: ${result.summary}` : null,
          result.wins?.length ? `Wins: ${result.wins.join(' · ')}` : null,
          result.concerns?.length ? `Concerns: ${result.concerns.join(' · ')}` : null,
          diff.rationale ? `Why: ${diff.rationale}` : null,
        ].filter(Boolean).join('\n'),
        status: noChanges ? 'applied' : 'pending',
        applied_at: noChanges ? new Date().toISOString() : null,
      });
    } catch (e: any) {
      console.error('[auto_review]', e?.message || e);
    }
  }

  // Fire-and-forget reconcile — logging an activity can close the
  // drop-off gap (return_from_gap proposal should roll over to applied
  // once the user is back in rhythm). Don't await; any reconciler error
  // is caught internally.
  {
    const sbKick = supabaseServer();
    reconcile(sbKick, user.id, new Date(), 'activity_logged').catch((e) => {
      console.error('[api/activities] reconcile hook failed', e);
    });
  }

  // Recap screen for done sessions; rest-day sessions skip it and go back to Today
  // (with a flag Today can use later to show a small tip).
  const redirectTo = (() => {
    if (b.status !== 'done') return `/calendar/${b.date}`;
    if (!b.plan_id) return `/calendar/${b.date}`;
    if (b.type === 'rest') return '/today?rest=1';
    return `/log/${b.plan_id}/complete`;
  })();

  return NextResponse.json({ activity_id: act.id, redirect: redirectTo });
}
