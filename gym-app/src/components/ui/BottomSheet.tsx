'use client';
import { useEffect } from 'react';

export default function BottomSheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = original; };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center animate-fade-in">
      <div onClick={onClose} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative w-full max-w-xl bg-bg border-t sm:border border-border-strong rounded-t-2xl sm:rounded-2xl shadow-pop max-h-[92vh] overflow-y-auto animate-slide-up">
        <div className="sticky top-0 flex items-center justify-between px-5 py-3.5 bg-bg/95 backdrop-blur border-b border-border">
          <div className="text-small font-semibold">{title}</div>
          <button onClick={onClose} className="text-muted hover:text-white text-xl leading-none -mr-1 px-2">×</button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
