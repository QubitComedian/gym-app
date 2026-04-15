import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function HistoryItemRedirect({ params }: { params: { id: string } }) {
  const sb = supabaseServer();
  const { data: act } = await sb.from('activities').select('date').eq('id', params.id).maybeSingle();
  if (act?.date) redirect(`/calendar/${act.date}`);
  redirect('/calendar');
}
