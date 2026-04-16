/**
 * Template diff applier (P1.1 / PR-F).
 *
 * Takes a computed `TemplateDiff` (from `buildTemplateDiff`) plus the
 * caller's expected `weekly_templates.version` and atomically:
 *
 *   1. Upserts `weekly_templates` via optimistic concurrency (expectedVersion).
 *      If the version has moved — someone else saved in between — we bail
 *      BEFORE touching any plan rows. That's the whole reason template
 *      write happens first.
 *
 *   2. Applies the plan ops:
 *      - UPDATE each `updates[]` by plan_id, guarded on `status='planned'`
 *        and the diff's before-state `(type, day_code)` matching what's on
 *        disk. Anything drifted is skipped with a warn — the user will see
 *        a fresher diff on next preview.
 *      - INSERT each `creates[]`.
 *      - DELETE each `deletes[]`, guarded on `status='planned'`.
 *
 *   3. Writes an audit `ai_proposals` row:
 *        kind='template_change', triggered_by='user_template_edit',
 *        status='applied', diff={before, after, updates, creates, deletes,
 *        summary}, rationale=diff.rationale.
 *      This row is the user-visible "History" entry for the edit and the
 *      handle for a future undo (P1.2 — counter-apply using stored {before,
 *      after}). We write it LAST so it only exists if plan writes succeeded
 *      enough to be worth logging.
 *
 *   4. Fires reconcile(cause='template_updated') fire-and-forget so the
 *      next page load sees a freshly-settled window.
 *
 * Partial-failure policy: Supabase doesn't give us real multi-table
 * transactions from a Node client, so writes are serial and best-effort.
 * The ordering above minimizes the blast radius:
 *   - Template CAS fails → zero writes, safe retry.
 *   - Some plan writes fail after CAS → template is authoritative; next
 *     reconcile/roll-forward pass will heal missing plan rows (creates are
 *     idempotent via the occupied-set guard), and existing un-updated rows
 *     will show up in the next diff preview. User sees a toast explaining
 *     partial success; they can re-apply.
 *
 * Input contract: callers MUST have computed `diff` against the SAME
 * `before` pattern they're now invalidating — i.e. they read pattern at
 * version N, called buildTemplateDiff(before=N.pattern, after=editedPattern),
 * and now call applyTemplateDiff with expectedVersion=N. The CAS in step 1
 * enforces this.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { reconcile } from '@/lib/reconcile';
import { enqueuePlanSync } from '@/lib/plans/write';
import { upsertWeeklyTemplate } from './loader';
import type { TemplateDiff } from './diff.pure';

export type ApplyTemplateDiffArgs = {
  sb: SupabaseClient;
  userId: string;
  phaseId: string;
  diff: TemplateDiff;
  /** `version` of the weekly_templates row the user started editing from.
   *  Null when the row doesn't exist yet (first save for this phase). */
  expectedVersion: number | null;
  /** Optional override for the reconcile timestamp (tests). */
  now?: Date;
};

export type ApplyTemplateDiffResult =
  | {
      ok: true;
      proposal_id: string;
      template_version: number;
      applied: {
        updates: number;
        creates: number;
        deletes: number;
      };
      skipped: {
        updates_drifted: number;
        deletes_not_planned: number;
      };
    }
  | {
      ok: false;
      reason:
        | 'version_conflict'
        | 'template_write_failed'
        | 'audit_insert_failed';
      detail?: string;
    };

