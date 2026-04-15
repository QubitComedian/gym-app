import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';

export function supabaseServer() {
  const store = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) { return store.get(name)?.value; },
        set(name: string, value: string, options: CookieOptions) {
          try { store.set({ name, value, ...options }); } catch { /* Server Components cannot set */ }
        },
        remove(name: string, options: CookieOptions) {
          try { store.set({ name, value: '', ...options }); } catch { /* noop */ }
        },
      },
    }
  );
}

/** Service-role client for trusted server tasks (seeding, cron). Never expose to the client. */
export function supabaseServiceRole() {
  const { createClient } = require('@supabase/supabase-js');
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}
