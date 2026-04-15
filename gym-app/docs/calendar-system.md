# Calendar & Plan Reconciliation — Design

_Status: design spec. Target implementation: P1 (after P0 ships). Last updated Apr 15, 2026._

## 1. Philosophy

One sentence: **the app is the source of truth, the calendar is a projection.**

Everything that happens — a missed day, a phase change, a long break, a goal update, a new weekly template — flows through the same primitive: a proposed change to the plan, which the user accepts (explicitly or by default). Once accepted, that change fans out to whatever external calendars the user has connected. External calendars can be _read from_ to surface conflicts, but never _written back into_ our plans without the user acknowledging them first.

Three rules that follow:

1. **No shame, always forward.** When the user returns after a gap, the system treats it as neutral data: it never says "you missed 4 sessions." It shifts the window and invites them back in.
2. **Everything is a proposal.** Reconciler changes, AI-initiated shifts, weekly-template edits, phase transitions — all land in `ai_proposals` so the user can see what changed and why, and roll back if wrong.
3. **Idempotent everywhere.** Every plan carries a stable id, every external event carries the `plan_id`, every sync is a last-write-wins upsert keyed on that id. No duplicates, no orphans, no "why do I have two gym sessions on Tuesday?"

## 2. Why the current model needs more

Right now the `plans` table is basically hand-seeded at signup. It works for a first-run week and for the AI-adjust path, but it has no answer for:

- **Rolling forward.** What happens at the end of a week? A month? The seeded calendar just runs out.
- **Absence.** A user who logs nothing for 8 days still has "ghost" planned sessions on Monday, Tuesday, Wednesday of last week sitting in the past as `past_missed`. On return, the Today tab shows the stale plan for today but does nothing about the stale week behind it or the fact that this week's template probably doesn't fit anymore.
- **Phase drift.** Phases have a `target_ends_on`, but nothing acts on it. A phase that ended 12 days ago is still "active."
- **Template edits.** If the user says "I want 4 gym days, not 3," there's no machinery that rewrites the next 3 weeks of plans.
- **External calendar.** We don't sync anywhere. The user can't see their training on the same surface as their meetings.

All five are solvable with the same pattern: a **reconciler** plus a **template** plus a **sync adapter**.

## 3. The scenarios we need to support

Before drawing architecture, enumerating the triggers — this is the set that has to Just Work:

| # | Trigger | Expected behavior |
|---|---|---|
| 1 | User logs a session that matches plan | No change — plan stays, activity links to it |
| 2 | User logs a session that diverges (cardio instead of gym) | Existing AI proposal flow; plan may update to reflect reality, future plans may shift |
| 3 | User skips with a reason ("too tired") | Plan marked skipped; reconciler decides whether to reschedule or absorb |
| 4 | User misses a day silently (no log at all) | Reconciler on next visit: age-out past missed sessions, optionally offer retroactive logging |
| 5 | User returns after a 3–14 day gap | "Welcome back" proposal with 2–3 options (re-entry week, jump back in, reassess) |
| 6 | User returns after 14+ days | Fresh check-in: phase reassess, new weekly template |
| 7 | End of week (rolling) | Sunday-night job extends plans +21 days using the user's active template |
| 8 | Phase ends | Reconciler proposes: auto-transition to next phase, extend this phase 2 weeks, or prompt for a check-in |
| 9 | User edits weekly template | Future plans (today+ N) are regenerated; proposal shown as one diff |
| 10 | User says "I'm traveling next week" / "injured 2 weeks" | Window marked `paused`; plans in that window become bodyweight/rest variants or get suppressed |
| 11 | Meeting blocks a planned session time | Conflict proposal: shift to morning, move to adjacent day, or skip |
| 12 | User connects Google Calendar for the first time | All plans backfilled as events in a dedicated training calendar |
| 13 | User disconnects integration | Stop writing; past events stay where they are on their cal |
| 14 | Plan gets updated in app | External event updated in place (etag-based, no duplicates) |
| 15 | Plan gets deleted | External event deleted (or cancelled) |
| 16 | User moves an event in Google Calendar | Read-only for us: either ignore (app is truth) or surface as a proposal to update our plan. Default: ignore, show a subtle "Google moved this — keep app plan?" chip |

## 4. Source-of-truth model

The data model extends modestly. New tables in **bold**, additions to existing in _italics_:

