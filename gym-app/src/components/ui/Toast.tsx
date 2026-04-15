'use client';
import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';

type ToastKind = 'info' | 'success' | 'suggestion';
type Toast = {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  ttl?: number;
};

type Ctx = {
  push: (t: Omit<Toast, 'id'>) => number;
  dismiss: (id: number) => void;
};

const ToastCtx = createContext<Ctx | null>(null);

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast outside ToastProvider');
  return ctx;
}

const kindCls: Record<ToastKind, string> = {
  info:       'border-border bg-panel',
  success:    'border-ok/40 bg-ok/10',
  suggestion: 'border-accent/40 bg-accent-soft',
};

export default function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems(prev => prev.filter(t => t.id !== id));
  }, []);

  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = ++idRef.current;
    setItems(prev => [...prev, { id, ...t }]);
    if (t.ttl !== 0) {
      setTimeout(() => dismiss(id), t.ttl ?? 6000);
    }
    return id;
  }, [dismiss]);

  return (
    <ToastCtx.Provider value={{ push, dismiss }}>
      {children}
      <div className="fixed left-0 right-0 top-0 z-50 flex flex-col items-center gap-2 pt-3 px-3 pointer-events-none">
        {items.map(t => (
          <div
            key={t.id}
            className={`pointer-events-auto w-full max-w-sm rounded-xl border shadow-pop px-4 py-3 animate-toast-in ${kindCls[t.kind]}`}
          >
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-small font-semibold">{t.title}</div>
                {t.description && <div className="text-tiny text-muted-2 mt-0.5">{t.description}</div>}
              </div>
              {t.actionLabel && t.onAction && (
                <button
                  onClick={() => { t.onAction!(); dismiss(t.id); }}
                  className="text-tiny font-semibold text-accent whitespace-nowrap"
                >
                  {t.actionLabel}
                </button>
              )}
              <button onClick={() => dismiss(t.id)} className="text-muted hover:text-white text-lg leading-none -mt-0.5">×</button>
            </div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Hook: watch for new pending AI proposals and surface a toast with a View link. */
export function usePendingProposalsWatcher(opts?: { intervalMs?: number }) {
  const { push } = useToast();
  const seen = useRef<Set<string>>(new Set());
  useEffect(() => {
    const interval = opts?.intervalMs ?? 15000;
    let alive = true;
    async function poll() {
      try {
        const res = await fetch('/api/proposals/pending', { cache: 'no-store' });
        if (!res.ok) return;
        const { proposals } = await res.json();
        for (const p of proposals ?? []) {
          if (seen.current.has(p.id)) continue;
          seen.current.add(p.id);
          push({
            kind: 'suggestion',
            title: 'Claude has a suggestion',
            description: p.headline ?? p.rationale?.split('\n')[0]?.slice(0, 140) ?? 'Review the proposed changes.',
            actionLabel: 'View →',
            onAction: () => { window.location.href = `/ai/${p.id}`; },
            ttl: 0,
          });
        }
      } catch { /* silent */ }
    }
    poll();
    const t = setInterval(() => { if (alive) poll(); }, interval);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
