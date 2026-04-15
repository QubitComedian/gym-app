import { supabaseServer } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { ensureUserSeeded } from '@/lib/seed/user-seed';

export default async function Home() {
  const supabase = supabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // First-run: seed this user's program, phases, prefs, and imported history from the v0 log.
  await ensureUserSeeded(user.id);

  const today = new Date().toISOString().slice(0, 10);

  const [{ data: nextPlan }, { data: recentActs }, { data: activePhase }] = await Promise.all([
    supabase.from('plans').select('*').eq('user_id', user.id).eq('status', 'planned').gte('date', today).order('date').limit(1).single(),
    supabase.from('activities').select('*').eq('user_id', user.id).order('date', { ascending: false }).limit(5),
    supabase.from('phases').select('*').eq('user_id', user.id).eq('status', 'active').single(),
  ]);

  return (
    <main className="max-w-xl mx-auto px-4 py-6 pb-24">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Hey Thibault</h1>
        <p className="text-muted text-sm">{today}</p>
      </header>

      {activePhase && (
        <section className="mb-6 p-4 rounded-xl bg-panel border border-border">
          <div className="text-xs uppercase tracking-wider text-muted">Current phase</div>
          <div className="mt-1 text-lg font-semibold">{activePhase.name}</div>
          {activePhase.description && <p className="text-sm text-muted mt-1">{activePhase.description}</p>}
          {activePhase.target_ends_on && (
            <p className="text-xs text-muted mt-2">Target end: {activePhase.target_ends_on}</p>
          )}
        </section>
      )}

      <section className="mb-6 p-4 rounded-xl bg-panel border border-border">
        <div className="text-xs uppercase tracking-wider text-muted">Next session</div>
        {nextPlan ? (
          <>
            <div className="mt-1 text-xl font-semibold">
              {nextPlan.type === 'gym' ? `Day ${nextPlan.day_code}` : nextPlan.type}
            </div>
            <p className="text-sm text-muted">{nextPlan.date}</p>
          </>
        ) : (
          <p className="text-sm text-muted mt-1">No upcoming plan. Tap below to generate one.</p>
        )}
      </section>

      <section className="mb-6 p-4 rounded-xl bg-panel border border-border">
        <div className="text-xs uppercase tracking-wider text-muted mb-2">Recent</div>
        <ul className="space-y-2">
          {(recentActs || []).map((a) => (
            <li key={a.id} className="text-sm flex justify-between">
              <span>{a.date} · {a.type}</span>
              <span className="text-muted">{a.status}</span>
            </li>
          ))}
          {!recentActs?.length && <li className="text-sm text-muted">Nothing logged yet.</li>}
        </ul>
      </section>

      <p className="text-xs text-muted text-center mt-8">
        v1 PR 1 · auth + schema. UI ports next.
      </p>
    </main>
  );
}
