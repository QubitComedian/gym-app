# Gym v1 — deployment guide

This gets you from a GitHub push to a live app on your phone in about 20 minutes of clicking. No local dev required.

## What PR 1 includes

- Next.js 14 + TypeScript + Tailwind scaffold
- Full Supabase schema (activities, plans, phases, proposals, calendar links, Google tokens)
- RLS policies on every user-owned table
- Exercises catalog seeded at migration time
- Per-user seed on first sign-in: trainer brief, 4-day program, 4-phase macro plan (bulk → consolidate → cut → athletic transition), exercise prefs (RDL banned, etc.), Apr 2–14 history, 4 weeks of initial forward-plans
- Google OAuth via Supabase (stores provider tokens for Calendar API)
- Middleware-enforced auth on every page

## What PR 1 does NOT yet do

- Port the in-gym logging UI from v0 (that's PR 2)
- Call Claude for session review (PR 3)
- Write/read Google Calendar (PR 4)

The home page in PR 1 is intentionally minimal: it confirms auth works, shows your active phase, next planned session, and last 5 activities. Proves the foundation is real.

---

## Step 1 — GitHub

1. Create a new repo (private) at github.com/new — name it `gym-app`.
2. On your Mac, from the Gym folder:
   ```bash
   cd gym-app
   git init
   git add -A
   git commit -m "gym v1 PR1: schema + auth scaffold"
   git branch -M main
   git remote add origin git@github.com:YOUR_USERNAME/gym-app.git
   git push -u origin main
   ```

## Step 2 — Supabase project

1. Go to https://supabase.com/dashboard → **New project**
2. Name: `gym`. Region: closest to you (e.g. `eu-west-2`). Generate a strong DB password and save it.
3. Wait ~2 min for provisioning.
4. Once ready → **SQL Editor** → paste the entire contents of `supabase/migrations/0001_init.sql` → **Run**.
5. Same page: paste `supabase/seed.sql` → **Run**. (This seeds the shared exercises catalog.)
6. **Authentication → Providers → Google** → enable.
   - You'll paste your Google Client ID and Secret here after Step 3.
7. **Project Settings → API** → copy:
   - `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (keep secret)

## Step 3 — Google Cloud OAuth

1. https://console.cloud.google.com → create new project `gym-app`.
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen**:
   - User type: External → Create
   - App name: `Gym`, support email: thibault.decidrac@gmail.com
   - Scopes → Add: `.../auth/calendar`, `.../auth/calendar.events`
   - Test users: add thibault.decidrac@gmail.com
4. **APIs & Services → Credentials → + Create → OAuth client ID**:
   - Type: Web application
   - Authorized redirect URIs: add **both**:
     - `https://YOUR-SUPABASE-REF.supabase.co/auth/v1/callback` (for Supabase social login)
     - `https://YOUR-VERCEL-DOMAIN.vercel.app/api/auth/callback` (for app-side OAuth, used after Step 4)
5. Copy the Client ID and Client Secret.
6. Back in Supabase → **Auth → Providers → Google** → paste Client ID and Secret → save.

## Step 4 — Vercel

1. https://vercel.com/new → import your `gym-app` GitHub repo.
2. Framework: Next.js (auto-detected). Root directory: `./`.
3. **Environment Variables** — add:
   ```
   NEXT_PUBLIC_SUPABASE_URL        = ...
   NEXT_PUBLIC_SUPABASE_ANON_KEY   = ...
   SUPABASE_SERVICE_ROLE_KEY       = ...
   GOOGLE_CLIENT_ID                = ...
   GOOGLE_CLIENT_SECRET            = ...
   GOOGLE_REDIRECT_URI             = https://YOUR-DOMAIN.vercel.app/api/auth/callback
   ANTHROPIC_API_KEY               = sk-ant-... (add when you start PR 3; fine to leave blank for PR 1)
   NEXT_PUBLIC_APP_URL             = https://YOUR-DOMAIN.vercel.app
   CRON_SECRET                     = generate a random string
   ```
4. **Deploy**.
5. Once deployed, note the domain (e.g. `gym-app-xyz.vercel.app`). Go back to Google Cloud Console → Credentials → edit the OAuth client → update `GOOGLE_REDIRECT_URI` and the Vercel authorized redirect to match. Also update Supabase `NEXT_PUBLIC_APP_URL` env var if needed.

## Step 5 — Install as a PWA on your phone

1. On iPhone Safari, go to the Vercel URL.
2. Sign in with Google (your thibault.decidrac@gmail.com account). Approve Calendar access.
3. Share button → **Add to Home Screen**. Name it "Gym". Tap done.
4. From now on: tap the Gym icon on your home screen to open.

## Migrating your v0 data

Once signed in, the first-run seed (`src/lib/seed/user-seed.ts`) will automatically insert:
- Your trainer brief (from `seed-data.ts` → `TRAINER_BRIEF`)
- Your active program (4-day split config)
- All 4 phases (bulk → consolidate → cut → athletic transition)
- Exercise prefs (RDL banned etc.)
- April 2–14 session history
- 4 weeks of initial plans

If you have additional v0 JSON to import, you'll use the Import button in PR 2's Settings screen (or I can add a one-shot import endpoint if needed sooner).

## Troubleshooting

- **Redirect loop on sign-in** → OAuth redirect URIs don't match. Re-check that the Vercel URL is listed in Google Console AND Supabase Auth settings.
- **"Cookie parse error"** → Supabase SSR sometimes chokes on stale cookies. Clear cookies for the domain and re-sign in.
- **Seed didn't run** → The seed is idempotent (checks for profile existence). If you need to re-run, delete your row from `profiles` in the Supabase Table Editor and reload the app.
- **RLS blocks queries** → you're probably trying a query from the service role; use `supabaseServer()` from a user context, not `supabaseServiceRole()`.

---

## Next up

- **PR 2** (UI port): Today/Week/History/Exercises screens, the full logger from v0 but against Supabase, quick-log for runs/sauna/yoga/climb.
- **PR 3** (Claude loop): `/api/ai/review`, proposal approval flow, `handle_deviation` for missed + unplanned sessions.
- **PR 4** (Calendar): write path + idempotent reconcile + Google webhook for drag-to-reschedule.

Tell me when you've got PR 1 deployed and I'll open PR 2.
