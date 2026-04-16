'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import BottomSheet from './ui/BottomSheet';
import { useToast } from './ui/Toast';
import { DictationButton } from './ui/Dictation';
import { appendTranscript } from './ui/DictationInput';

type Props =
  | { mode: 'adjust'; planId: string; date: string; label: string }
  | { mode: 'propose'; date: string; label: string; planId?: undefined };

const REASONS_ADJUST = [
  { id: 'too_easy',  label: 'Too easy — push harder' },
  { id: 'too_hard',  label: 'Too hard — dial back' },
  { id: 'short_time', label: "Short on time — shorten it" },
  { id: 'swap_ex',   label: 'Swap an exercise I dislike' },
  { id: 'other',     label: 'Something else' },
] as const;

const REASONS_PROPOSE = [
  { id: 'gym',    label: 'Gym day' },
  { id: 'run',    label: 'Run' },
  { id: 'bike',   label: 'Bike' },
  { id: 'yoga',   label: 'Yoga / mobility' },
  { id: 'rest',   label: 'Rest day' },
  { id: 'surprise', label: 'Surprise me' },
] as const;

export default function AdjustSheet(props: Props) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const { push } = useToast();

  const reasons = props.mode === 'adjust' ? REASONS_ADJUST : REASONS_PROPOSE;

  async function submit() {
    if (!reason) return;
    setBusy(true);
    try {
      const res = await fetch('/api/ai/adjust', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: props.mode,
          plan_id: props.mode === 'adjust' ? props.planId : undefined,
          date: props.date,
          reason,
          note: note || undefined,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'failed');
      setOpen(false);
      if (j.no_changes) {
        push({ kind: 'success', title: 'Claude took a look', description: 'No adjustments suggested.' });
      } else {
        push({
          kind: 'suggestion',
          title: 'Claude has a suggestion',
          description: 'Review the proposed changes.',
          actionLabel: 'View →',
          onAction: () => router.push(`/ai/${j.proposal_id}`),
          ttl: 0,
        });
      }
    } catch (e: any) {
      push({ kind: 'info', title: 'AI request failed', description: e.message });
    } finally { setBusy(false); }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg bg-panel-2 border border-border px-4 py-2.5 text-small"
      >
        {props.label}
      </button>
      <BottomSheet
        open={open}
        onClose={() => setOpen(false)}
        title={props.mode === 'adjust' ? 'Ask AI to adjust' : 'Propose a session'}
      >
        <p className="text-tiny text-muted mb-4">
          {props.mode === 'adjust'
            ? `Tell Claude how you'd like to change ${props.date}. It will respect your phase and preferences.`
            : `Claude will propose a ${props.date} session aligned with your phase and plan.`}
        </p>
        <div className="space-y-1.5 mb-4">
          {reasons.map(r => (
            <button
              key={r.id}
              onClick={() => setReason(r.id)}
              className={`w-full text-left px-3.5 py-3 rounded-lg text-small border transition-colors ${reason === r.id ? 'bg-accent-soft border-accent/50 text-white' : 'bg-panel-2 border-border text-muted-2'}`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <label className="block mb-4">
          <span className="text-tiny text-muted">Optional note</span>
          <div className="relative mt-1">
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder={props.mode === 'adjust' ? 'e.g. left shoulder feeling tight today' : 'e.g. 45 min window'}
              className="w-full bg-panel-2 border border-border rounded-lg px-3 py-2.5 text-small min-h-[64px] pr-10"
            />
            <div className="absolute bottom-2 right-2">
              <DictationButton
                size="sm"
                compact
                onTranscript={(t: string) => setNote((prev) => appendTranscript(prev, t))}
              />
            </div>
          </div>
        </label>
        <button
          disabled={!reason || busy}
          onClick={submit}
          className="w-full rounded-lg bg-accent text-black font-semibold py-3 disabled:opacity-50"
        >
          {busy ? 'Asking Claude…' : 'Submit to Claude'}
        </button>
      </BottomSheet>
    </>
  );
}
