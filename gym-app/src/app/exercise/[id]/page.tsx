import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { format } from 'date-fns';
import { supabaseServer } from '@/lib/supabase/server';
import { getExercise, prettyName } from '@/lib/exercises/library';
import ExerciseHistoryChart from './HistoryChart';

export const dynamic = 'force-dynamic';

type SetRow = { w?: number | string; r?: number | string; rir?: number; note?: string };

export default async function ExerciseDetail({ params }: { params: { id: string } }) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect('/login');

  const id = decodeURIComponent(params.id);
  const entry = getExercise(id);
  const name = entry?.name ?? prettyName(id);

  const [{ data: activities }, { data: plans }] = await Promise.all([
    sb.from('activities').select('date, data, sentiment, notes').eq('user_id', user.id).eq('type', 'gym').order('date', { ascending: false }).limit(200),
    sb.from('plans').select('id, date, day_code, prescription, type').eq('user_id', user.id).eq('status', 'planned').gte('date', format(new Date(), 'yyyy-MM-dd')).order('date').limit(20),
  ]);

  // History: pull sets[id] from every activity's data
  type HistRow = { date: string; sets: SetRow[]; bestW: number; topVolume: number; note?: string };
  const history: HistRow[] = [];
  for (const a of activities ?? []) {
    const rows: SetRow[] | undefined = a.data?.sets?.[id];
    if (!rows || rows.length === 0) continue;
    let bestW = 0, topVolume = 0;
    for (const r of rows) {
      const w = typeof r.w === 'number' ? r.w : Number(r.w) || 0;
      const reps = typeof r.r === 'number' ? r.r : Number(r.r) || 0;
      if (w > bestW) bestW = w;
      if (w * reps > topVolume) topVolume = w * reps;
    }
    history.push({ date: a.date, sets: rows, bestW, topVolume, note: a.notes ?? undefined });
  }

  // Next scheduled appearance
  let nextUp: { date: string; plan_id: string; day_code: string | null } | null = null;
  for (const p of plans ?? []) {
    const blocks = p.prescription?.blocks ?? [];
    const found = blocks.some((b: any) =>
      (b.kind === 'single' && b.exercise_id === id) ||
      (b.kind === 'superset' && (b.items ?? []).some((it: any) => it.exercise_id === id))
    );
    if (found) { nextUp = { date: p.date, plan_id: p.id, day_code: p.day_code ?? null }; break; }
  }

  return (
    <main className="max-w-xl mx-auto px-4 pt-5 pb-28 space-y-5">
      <Link href="/you" className="text-tiny text-muted-2 hover:text-white">← Back</Link>

      <header>
        <div className="text-tiny text-muted uppercase tracking-wider">Exercise</div>
        <h1 className="text-2xl font-bold tracking-tight">{name}</h1>
        {entry && (
          <div className="text-small text-muted-2 mt-1">
            {entry.primary_muscle}
            {entry.equipment?.length ? <> · {entry.equipment.join(', ')}</> : null}
          </div>
        )}
      </header>

      {nextUp && (
        <section className="rounded-xl bg-accent-soft border border-accent/40 px-4 py-3">
          <div className="text-tiny text-accent uppercase tracking-wider mb-0.5">Next up</div>
          <div className="text-small">
            <Link href={`/calendar/${nextUp.date}`} className="font-semibold hover:underline">
              {format(new Date(nextUp.date + 'T00:00:00'), 'EEE, MMM d')}
              {nextUp.day_code ? <span className="text-muted-2"> · {nextUp.day_code}</span> : null}
            </Link>
          </div>
        </section>
      )}

      {entry ? (
        <>
          {entry.how_to.length > 0 && (
            <Section title="How to do it">
              <ol className="list-decimal list-inside space-y-1.5 text-small text-muted-2">
                {entry.how_to.map((step, i) => <li key={i}>{step}</li>)}
              </ol>
            </Section>
          )}
          {entry.cues.length > 0 && (
            <Section title="Cues">
              <ul className="space-y-1 text-small">
                {entry.cues.map((c, i) => (
                  <li key={i} className="flex gap-2"><span className="text-accent shrink-0">✓</span><span>{c}</span></li>
                ))}
              </ul>
            </Section>
          )}
          {entry.mistakes.length > 0 && (
            <Section title="Watch out for">
              <ul className="space-y-1 text-small">
                {entry.mistakes.map((m, i) => (
                  <li key={i} className="flex gap-2"><span className="text-danger shrink-0">!</span><span>{m}</span></li>
                ))}
              </ul>
            </Section>
          )}
          {entry.safety && entry.safety.length > 0 && (
            <Section title="Safety">
              <ul className="space-y-1 text-small text-muted-2">
                {entry.safety.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </Section>
          )}
        </>
      ) : (
        <Section title="How to do it">
          <p className="text-small text-muted-2">
            No coaching notes saved yet for this exercise. Send us a screenshot of what you want here and we&apos;ll add it.
          </p>
        </Section>
      )}

      {history.length > 0 && (
        <>
          <Section title="Progression">
            <ExerciseHistoryChart data={history.map(h => ({ date: h.date, bestW: h.bestW, topVolume: h.topVolume })).reverse()} />
          </Section>

          <Section title={`History · ${history.length} session${history.length === 1 ? '' : 's'}`}>
            <ul className="space-y-3">
              {history.slice(0, 10).map((h, i) => {
                const prev = history[i + 1];
                const wDelta = prev ? h.bestW - prev.bestW : null;
                return (
                  <li key={h.date + i} className="border-l-2 border-border pl-3">
                    <div className="flex items-baseline gap-2">
                      <div className="text-small font-semibold">{format(new Date(h.date + 'T00:00:00'), 'EEE, MMM d')}</div>
                      {wDelta != null && wDelta !== 0 && (
                        <span className={`text-tiny font-semibold ${wDelta > 0 ? 'text-ok' : 'text-muted-2'}`}>
                          {wDelta > 0 ? '+' : ''}{wDelta}kg top
                        </span>
                      )}
                    </div>
                    <div className="text-tiny text-muted mt-0.5">
                      {h.sets.map((s, j) => (
                        <span key={j} className="mr-3 tabular-nums">
                          {s.w ?? '–'}×{s.r ?? '–'}{s.rir != null ? ` @RIR${s.rir}` : ''}
                        </span>
                      ))}
                    </div>
                    {h.note && <div className="text-tiny text-muted-2 mt-1 italic">&ldquo;{h.note}&rdquo;</div>}
                  </li>
                );
              })}
            </ul>
            {history.length > 10 && <div className="text-tiny text-muted mt-2">Showing most recent 10.</div>}
          </Section>
        </>
      )}

      {history.length === 0 && (
        <Section title="History">
          <p className="text-small text-muted-2">No logged sets yet. Log a session and your sets will show up here.</p>
        </Section>
      )}
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl bg-panel border border-border p-4">
      <div className="text-tiny text-muted uppercase tracking-wider mb-2">{title}</div>
      {children}
    </section>
  );
}
