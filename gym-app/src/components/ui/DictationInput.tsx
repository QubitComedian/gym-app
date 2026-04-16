'use client';

/**
 * DictationInput / DictationTextarea — a text input that has a built-in
 * microphone button. Dictated text is APPENDED to any existing value
 * (with a single leading space) so the user can mix typing + dictation.
 */

import { forwardRef, useCallback } from 'react';
import DictationButton from './Dictation';

type BaseProps = {
  value: string;
  onChange: (v: string) => void;
  dictationEnabled?: boolean;
  className?: string;
};

type InputProps = BaseProps & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'className'>;
type TextareaProps = BaseProps & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'className'>;

export function appendTranscript(prev: string, incoming: string): string {
  const t = (incoming ?? '').trim();
  if (!t) return prev;
  if (!prev) return t;
  const needsSpace = !/\s$/.test(prev);
  return prev + (needsSpace ? ' ' : '') + t;
}

export const DictationInput = forwardRef<HTMLInputElement, InputProps>(function DictationInput(
  { value, onChange, dictationEnabled = true, className = '', ...rest }, ref
) {
  const handle = useCallback((t: string) => onChange(appendTranscript(value, t)), [value, onChange]);
  return (
    <div className="relative">
      <input
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`input pr-12 ${className}`}
        {...rest}
      />
      {dictationEnabled && (
        <div className="absolute right-1.5 top-1/2 -translate-y-1/2">
          <DictationButton onTranscript={handle} size="sm" compact />
        </div>
      )}
    </div>
  );
});

export const DictationTextarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function DictationTextarea(
  { value, onChange, dictationEnabled = true, className = '', ...rest }, ref
) {
  const handle = useCallback((t: string) => onChange(appendTranscript(value, t)), [value, onChange]);
  return (
    <div className="relative">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`textarea pr-14 ${className}`}
        {...rest}
      />
      {dictationEnabled && (
        <div className="absolute right-2 bottom-2">
          <DictationButton onTranscript={handle} size="sm" compact />
        </div>
      )}
    </div>
  );
});
