import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import AddClient from './AddClient';

export const dynamic = 'force-dynamic';

export default async function Add({ searchParams }: { searchParams: { date?: string } }) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect('/login');
  const date = searchParams.date || new Date().toISOString().slice(0, 10);
  return <AddClient defaultDate={date} />;
}
