'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/today',     label: 'Today',     icon: '●' },
  { href: '/week',      label: 'Week',      icon: '▤' },
  { href: '/history',   label: 'History',   icon: '◷' },
  { href: '/exercises', label: 'Exercises', icon: '⚙' },
];

export default function Nav() {
  const path = usePathname();
  if (path === '/login') return null;
  return (
    <nav className="fixed bottom-0 inset-x-0 bg-bg/90 backdrop-blur border-t border-border z-40 pb-safe">
      <ul className="grid grid-cols-4 max-w-xl mx-auto">
        {TABS.map(t => {
          const active = path === t.href || path.startsWith(t.href + '/');
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                className={`flex flex-col items-center py-3 text-[11px] tracking-wide ${active ? 'text-accent' : 'text-muted'}`}
              >
                <span className="text-lg leading-none mb-0.5">{t.icon}</span>
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