- `phases` — adds _status-transition hooks_; `target_ends_on` becomes actionable.
- `plans` — adds _`source` column_ (`seed`, `template`, `proposal`, `manual`) so reconciler knows what it can rewrite; adds _`window_id`_ so we can tag a pause window.
- `activities` — unchanged. Activities are immutable history.
- `ai_proposals` — unchanged. All reconciler output is a proposal.
- **`weekly_templates`** — one active row per user per phase; rows for mon/tue/wed/thu/fri/sat/sun, each a `{type, day_code}` or null.
- **`availability_windows`** — `{user_id, starts_on, ends_on, kind: 'travel' | 'injury' | 'pause', note, metadata}`. Reconciler respects these when generating plans.
- **`user_integrations`** — `{user_id, provider, status, external_calendar_id, access_token_enc, refresh_token_enc, expires_at, last_sync_at, last_error}`.
- **`plan_events`** — `{plan_id, provider, external_event_id, etag, synced_at}`. Maps a plan row to an event in an external calendar. Unique on `(plan_id, provider)`.
- **`sync_jobs`** — the reconciler's queue. `{user_id, kind, payload, status, attempt, run_after, last_error}`. Worked by a cron + on-write trigger.

Crucially, plans are the _authoritative_ record. `plan_events` is a side-index: if it disappears, we rebuild it. If external events disappear, we recreate them on next sync. The system is self-healing because the reconciler's job is explicitly to reconcile `plans ↔ plan_events ↔ external calendar`.

## 5. The reconciler

One pure-ish server function: `reconcile(user_id, now, cause)`. It runs:

- **On write** — any mutation to `plans`, `activities`, `phases`, `weekly_templates`, `availability_windows` enqueues a reconcile for that user.
- **On page load** — the Today server component calls it synchronously if `user.last_reconciled_at` is older than ~30 minutes. Cheap when nothing has drifted; meaningful when something has.
- **Nightly cron** — once a day per user, does the heavier work (rolling window, phase drift, conflict scan).

What it does, in order, each pass:

1. **Age out the past.** Any plan with `date < today` that has no matching activity gets its status set to `missed`. Not deleted. Not rescheduled automatically — the user can retro-log or ignore.
2. **Detect drop-off.** Find the most recent activity. If `today - last_activity.date > 3` and there are planned sessions in the gap, create a proposal of kind `return_from_gap` with 2–3 concrete plan diffs (re-entry / jump back / reassess). _Only_ create it if no active proposal of this kind exists — idempotent.
3. **Honor availability windows.** For any upcoming plan whose date falls inside an active `availability_windows` row, suppress or rewrite it (rest days, bodyweight, or nothing). This is a single diff in one proposal.
4. **Phase drift.** If active phase's `target_ends_on <= today`, create a `phase_transition` proposal: "Your strength block ended Apr 12. Move to maintenance, extend 2 weeks, or check in?"
5. **Extend the rolling window.** Ensure plans exist up to `today + 21` by walking the active weekly template. Skip dates inside availability windows. Mark source = `template`.
6. **Sync fan-out.** For each plan where `plan_events` is stale or missing, enqueue a `sync_jobs` row so the worker can write to the external calendar.
7. **Conflict scan** (only on nightly run). If Google Calendar integration is active, read the user's primary calendar for the next 14 days. For each plan, check if a meeting overlaps the typical session time. If yes, create a `conflict` proposal.

