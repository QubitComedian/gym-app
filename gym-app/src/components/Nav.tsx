'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Hand-crafted SVG tab icons — twinned active/inactive via stroke color
function IconToday({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={active ? '#d4ff3a' : '#8a8a8a'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3.5" fill={active ? '#d4ff3a' : 'none'} stroke="none" />
      <circle cx="12" cy="12" r="8.5" />
    </svg>
  );
}
function IconCalendar({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={active ? '#d4ff3a' : '#8a8a8a'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <line x1="3.5" y1="10" x2="20.5" y2="10" />
      <line x1="8" y1="3" x2="8" y2="6.5" />
      <line x1="16" y1="3" x2="16" y2="6.5" />
    </svg>
  );
}
function IconYou({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={active ? '#d4ff3a' : '#8a8a8a'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M4.5 20c1.2-3.5 4-5.5 7.5-5.5s6.3 2 7.5 5.5" />
    </svg>
  );
}

const TABS = [
  { href: '/today',    label: 'Today',    Icon: IconToday },
  { href: '/calendar', label: 'Calendar', Icon: IconCalendar },
  { href: '/you',      label: 'You',      Icon: IconYou },
];

const HIDE_ON = new Set(['/login']);

export default function Nav() {
  const path = usePathname() || '/';
  if (HIDE_ON.has(path)) return null;

  return (
    <nav className="fixed bottom-0 inset-x-0 bg-bg/85 backdrop-blur border-t border-border z-40 pb-[env(safe-area-inset-bottom)]">
      <ul className="grid grid-cols-3 max-w-xl mx-auto">
        {TABS.map(t => {
          const active = path === t.href || path.startsWith(t.href + '/');
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                className="flex flex-col items-center py-2.5 gap-0.5 select-none"
              >
                <t.Icon active={active} />
                <span className={`text-[10px] tracking-wide ${active ? 'text-accent font-semibold' : 'text-muted'}`}>
                  {t.label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
