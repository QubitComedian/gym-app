'use client';
import { supabaseBrowser } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';

export default function SignOutButton() {
  const router = useRouter();
  return (
    <button
      onClick={async () => { await supabaseBrowser().auth.signOut(); router.push('/login'); }}
      className="text-xs text-muted underline"
    >
      Sign out
    </button>
  );
}
