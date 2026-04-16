'use client';

/**
 * Dictation — a small, self-contained microphone button.
 *
 * Wrap any text-ish input (<input>, <textarea>, contenteditable) by
 * placing <DictationButton onTranscript={...} /> near it. When pressed,
 * we:
 *   1. Ask the browser for mic permission
 *   2. MediaRecorder captures a webm/opus blob (broadly supported in
 *      modern Chrome/Safari/Firefox)
 *   3. On stop, we POST the blob to /api/dictation/transcribe
 *   4. Fire onTranscript(finalText) — the caller appends to their input
 *
 * UX rules we're following:
 *   - Button is a single toggle: tap to start, tap to stop. Holding isn't
 *     required because it feels bad on mobile and fails on desktop.
 *   - Visible timer so the user knows it's recording.
 *   - Clear error toast if the mic is blocked, unsupported, or the
 *     transcript service fails.
 *   - If onTranscript is async, we surface "processing…" until it settles.
 *   - We fall back gracefully if MediaRecorder isn't available (very
 *     rare in 2026): button is hidden rather than broken.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from './Toast';

type Props = {
  onTranscript: (text: string) => void | Promise<void>;
  /** Visual size — defaults to "md" (36px). Use "sm" (28px) inline. */
  size?: 'sm' | 'md' | 'lg';
  /** If true, button renders with just the mic glyph (no "Dictate" label). */
  compact?: boolean;
  /** Override label on the idle state. */
  label?: string;
  /** Disable while parent is busy. */
  disabled?: boolean;
  /** Optional className for positioning. */
  className?: string;
};

type State = 'idle' | 'listening' | 'processing';

function supportsDictation(): boolean {
  if (typeof window === 'undefined') return false;
  if (!navigator?.mediaDevices?.getUserMedia) return false;
  if (typeof MediaRecorder === 'undefined') return false;
  return true;
}

function chooseMime(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4', // Safari
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported?.(c)) return c;
  }
  return '';
}

function DictationButton({
  onTranscript,
  size = 'md',
  compact = false,
  label = 'Dictate',
  disabled = false,
  className = '',
}: Props) {
  const [state, setState] = useState<State>('idle');
  const [elapsed, setElapsed] = useState(0);
  const { push } = useToast();

  const mediaRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const supportedRef = useRef<boolean | null>(null);

  // Check support once on mount. Hidden buttons are nicer than broken ones.
  useEffect(() => {
    supportedRef.current = supportsDictation();
  }, []);

  // Cleanup on unmount — don't leave mic tracks live if the user navigates.
  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      if (mediaRef.current && mediaRef.current.state !== 'inactive') {
        try { mediaRef.current.stop(); } catch {}
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, []);

  const start = useCallback(async () => {
    if (disabled || state !== 'idle') return;
    if (!supportedRef.current) {
      push({
        kind: 'info',
        title: 'Dictation unsupported',
        description: 'Your browser can\'t access the microphone.',
      });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = chooseMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      rec.onstop = async () => {
        setState('processing');
        const blob = new Blob(chunksRef.current, { type: mime || 'audio/webm' });
        try {
          const form = new FormData();
          form.append('audio', blob, 'speech.webm');
          const res = await fetch('/api/dictation/transcribe', {
            method: 'POST',
            body: form,
          });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) {
            push({
              kind: 'info',
              title: 'Dictation failed',
              description: j.error === 'assemblyai_key_missing'
                ? 'AssemblyAI key not configured.'
                : j.error === 'poll_timeout'
                ? 'Transcription took too long.'
                : 'Please try again.',
            });
          } else if (!j.text || !String(j.text).trim()) {
            push({
              kind: 'info',
              title: 'Nothing heard',
              description: 'Try speaking a bit louder next time.',
            });
          } else {
            await onTranscript(String(j.text).trim());
          }
        } catch (e: any) {
          push({ kind: 'info', title: 'Dictation error', description: e.message });
        } finally {
          if (streamRef.current) {
            streamRef.current.getTracks().forEach((t) => t.stop());
            streamRef.current = null;
          }
          setState('idle');
          setElapsed(0);
        }
      };
      rec.start();
      mediaRef.current = rec;
      setState('listening');
      setElapsed(0);
      timerRef.current = window.setInterval(() => {
        setElapsed((s) => s + 1);
      }, 1000);
    } catch (e: any) {
      const msg = e?.name === 'NotAllowedError'
        ? 'Microphone permission denied.'
        : e?.name === 'NotFoundError'
        ? 'No microphone found.'
        : e?.message || 'Could not start recording.';
      push({ kind: 'info', title: 'Dictation blocked', description: msg });
      setState('idle');
    }
  }, [disabled, state, onTranscript, push]);

  const stop = useCallback(() => {
    if (state !== 'listening') return;
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    try {
      mediaRef.current?.stop();
    } catch {}
  }, [state]);

  // Don't render anything if unsupported — keeps layouts clean.
  if (supportedRef.current === false) return null;

  const dim = size === 'sm' ? 28 : size === 'lg' ? 44 : 36;
  const iconSize = size === 'sm' ? 14 : size === 'lg' ? 22 : 18;

  if (state === 'listening') {
    const mm = String(Math.floor(elapsed / 60)).padStart(1, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    return (
      <button
        type="button"
        onClick={stop}
        aria-label="Stop dictation"
        style={{ height: dim }}
        className={`inline-flex items-center gap-2 rounded-full bg-danger/15 border border-danger/45 pl-2 pr-3 text-danger animate-mic ${className}`}
      >
        <span className="relative inline-flex h-3 w-3 rounded-full bg-danger shadow-[0_0_10px_2px_rgba(255,107,107,0.7)]" />
        <span className="text-tiny font-semibold tabular-nums">{mm}:{ss}</span>
        <span className="text-tiny">Tap to stop</span>
      </button>
    );
  }

  if (state === 'processing') {
    return (
      <button
        type="button"
        disabled
        aria-label="Processing dictation"
        style={{ height: dim }}
        className={`inline-flex items-center gap-2 rounded-full bg-iris-soft border border-iris/40 px-3 text-iris ${className}`}
      >
        <span className="h-2 w-2 rounded-full bg-iris animate-pulse" />
        <span className="text-tiny font-semibold">Transcribing…</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={start}
      disabled={disabled}
      aria-label="Start dictation"
      title="Dictate — tap to record"
      style={{ height: dim, width: compact ? dim : undefined }}
      className={`inline-flex items-center justify-center gap-2 rounded-full border border-border bg-panel-2 text-muted-2 hover:text-ink hover:border-border-strong transition-colors ${compact ? '' : 'px-3'} disabled:opacity-40 ${className}`}
    >
      <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="3" width="6" height="12" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0" />
        <line x1="12" y1="18" x2="12" y2="22" />
        <line x1="8" y1="22" x2="16" y2="22" />
      </svg>
      {!compact && <span className="text-tiny font-semibold">{label}</span>}
    </button>
  );
}

export { DictationButton };
export default DictationButton;
