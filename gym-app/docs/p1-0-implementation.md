# P1.0 — Reconciler foundation

_Companion to `calendar-system.md`. Focus: what to build first, how to build it, what the UI looks like, what breaks in the corners._

## 1. Scope

P1.0 ships three capabilities and nothing else:

1. **Age-out** — past planned sessions with no activity stop sitting as "planned" and become `missed`. This is hygiene: the calendar view and weekly strip stop showing stale planned sessions in the past.
2. **Rolling window** — plans always exist from today to today+21 days. If the seeded plans run out, the reconciler walks the weekly pattern and fills the gap. Silent; no user-facing moment.
3. **Drop-off recovery** — a user who opens the app after 3+ days of inactivity sees a welcome-back moment on Today with one-tap options (re-entry week / jump back / reassess). This is the first moment the reconciler is _visible_.

Explicitly out of scope for P1.0: weekly-template editing UI (P1.1), phase-end transition proposals (P1.2), availability windows (P1.3), Google Calendar writes (P1.4), conflict detection (P1.5). Keeping the first PR tight is what makes the rest layer on cleanly.

## 2. Migrations

One migration file, `supabase/migrations/0003_reconciler_foundation.sql`. Four changes, in order:

```sql
-- 1. Add 'missed' to the activity_status enum used by plans.status.
alter type activity_status add value if not exists 'missed';

-- 2. Add last_reconciled_at + timezone to profiles so we have a freshness
--    gate and can compute user-local "today" correctly.
alter table profiles
  add column if not exists timezone text not null default 'UTC',
  add column if not exists last_reconciled_at timestamptz;

-- 3. Add a proposal kind so we can distinguish AI-adjust proposals from
--    reconciler-initiated ones. Backfills existing rows to 'adjust'.
alter table ai_proposals
  add column if not exists kind text not null default 'adjust';

create index if not exists idx_ai_proposals_user_status_kind
  on ai_proposals (user_id, status, kind);

-- 4. Minimal sync_jobs queue. Not fully wired in P1.0 (only reconcile
--    kind is used), but schema lands now so P1.4 doesn't need another
--    migration.
create table if not exists sync_jobs (
  id bigserial primary key,
  user_id uuid not null references auth.users on delete cascade,
  kind text not null,                -- 'reconcile' | (future: plan_upsert, plan_delete, conflict_scan)
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued', -- 'queued' | 'running' | 'done' | 'failed'
  attempt int not null default 0,
  run_after timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_sync_jobs_claim
  on sync_jobs (status, run_after) where status = 'queued';
create index if not exists idx_sync_jobs_user_kind
  on sync_jobs (user_id, kind, status);
```

Three deliberate choices worth flagging. We add `'missed'` to the existing `activity_status` enum rather than introducing a parallel `plan_status` column because the UI already switches on `plans.status`; one enum keeps rendering logic simple. We store `timezone` on `profiles` (default `'UTC'`) so "today" is user-local everywhere — without this, the nightly cron computes drop-off against UTC midnight and a user in Tokyo gets flagged as "2 days in" when they're actually 1 day. And we add `kind` to `ai_proposals` because the return-from-gap proposal needs a custom banner UI — it's not just another adjust diff.

Nothing in the existing `plans.source` column needs to change. Current values (`'calendar'`, `'ai_proposed'`) stay; the reconciler writes `'template'` for rolling-window inserts.

## 3. Reconciler module

Layout, under `src/lib/reconcile/`:

```
src/lib/reconcile/
├── index.ts          # reconcile(userId, now, cause) — entry point
├── ageOut.ts         # past-plans-without-activities → status='missed'
├── rollForward.ts    # ensure plans exist through today+21
├── dropOff.ts        # detect gap, create return_from_gap proposal
├── freshness.ts      # last_reconciled_at gate (30min debounce)
└── types.ts          # ReconcileCause, ReconcileResult
```

`reconcile(userId, now, cause)` is the single public entry. Signature:

```ts
type ReconcileCause =
  | 'today_page_load'
  | 'activity_logged'
  | 'proposal_applied'
  | 'nightly_cron';

type ReconcileResult = {
  aged_out: number;
  rolled_forward: number;
  drop_off_detected: boolean;
  duration_ms: number;
};

async function reconcile(
  userId: string,
  now: Date,
  cause: ReconcileCause
): Promise<ReconcileResult>;
```

It reads the user's timezone, computes `today` in that tz, and runs three steps in sequence with a single Supabase client:

