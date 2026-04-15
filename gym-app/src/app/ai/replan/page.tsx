import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import ReplanClient from './ReplanClient';

export const dynamic = 'force-dynamic';

export default async function ReplanPage() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect('/login');
  return <ReplanClient />;
}
