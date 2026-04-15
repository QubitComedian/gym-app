'use client';
import { usePathname } from 'next/navigation';
import { usePendingProposalsWatcher } from './ui/Toast';

/** Mounted once at root; polls for new pending AI proposals and surfaces toasts.
 *  Disabled on /login (and could be gated to authenticated routes). */
export default function PendingProposalsWatcher() {
  const path = usePathname() || '/';
  const active = path !== '/login';
  // hook unconditionally to preserve hook order; internal fetch silently fails on 401
  usePendingProposalsWatcher({ intervalMs: active ? 20000 : 60000 });
  return null;
}
