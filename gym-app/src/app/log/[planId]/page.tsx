import { redirect, notFound } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import LogClient from './LogClient';

export const dynamic = 'force-dynamic';

export default async function LogPlan({ params }: { params: { planId: string } }) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect('/login');

  const { data: plan } = await sb.from('plans').select('*').eq('user_id', user.id).eq('id', params.planId).maybeSingle();
  if (!plan) notFound();

  return <LogClient plan={plan} />;
}