export async function applyTemplateDiff(
  args: ApplyTemplateDiffArgs
): Promise<ApplyTemplateDiffResult> {
  const { sb, userId, phaseId, diff, expectedVersion } = args;

  // -------- 1. Template CAS (gate) --------------------------------------
  // Write the new pattern FIRST, under expected-version CAS. Anything
  // after this point assumes we hold the "latest" edit for this phase.
  const upsert = await upsertWeeklyTemplate(sb, {
    userId,
    phaseId,
    pattern: diff.after,
    expectedVersion,
  });

  if (!upsert.ok) {
    if (upsert.reason === 'version_conflict') {
      return { ok: false, reason: 'version_conflict' };
    }
    return {
      ok: false,
      reason: 'template_write_failed',
      detail: upsert.reason,
    };
  }

  const templateVersion = upsert.row.version;

  // -------- 2. Plan ops -------------------------------------------------
  let appliedUpdates = 0;
  let appliedCreates = 0;
  let appliedDeletes = 0;
  let skippedUpdates = 0;
  let skippedDeletes = 0;

  // Plan ids we'll queue for Google Calendar sync once all writes
  // commit. Only populated on successful writes — failed/drift-skipped
  // ops leave Google unchanged (the worker will heal via nightly scan).
  const upsertedPlanIds: string[] = [];

  // 2a. Updates — guard on both status='planned' AND the plan still
  // matches `before` (type, day_code). If the row drifted under us (user
  // logged it, or another edit landed), skip silently and let the next
  // preview surface the drift.
  for (const u of diff.updates) {
    const { data: existing, error: loadErr } = await sb
      .from('plans')
      .select('id, type, day_code, status, version')
      .eq('user_id', userId)
      .eq('id', u.plan_id)
      .maybeSingle();

    if (loadErr || !existing) {
      skippedUpdates += 1;
      continue;
    }
    if (existing.status !== 'planned') {
      skippedUpdates += 1;
      continue;
    }
    // Drift check: the row must still match our "before" snapshot. A
    // mismatch means something else touched it between preview and apply.
    if (
      existing.type !== u.before.type ||
      (existing.day_code ?? null) !== (u.before.day_code ?? null)
    ) {
      skippedUpdates += 1;
      continue;
    }

    const { error: updErr } = await sb
      .from('plans')
      .update({
        type: u.patch.type,
        day_code: u.patch.day_code,
        prescription: u.patch.prescription,
        calendar_event_id: u.patch.calendar_event_id,
        source: u.patch.source,
        ai_rationale: u.patch.ai_rationale,
        phase_id: diff.phase_id,
        version: ((existing.version as number | null) ?? 1) + 1,
      })
      .eq('id', u.plan_id)
      .eq('user_id', userId)
      .eq('status', 'planned'); // belt-and-suspenders

    if (updErr) {
      console.error('[templates/apply] plan update failed', updErr, { plan_id: u.plan_id });
      skippedUpdates += 1;
      continue;
    }
    appliedUpdates += 1;
    upsertedPlanIds.push(u.plan_id);
  }

  // 2b. Creates — batch insert. No unique(user_id, date) index on plans
  // (multiple activity types per day is a supported future), so we rely
  // on the diff engine having already filtered dates where a plan exists.
  // `.select('id')` captures inserted ids for the calendar-sync enqueue.
  if (diff.creates.length > 0) {
    const rows = diff.creates.map((c) => ({
      user_id: userId,
      phase_id: c.phase_id,
      date: c.date,
      type: c.type,
      day_code: c.day_code,
      prescription: c.prescription,
      calendar_event_id: c.calendar_event_id,
      source: c.source,
      status: c.status,
      ai_rationale: c.ai_rationale,
    }));
    const { data: insertedRows, error: insErr } = await sb
      .from('plans')
      .insert(rows)
      .select('id');
    if (insErr) {
      console.error('[templates/apply] plan creates failed', insErr);
    } else {
      appliedCreates = insertedRows?.length ?? 0;
      for (const r of (insertedRows ?? []) as Array<{ id: string }>) {
        upsertedPlanIds.push(r.id);
      }
    }
  }

  // 2c. Pre-snapshot delete links for calendar sync — call BEFORE the
  // delete loop runs. After plan deletion, `calendar_links.plan_id` is
  // SET NULL (migration 0008) and a lookup by plan_id returns nothing,
  // so the snapshot has to happen here while the link is still intact.
  // enqueuePlanSync is a no-op for plans that were never synced.
  if (diff.deletes.length > 0) {
    await enqueuePlanSync(sb, userId, { deleteIds: diff.deletes.map((d) => d.plan_id) });
  }

  // 2d. Deletes — only planned rows. If status changed under us (e.g.
  // user logged the activity), we preserve the history and count it as
  // skipped.
  for (const d of diff.deletes) {
    const { error: delErr, count } = await sb
      .from('plans')
      .delete({ count: 'exact' })
      .eq('id', d.plan_id)
      .eq('user_id', userId)
      .eq('status', 'planned');
    if (delErr) {
      console.error('[templates/apply] plan delete failed', delErr, { plan_id: d.plan_id });
      skippedDeletes += 1;
      continue;
    }
    if ((count ?? 0) === 0) {
      skippedDeletes += 1;
      continue;
    }
    appliedDeletes += 1;
  }

  // 2e. Enqueue upsert sync jobs for everything we successfully wrote.
  // AFTER the writes commit so the worker sees the final plan state.
  if (upsertedPlanIds.length > 0) {
    await enqueuePlanSync(sb, userId, { upsertIds: upsertedPlanIds });
  }

  // -------- 3. Audit proposal row ---------------------------------------
  // Stored AFTER plan writes so partial failures don't produce a misleading
  // "applied" history entry. The full {before, after, updates, creates,
  // deletes, summary} shape is what the review UI + future undo path both
  // need.
  //
  // Note: we record what we INTENDED to apply (the diff). The `applied`
  // counters on the API response tell the UI how much actually landed;
  // if drift skipped anything, the audit row's summary is the
  // authoritative "user's intent" record.
  const nowIso = (args.now ?? new Date()).toISOString();
  const { data: proposal, error: propErr } = await sb
    .from('ai_proposals')
    .insert({
      user_id: userId,
      kind: 'template_change',
      triggered_by: 'user_template_edit',
      status: 'applied',
      applied_at: nowIso,
      rationale: diff.rationale,
      diff: {
        phase_id: diff.phase_id,
        before: diff.before,
        after: diff.after,
        window: diff.window,
        updates: diff.updates,
        creates: diff.creates,
        deletes: diff.deletes,
        summary: diff.summary,
        applied_counts: {
          updates: appliedUpdates,
          creates: appliedCreates,
          deletes: appliedDeletes,
        },
        skipped_counts: {
          updates_drifted: skippedUpdates,
          deletes_not_planned: skippedDeletes,
        },
        template_version: templateVersion,
      },
    })
    .select('id')
    .single();

  if (propErr || !proposal) {
    console.error('[templates/apply] audit insert failed', propErr);
    // Plan writes landed but we failed to write history. Don't roll
    // back — the user's intent has been persisted and the reconciler
    // will heal. Surface the failure so the caller can show a softer
    // toast ("Changes applied, but history entry failed to save").
    return {
      ok: false,
      reason: 'audit_insert_failed',
      detail: propErr?.message ?? 'insert returned no row',
    };
  }

  // -------- 4. Fire-and-forget reconcile --------------------------------
  // Same pattern as the existing proposal apply path. Errors swallowed
  // inside reconcile's own try/catch; we just log here defensively.
  reconcile(sb, userId, args.now ?? new Date(), 'template_updated').catch((e) => {
    console.error('[templates/apply] reconcile hook failed', e);
  });

  return {
    ok: true,
    proposal_id: proposal.id as string,
    template_version: templateVersion,
    applied: {
      updates: appliedUpdates,
      creates: appliedCreates,
      deletes: appliedDeletes,
    },
    skipped: {
      updates_drifted: skippedUpdates,
      deletes_not_planned: skippedDeletes,
    },
  };
}
