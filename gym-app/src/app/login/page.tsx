'use client';

import { supabaseBrowser } from '@/lib/supabase/client';

export default function LoginPage() {
  const supabase = supabaseBrowser();

  async function signInWithGoogle() {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/api/auth/callback`,
        scopes: 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events',
        queryParams: { access_type: 'offline', prompt: 'consent' },
      },
    });
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-3xl font-bold mb-2">Gym</h1>
        <p className="text-muted text-sm mb-8">Your training log + AI-adaptive program.</p>
        <button
          onClick={signInWithGoogle}
          className="w-full bg-accent text-black font-semibold rounded-xl py-3.5"
        >
          Continue with Google
        </button>
        <p className="text-xs text-muted mt-6">
          We'll ask for Google Calendar access so your sessions can sync.
        </p>
      </div>
    </main>
  );
}
