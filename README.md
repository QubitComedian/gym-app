# Gym — how to use this folder

## Files

- **`index.html`** — the app. Open it on your phone to log sessions.
- **`PROGRAM.md`** — written version of your current program, progression rules, and exercise memory (banned/liked).
- **`README.md`** — this file.

## Opening the app on your phone

Because the folder is in iCloud Drive, it syncs to your phone automatically.

1. On your iPhone, open **Files → iCloud Drive → Gym**.
2. Tap `index.html`.
3. It will open in Safari. Add to Home Screen (Share → Add to Home Screen) for one-tap access that looks like a native app.

All data lives in your phone's browser storage. Safari keeps localStorage across launches for pages added to the Home Screen, so your logs persist.

## Opening on desktop

Double-click `index.html`. Opens in your default browser. Note: Mac Safari and iPhone Safari have separate storage — each device has its own log history until we move to a real backend (see v1 roadmap).

## Daily flow

1. Open the app. "Today" tab shows the next day in rotation (A / B / C / D) — you can override.
2. Tap **Start session**.
3. For each exercise, the faint number under each input is **what you did last time** for that set. Aim to match or beat it.
4. Log weight, reps, and RIR (how close to failure). Add notes if something's off.
5. Use the rest-timer buttons (60s / 90s / 2min) — they vibrate when done.
6. At the bottom: rate the session 1–5 and add overall notes.
7. Tap **Finish session**. It lands in History.

## When an exercise isn't working

- In the input field: add a per-set note (e.g. "form broke" — currently shown via the per-set notes in history).
- After the session: go to **Exercises** tab and add a preference (liked / neutral / banned) with your reason. That's your memory — it's what Claude will read to never suggest the exercise again without asking.

## Backup

**Settings → Export JSON** once a week. Save the file back into this Gym folder or anywhere in iCloud. That's your safety net against a browser wiping local data.

---

## v1 roadmap — where this is going

V0 (this file) proves the logging UX. V1 adds the full closed loop you described.

### v1.0 — Cloud + multi-device (est. 1 weekend)

- Port the app to **Next.js on Vercel** + **Supabase** (Postgres + auth).
- Same three screens, same data model, but data lives in Postgres — accessible from phone, laptop, anywhere, always in sync.
- Installable PWA with offline logging — the in-gym experience stays snappy even with bad wifi.
- Import your v0 JSON to seed the DB.

### v1.1 — Claude AI review (est. 1 weekend)

- "Finish session" triggers a Claude call with: this session's sets + sentiment + notes, the last 2–4 weeks of context for each movement pattern, your program config, the exercise-memory (banned/liked list), and your trainer brief.
- Claude returns a **structured diff** for next session: exercise swaps, weight bumps, volume adjustments, plus a human-readable explanation.
- **You approve before anything applies** (per your decision in the planning round). A single "Approve" button pushes the changes into the program.
- Over time (say after a month of approvals), add an "Auto-apply if Claude is confident and change is small" setting.

### v1.2 — Dynamic calendar sync (est. 1 weekend)

- **Website is source of truth.** Calendar is a projection.
- A cron reconciles the next 7 days in Google Calendar whenever the program changes (after an approved AI review, or after you drag-to-reschedule in the app).
- Each calendar event description includes a deep link back to the session in the app.
- Moving an event in Google Calendar syncs back as a reschedule.
- "I only have 30 min today" button — compresses or swaps the session via Claude.

### v1.3 — Quality of life

- **Per-exercise PR tracking** and trend charts (volume, estimated 1RM, best set).
- **"What was my form cue last time?"** surfaced on the Today screen — your own past notes are the highest-leverage reminder.
- **Deload mode** detection — if sentiment drops for 2+ sessions or weight stalls, Claude proposes a deload week.
- **Run integration** — log runs alongside lifts so the whole picture is in one place; pull from Strava/Apple Health when ready.
- **Mobility + handstand module** for when you transition phases per the brief.

### Open decisions for when we start v1

- Do you want a shared identity across devices, or is phone-first fine? (→ drives auth complexity.)
- Which calendar: Google, iCloud, both? (Google has the best API; iCloud via CalDAV is possible but noisier.)
- Strava connection for runs — now or later?
- Do you want to share read-only access with a real-world trainer at any point? (→ drives auth model.)

When you're ready to start v1, tell me and we'll scope the first PR.