```
1. ageOut   — UPDATE plans SET status='missed'
              WHERE user_id=? AND date < today_local
                AND status='planned'
                AND NOT EXISTS (
                  SELECT 1 FROM activities a
                  WHERE a.plan_id = plans.id
                )
2. rollForward — compute missing dates in [today, today+21],
                 walk the weekly pattern from PROGRAM_CONFIG
                 (will migrate to weekly_templates in P1.1),
                 INSERT new rows with source='template'
3. dropOff   — find max(activity.date), if gap ≥ 3 days and
                no active return_from_gap proposal exists,
                compute 3 option diffs, insert proposal
```

Then `UPDATE profiles SET last_reconciled_at = now()` and return. The whole thing takes one round-trip of reads plus up to three round-trips of writes — maybe 200-400ms in the worst case, zero to one writes in the common case.

**Freshness gate.** Before doing any work, `reconcile()` checks `profiles.last_reconciled_at`. If it's within the last 30 minutes and `cause === 'today_page_load'`, it returns immediately with a zeroed result. Writes (`activity_logged`, `proposal_applied`) always run — those are triggered _because_ state changed. Cron always runs.

**Concurrency.** If the user opens Today and the nightly cron fires simultaneously, both call `reconcile`. We protect against double-work with a Postgres advisory lock keyed on the user id:

```sql
select pg_try_advisory_xact_lock(hashtext('reconcile:' || $1));
```

If the lock isn't acquired, the caller returns immediately. No retries, no queueing — just "someone else is doing this, we're fine." Since the reconciler is idempotent, nothing is lost.