Note what it doesn't do: it doesn't touch activities (history is sacred), it doesn't rewrite past plans, and it doesn't ever silently change what the user sees for today without a proposal. Every change is either a proposal the user accepts or a rolling-window extension (which extends into empty future days, so there's nothing to disrupt).

## 6. Drop-off / return policy in detail

This is the scenario you called out specifically, so it deserves a concrete policy.

The reconciler bucket a user on return by gap size (days since last activity):

- **0–2 days.** Normal. Today tab shows LastSessionCard as designed. No proposal.
- **3–6 days.** Soft return. Banner on Today: "Welcome back — 5 days since your last session. Want me to adjust this week?" Opens a proposal sheet offering (a) keep the rest of this week as planned, (b) shift this week's remaining sessions to start from today.
- **7–14 days.** Hard return. Instead of the normal hero, show a "Welcome back" hero with three options: (a) a light re-entry week (lowered volume), (b) jump straight back to where you left off, (c) reassess the plan with Claude. Each option is a concrete plan diff, already computed, not a conversation. One tap applies.
- **14+ days.** Full reset path. Route to a short check-in: "Any injuries? How have you been training? What's the goal?" → Claude regenerates the weekly template and the next 3 weeks. Old plans in the gap stay marked `missed`; the arc carries on.

The key UX point: the app _never_ shows "you missed 4 sessions this week" as a loss frame. It shows "your plan now starts Wednesday" as a forward frame. Weekly targets don't count historical misses against the user retroactively once a return proposal has been accepted.

Two safeguards:

- The reconciler waits until the user actually opens the app to act. No push notifications that fire at day 7 saying "you're slipping." The gap is only a thing once the user comes back.
- The "re-entry week" option is the default, pre-selected. Most people returning from a gap benefit from lowered load; it's also the most forgiving default if they misread and hit accept quickly.

## 7. Rolling-window generation

The generator is a pure function: given `(weekly_template, start_date, end_date, availability_windows)`, return an array of proposed `plans` rows. It's called in three places:

- Nightly reconciler, with `end_date = today + 21`.
- When a user edits the weekly template, with `end_date = today + 28` and `start_date = today + 1` (we don't rewrite today or past).
- On phase transition, with the new template and `start_date = phase.starts_on`.

Because it's pure, it's easy to diff: compare the proposed array to existing `plans` in the same range, produce `creates`, `updates`, `deletes`. That diff goes into an `ai_proposal`. For the nightly job, if the diff is only `creates` into empty future days, auto-apply. If the diff touches existing plans, put it in the proposal queue for user review.

Heuristic for "same session": plans are considered equivalent if `(date, type, day_code)` match. Prescription contents can differ (that's Claude's job to fill in later). This lets the reconciler roll the skeleton forward without fighting Claude's prescription work.

## 8. External calendar integration

The target is Google Calendar first, Apple/Outlook via an iCal feed second. The underlying pattern is the same: we own a **dedicated training calendar** on the external provider, and we sync 1:1 between plans and events in that calendar.

### Click-to-connect (Google)

The user journey:

1. In `/you/integrations` (new page) there's a card: "Connect Google Calendar → see your training alongside your meetings."
2. One click → OAuth consent → we ask for `calendar` scope (not just events — we need to create a calendar).
3. On callback: we create a dedicated calendar (`{AppName} Training`), store its id on `user_integrations.external_calendar_id`, store refresh token encrypted, flip `status = 'active'`.
4. We immediately enqueue a `full_backfill` sync job. Within seconds, every plan becomes an event. The `/you/integrations` page flips the card to "Synced · Apr 15, 14:03 · Disconnect."
5. Token refresh handled by the worker. If refresh fails (user revoked access in Google), status flips to `revoked` and a banner appears on Today: "Google Calendar disconnected — Reconnect." No data loss; we just stop writing.

What events look like in Google:

- Title: `Push · Gym` (or `Rest day`, `Recovery`, etc.)
- Time: user's preferred session time (from a `training_preferences` setting: morning / midday / evening defaults, with per-day override).
- Description: brief prescription summary + a link back to `/log/{planId}`.
- Color: consistent per modality (lime for gym, blue for cardio, etc.) via the `colorId` field.
- Extended properties: `private.planId = {uuid}` — this is how we match events back to our plans.

The extended property is the key to reliability. Even if our `plan_events` index is wiped, we can read events out of the training calendar, read `planId` from each, and reconstruct the mapping. Nothing in Google is orphaned unless the user deletes the calendar itself.

### Write reliability

Every mutation of a plan goes through a narrow API (`upsertPlan`, `deletePlan`). Those functions, in addition to writing to Postgres, enqueue a `sync_jobs` row. A worker drains the queue with:

- Exponential backoff on failure (1m, 5m, 30m, 2h, 12h).
- etag-based conditional updates (Google returns etag on each event; we store it; we send `If-Match` on updates; on 412 we re-read and retry).
- Idempotency via `planId` extended property — if we lose the `plan_events` row mid-write, the next attempt looks up the event by `privateExtendedProperty=planId={uuid}` and either patches or creates.
- Rate-limit awareness — Google gives 500 req/100s per user; we batch where possible.

Worst case, the reconciler's nightly "reconcile external" job does a full scan: read all events in the training calendar, diff against `plans`, upsert/delete to match. This is the backstop that guarantees eventual consistency regardless of what went wrong intraday.

### Read (conflict detection)

Separately, a daily job reads the user's **primary** calendar for the next 14 days (scope: `calendar.readonly` on the primary cal, or — if we want to be stricter — freebusy only). For each of our plans, we check whether any meeting overlaps the plan's scheduled time window (e.g. plan at 18:00–19:30, meeting at 18:30–19:00 → overlap).

If there's overlap, we create a `conflict` proposal. The user sees it as an ambient suggestion on Today: "Monday 6pm is blocked by 'Dinner with investors' — move to Tuesday or shift to morning?"

This is explicitly _not_ bi-directional: the user moving an event in Google _does not_ rewrite our plan. Instead, on the next scan, we detect the mismatch and either ignore it (if it still fits a reasonable window) or surface a proposal. Your rule — "the app dictates the calendar, not the other way around" — stays intact.

### Apple Calendar / Outlook / everything else

For providers where we don't invest in bespoke OAuth: expose a signed per-user iCal feed at `/api/ical/{signed_token}.ics`. User copies the URL once, subscribes in Apple Calendar, done. Read-only from the user's side — changes propagate from our DB within the feed's refresh cadence (typically 1h on iOS).

This is 1 day of work and covers 80% of users who aren't on Google. We ship it at the same time.

## 9. Phased implementation

None of this is small, so it lands in phases. Each phase is independently useful — the user gets value at the end of each, nothing waits for everything.

**P1.0 — Reconciler foundation (1 week).** The `reconcile()` function, the `sync_jobs` table, the nightly cron, the on-page-load trigger. Age-out missed plans, detect drop-off, generate rolling window. No external integration yet. Ship with the return-from-gap proposal visible as an ambient banner on Today. Value: the calendar now self-extends and self-heals within the app.

**P1.1 — Weekly templates (3 days).** Lift the hand-seeded weekly pattern into `weekly_templates`. Settings UI in `/you` to edit it. Reconciler regenerates when it changes. Value: user can say "4 gym days now, not 3" and the next 3 weeks shift.

**P1.2 — Phase transitions (2 days).** Phase-end detection, transition proposals. Value: phases stop rotting; user gets a clean handoff between blocks.

**P1.3 — Availability windows (2 days).** "I'm traveling next week" / "I'm injured 2 weeks" becomes a first-class primitive that the reconciler honors. Value: travel and injuries stop derailing the arc.

**P1.4 — Google Calendar write (1 week).** OAuth, dedicated training calendar, full backfill, job-queue worker with etag upserts, disconnect flow. Value: the user sees their training alongside their meetings, on every surface they already use.

**P1.5 — Conflict detection (3 days).** Daily scan of primary calendar, conflict proposals. Value: the app now notices when real life overlaps the plan and offers to shift.

**P1.6 — iCal feed (1 day).** Signed URL, read-only subscription. Value: Apple/Outlook/anything-else coverage.

Total: ~4 weeks of work across the phases. P1.0 is the one that unblocks everything else and gives the most user-visible change per line of code; start there.

## 10. Reliability, observability, failure modes

Things that will go wrong and how we catch them:

- **Google token refresh fails.** Worker marks integration as `error`, captures the message, banner appears on Today. User sees a real error, not silence.
- **Reconciler creates a bad proposal.** Every proposal has a human-reviewable diff and a one-tap reject. A bad proposal is a visible mistake, not a silent rewrite.
- **Plan and event drift.** Nightly full-scan reconcile is the backstop. If it has to fix more than N events per user in one run, log it and surface in an internal dashboard.
- **User clicks accept on two conflicting proposals.** Each proposal `apply` is a transaction; the second one sees the state produced by the first and merges or no-ops.
- **Clock skew / timezones.** User's timezone is stored on their profile. All plan dates are in user-local. All external events are scheduled in user-local tz. Reconciler uses `date-fns-tz` — never UTC math on user dates.
- **Double-fire of nightly cron.** Worker claims jobs with `update sync_jobs set status='running' where id=? and status='queued'` — classic row-lock pattern. If two workers race, only one wins.

Metrics we'll want in the ops dashboard (even a simple view on Supabase):

- `sync_jobs_queued_gt_100` — backlog alarm
- `sync_jobs_failed_in_24h` — error-rate alarm
- `integrations_in_error_state` — per-provider health
- `avg_time_to_sync` — p95 latency from plan write to external event visible
- `returns_after_gap` per week — how often users come back; product signal

## 11. Concrete first step

When you're ready to start on this, the first concrete PR is:

1. Add `weekly_templates`, `availability_windows`, `plan_events`, `sync_jobs`, `user_integrations` tables (migration).
2. Build `reconcile(user_id, now, cause)` with just step 1 (age-out) and step 5 (rolling window) enabled. Skip integrations, phase transitions, availability, conflict scan, and drop-off detection.
3. Wire it into `app/today/page.tsx` server component (cheap call, 30-min freshness check).
4. Wire it into a Vercel Cron at `0 4 * * *`.
5. Verify: an account with no activity for 7 days that opens Today sees yesterday's missed plan marked `missed`, and plans now exist through day+21. No proposals yet, no UI banners — just the underlying state hygiene.

That's the skeleton. Drop-off banners (step 2), phase transitions (step 4), Google Calendar (P1.4) layer on without touching the plumbing.

---

**Bottom line.** The right model is: the app's plans table is truth, the reconciler is the heartbeat that keeps truth coherent, proposals are the only interface between machine changes and the user, and external calendars are write-only projections (with a read-only conflict sensor). Get that shape right in P1.0–P1.4 and everything else — drop-off recovery, travel, injury, phase transitions, click-to-connect Google Calendar — becomes small additions rather than new architectures.
