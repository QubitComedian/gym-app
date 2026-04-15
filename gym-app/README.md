# gym-app

Cloud v1 of the gym logger. Next.js + Supabase + (eventually) Anthropic + Google Calendar.

See **DEPLOY.md** for step-by-step deployment.

## Structure

```
gym-app/
├── src/
│   ├── app/
│   │   ├── layout.tsx, page.tsx, globals.css     # home + layout
│   │   ├── login/page.tsx                         # Google OAuth entry
│   │   └── api/auth/callback/route.ts             # OAuth callback — stores Google tokens
│   ├── lib/
│   │   ├── supabase/{client,server}.ts            # Supabase clients (browser + SSR + service)
│   │   └── seed/{user-seed,seed-data}.ts          # first-run seed per user
│   └── middleware.ts                              # auth gate on every route
├── supabase/
│   ├── migrations/0001_init.sql                   # schema + RLS
│   └── seed.sql                                   # public exercises catalog
├── package.json, tsconfig.json, next.config.mjs
├── tailwind.config.ts, postcss.config.js
├── .env.example, .gitignore
└── DEPLOY.md                                      # ← start here
```

## Roadmap

- **PR 1 (this)** · Schema + auth + seed — foundation is real.
- **PR 2** · UI port + multi-activity quick-log.
- **PR 3** · Claude review loop + proposal approval.
- **PR 4** · Dynamic Google Calendar sync.