**Idempotency.** Each step is already safe to re-run: age-out uses a `WHERE status='planned'` clause so rerunning produces zero updates; roll-forward uses `INSERT ... ON CONFLICT (user_id, date) DO NOTHING` (we'll need a unique index `unique(user_id, date)` on plans — check migration 0002 and add if missing); drop-off checks for an existing `pending` `return_from_gap` proposal before creating.

## 4. Wiring

Three entry points call the reconciler:

**On Today page load.** In `app/today/page.tsx`, before the `Promise.all` of fetches:

```ts
const { reconcile } = await import('@/lib/reconcile');
await reconcile(user.id, new Date(), 'today_page_load');
```

The freshness gate makes this a ~5ms no-op most of the time; only when `last_reconciled_at` is stale does it actually do work. We call it _before_ the other fetches so any newly-created plans or aged-out statuses are reflected in what we render.

**On activity logged.** In `app/api/activities/route.ts` POST, after the activity insert:

```ts
await reconcile(user.id, new Date(), 'activity_logged').catch(() => {});
```

Fire-and-forget — the user's response doesn't wait. This catches the case where a user logs their first session in 10 days; the reconciler notices the new activity and clears any stale `return_from_gap` proposal.

**On proposal applied.** Same pattern in `app/api/proposals/[id]/route.ts`.

**Nightly cron.** `app/api/cron/reconcile/route.ts`:

```ts
export async function POST(req: Request) {
  // Auth: Vercel Cron signs requests with CRON_SECRET header
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  const sb = supabaseServiceRole();
  const { data: users } = await sb.from('profiles').select('user_id');
  // Batch, not parallel — we want predictable DB load
  for (const { user_id } of users ?? []) {
    try { await reconcile(user_id, new Date(), 'nightly_cron'); }
    catch (e) { console.error('[cron] reconcile failed', user_id, e); }
  }
  return Response.json({ ok: true, count: users?.length ?? 0 });
}
```

`vercel.json`:

```json
{
  "crons": [
    { "path": "/api/cron/reconcile", "schedule": "0 4 * * *" }
  ]
}
```

4am UTC runs before most timezones' morning — gives the rolling window a chance to extend before the user opens the app. Per-user work is bounded (under 500ms each) so even thousands of users finish within Vercel's cron window.

## 5. UX — three shapes

This is the half that matters. The reconciler's output has three distinct user-visible states, and each needs its own presentation.

### 5a. Silent (99% of opens)

No drop-off, no phase drift, rolling window is already current. Today page renders as it does now. The only evidence the reconciler ran is that `plans` for today+21 exist — invisible unless the user scrolls the calendar three weeks out.

### 5b. Soft return (3–6 day gap)

A small banner above the existing TodayHero, using the same visual language as PendingBanner but warmer in tone:

```
┌──────────────────────────────────────────────────────┐
│ 👋  Welcome back — 4 days since your last session.   │
│     Want me to shift this week so it starts today?   │
│                                                      │
│     [ Shift this week → ]     No thanks, keep it     │
└──────────────────────────────────────────────────────┘
```

Component: `src/components/ReturnFromGapBanner.tsx`. Renders when the top pending proposal has `kind='return_from_gap'` and `gap_days ≤ 6`. One-tap "Shift this week" POSTs to `/api/proposals/[id]` with `action='accept_option'` + `option_id='reentry_soft'`. "No thanks" POSTs with `action='dismiss'` — marks the proposal as `rejected` without regenerating, and the banner doesn't come back until the next gap.

Key copy choices: "your last session" not "your last workout" (warmer, more personal), "want me to shift this week" not "you missed 4 sessions" (forward, not retrospective), "No thanks, keep it" not "Dismiss" (plain language, no jargon). The whole thing avoids any implication of failure.

### 5c. Hard return (7+ day gap)

This replaces the TodayHero entirely with a welcome-back hero. Same panel geometry as TodayHero (so the layout doesn't jump), but different content:

```
╭──────────────────────────────────────────────────────╮
│  WELCOME BACK                                        │
│                                                      │
│  Nine days since your last session. No stress —      │
│  here's how I'd pick things up:                      │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │ ◉  Re-entry week                 Recommended   │  │
│  │    Lower load this week, full next week.       │  │
│  │    Starts tomorrow with Push A.                │  │
│  └────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────┐  │
│  │ ○  Jump back in                                │  │
│  │    Resume the plan exactly where it was.       │  │
│  │    This week: 3 sessions.                      │  │
│  └────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────┐  │
│  │ ○  Reassess with Claude                        │  │
│  │    Rethink the plan. Takes ~2 minutes.         │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  [         Start re-entry week         ]             │
│                                                      │
│  Not ready to choose? Keep today's plan →            │
╰──────────────────────────────────────────────────────╯
```

Component: `src/components/ReturnFromGapHero.tsx`. Radio-group pattern — tapping an option row pre-selects it and updates the CTA ("Start re-entry week" / "Jump back in" / "Reassess with Claude"). Each option is a fully-computed plan diff stored in the proposal's diff field; accept fires one `/api/proposals/[id]` call with `option_id`.

Two escape hatches on purpose:

- **"Not ready to choose? Keep today's plan →"** — a subtle link under the CTA that dismisses the hero for this session only. Tomorrow, if there's still no activity, it comes back. Three session-dismissals in a row degrades to the soft-banner pattern instead (we stop being pushy).
- Tapping the weekly strip above navigates to that day's calendar — user can browse around without committing.

The "Reassess" option routes to a dedicated `/check-in` flow (separate PR, but the hook is planted here).

### What about phase-drift, conflicts, etc.?

In P1.0, those proposals don't exist yet. `kind` on ai_proposals is the seam: P1.2 adds `'phase_transition'`, P1.5 adds `'conflict'`, and each lands as a proposal with a kind-specific banner component. The return-from-gap patterns (soft banner vs. replacing hero) are the template all future proposal kinds will follow.

## 6. Edge cases

The ones worth thinking through before writing code:

**First-ever user.** No activities, no last_reconciled_at, seeded plans for the next week. Reconciler runs, age-out is a no-op (nothing in the past), roll-forward inserts days 8-21, drop-off sees no activities but also no plans older than today → treats this as a _new_ user, not a returning one. Rule: drop-off only fires if the user has at least one historical activity. Without this guard, every new user gets a welcome-back moment on day 3.

**User with seeded plans but zero activities, returning on day 10.** This looks like drop-off by the simple rule ("last activity was never"). We treat it as first-session-still-pending — offer the normal "Begin session" flow for today. Drop-off requires a prior `done` activity.

**User who never misses, perfect streak.** Reconciler runs daily, age-out always zero, roll-forward extends the window by one day, drop-off zero. Nothing user-visible. Good — that's the point.

**User with an existing pending `adjust` proposal and a new drop-off.** We create the return-from-gap proposal too. Today page shows the return-from-gap banner (highest priority) above the normal `PendingBanner`. If the user accepts the return-from-gap, we auto-reject any still-pending adjust proposals whose `created_at` is older than the gap — they're stale by definition. Comment on proposal: "superseded by return_from_gap".

**Timezone boundary.** User in UTC-8 at 11pm on Monday opens the app. Server `new Date()` returns Tuesday UTC. If we used UTC for "today," we'd age-out Monday's plan as missed — wrong, they still have an hour to log it. Fix: always format `today` using the user's timezone from profiles. Default `'UTC'` is fine for MVP; users can set it in `/you` (P1.1).

**Clock drift between cron and page load.** Cron runs at 4am UTC. User in UTC+2 opens at 5:30am local (3:30am UTC). Cron hasn't run yet for this day. Page-load call fills the gap — runs the reconciler synchronously and does the work. Fresh state for the user. Then the cron runs 30min later; freshness gate (30min) catches it or the advisory lock catches it. Either way, no double-work.

**Daylight savings.** Not a problem: we store dates as `date` columns (no time component). The weekly pattern doesn't care about DST. External calendar events (P1.4) will be timed and will care, but that's a later problem.

**User deletes their phase in `/you`.** `ensureUserSeeded` re-runs on next load and re-creates it. The reconciler doesn't know to restart — it walks the weekly pattern from the _active_ phase and inserts plans. If no phase is active, roll-forward skips (no pattern to walk from). Rule: reconciler gracefully no-ops if no active phase, and the existing seed path is the recovery mechanism.

**User on day 7 gap, opens app, dismisses hero, opens app again an hour later.** Freshness gate returns cached result; the hero re-renders because the proposal is still `pending`. The session-level dismiss is a `sessionStorage` flag on the client, not server state. Tomorrow, `sessionStorage` is cleared, and if still no activity, it comes back.

**User accepts "Jump back in" option.** Its diff is `{ updates: [], creates: [], deletes: [] }` — literally nothing changes. We still mark the proposal as `applied` so it doesn't reappear. Detail worth preserving in the apply path: zero-op proposals are valid.

**Multiple users, one cron tick fails halfway through.** Each user's reconcile is wrapped in try/catch; one user's failure doesn't block the batch. Failed users will have stale `last_reconciled_at` and their next page-load will reconcile them. We log errors to Sentry/console for ops visibility.

## 7. Testing

Unit tests for each module, with a tiny in-memory stub of Supabase reads/writes:

- `ageOut.test.ts` — planned-with-no-activity → missed, planned-with-done → untouched, already-missed → untouched
- `rollForward.test.ts` — empty future → 21 inserts, partial future (existing day 5 plan) → inserts around it, no active phase → no-op
- `dropOff.test.ts` — 0–2 day gap → no proposal, 3-6 → proposal with 2 options, 7+ → proposal with 3 options, existing pending → skip, zero historical activities → skip
- `freshness.test.ts` — < 30min and page_load → skip, > 30min → run, cron → always run

One integration test with a real Supabase local: seed a user, fast-forward 8 days, call reconcile, assert that (a) plans for days -1 through -8 are `missed`, (b) a return_from_gap proposal exists with `kind='return_from_gap'`, (c) plans exist through today+21.

Manual QA on staging — seed a couple of fixture users (0-day gap, 4-day gap, 9-day gap, 21-day gap) and screenshot the Today page for each. Include in the PR description.

## 8. PR sequence

One PR for P1.0 is too big. Split into four reviewable slices, each green on its own:

**PR-A — Migration + module scaffold.** Lands migration 0003, creates the `src/lib/reconcile/` directory with all files but each function a stub that returns `{ aged_out: 0, rolled_forward: 0, drop_off_detected: false, duration_ms: 0 }`. Wires the freshness gate, advisory lock, entry-point signature. No side effects, no UI. Gives us a place to layer the three algorithms without entanglement. Typecheck + unit-test freshness.

**PR-B — Age-out and roll-forward.** Implements both algorithms, with their unit tests. Wires into Today page load and activity/proposal API routes. No UI — behavior is purely state hygiene. Visible change: open a staging account, see plans extending past the original seed window. Verify in DB.

**PR-C — Drop-off detection + data only.** Implements drop-off algorithm. Adds migration data (`ai_proposals.kind`) already landed in 0003. Creates the proposal on the server, but renders it via the existing `PendingBanner` for now (which will look weird — that's fine, the next PR fixes it). Adds manual-test fixtures.

**PR-D — Return-from-gap UX + cron.** Builds `ReturnFromGapBanner` (soft) and `ReturnFromGapHero` (hard), wires the Today page to pick the right component based on gap size and proposal kind. Adds the session-dismiss. Adds `/api/cron/reconcile` route + `vercel.json` cron config. This is the one where the user-visible moment lands.

Each PR typechecks, ships to staging, and doesn't break the main flow. By PR-D, we have the full P1.0 capability and a foundation that P1.1+ slot into without rework.

## 9. Acceptance criteria

P1.0 is done when:

- A user with a stale seed and no phase-end set can open the app and see plans extending to `today + 21` without any manual intervention.
- A user with a 4-day gap sees the soft welcome-back banner and can one-tap to shift this week.
- A user with a 9-day gap sees the hard welcome-back hero with three options and can one-tap to accept a re-entry week.
- A user with a perfect streak sees no user-visible change and no added latency on Today page load.
- The nightly cron runs at 4am UTC and processes all users in under 60 seconds of function time.
- Typecheck passes, migration applies cleanly to staging, PR-D includes staging screenshots of all three reconciler states.

Ship this and the app becomes self-maintaining — the calendar stops being a thing the user has to curate.
