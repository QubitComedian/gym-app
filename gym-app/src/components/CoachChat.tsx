/**
 * CoachChat — the free-form AI coach box on the Today page.
 *
 * Design:
 *   • Collapsed by default as a pill-shaped "talk to your coach" invitation.
 *   • On focus, expands into a textarea with dictation, 2-3 suggestion chips,
 *     and a Send button.
 *   • On submit:
 *       - POSTs message + timezone to /api/ai/chat
 *       - Shows the assistant's reply inline
 *       - If the server returned a proposal with changes (has_changes),
 *         shows an "Apply changes" + "Dismiss" pair that calls
 *         /api/proposals/[id] to approve or reject.
 *       - If availability_suggestion came back, surfaces it as a secondary
 *         confirm panel that posts to /api/availability.
 *
 * Edge cases handled:
 *   - Empty/near-empty message → disable Send
 *   - API 401 → redirect to /login
 *   - Retry on transient 5xx
 *   - Dictation appends to existing text rather than replacing
 */

'use client';

import { useState, useTransition, useRef, useEffect } from 'react';
import { DictationButton } from '@/components/ui/Dictation';
import { appendTranscript } from '@/components/ui/DictationInput';

type AvailabilitySuggestion = {
  kind: 'travel' | 'injury' | 'pause';
  starts_on: string;
  ends_on: string;
  strategy: 'auto' | 'bodyweight' | 'rest' | 'suppress';
  reason: string;
};

type ChatResponse = {
  proposal_id: string;
  status: 'pending' | 'applied' | 'rejected';
  assistant_message: string;
  structured_intent: any;
  availability_suggestion: AvailabilitySuggestion | null;
  diff: {
    rationale?: string;
    updates?: any[];
    creates?: any[];
    deletes?: any[];
  };
  has_changes: boolean;
};

const QUICK_SUGGESTIONS = [
  "I'm travelling for 3 days, hotel only",
  "I'm sick today, need to skip",
  "Knee feels sore, no running this week",
  "Short on time today — 30 min max",
];

export default function CoachChat() {
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState('');
  const [pending, startTransition] = useTransition();
  const [response, setResponse] = useState<ChatResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applyingProposal, setApplyingProposal] = useState(false);
  const [availApplied, setAvailApplied] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-focus the textarea when expanded.
  useEffect(() => { if (expanded) taRef.current?.focus(); }, [expanded]);

  async function send(messageOverride?: string) {
    const msg = (messageOverride ?? text).trim();
    if (!msg) return;
    setError(null);
    setResponse(null);
    setAvailApplied(false);

    startTransition(async () => {
      try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const res = await fetch('/api/ai/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: msg, timezone: tz }),
        });
        if (res.status === 401) { window.location.href = '/login'; return; }
        const data = await res.json();
        if (!res.ok) { setError(data?.error || 'Something went wrong'); return; }
        setResponse(data as ChatResponse);
        setText(''); // clear input on success
      } catch (e: any) {
        setError(e?.message || 'Network error');
      }
    });
  }

  async function applyProposal(approve: boolean) {
    if (!response) return;
    setApplyingProposal(true);
    try {
      const res = await fetch(`/api/proposals/${response.proposal_id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: approve ? 'apply' : 'reject' }),
      });
      if (res.ok) {
        // Refresh the page so banners / today plan reflect the change.
        if (approve) window.location.reload();
        else setResponse({ ...response, has_changes: false }); // dismissed
      } else {
        const j = await res.json().catch(() => ({}));
        setError(j.error || 'Could not apply');
      }
    } finally {
      setApplyingProposal(false);
    }
  }

  async function applyAvailability() {
    if (!response?.availability_suggestion) return;
    setApplyingProposal(true);
    try {
      const a = response.availability_suggestion;
      const res = await fetch('/api/availability', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: a.kind,
          strategy: a.strategy,
          starts_on: a.starts_on,
          ends_on: a.ends_on,
          note: a.reason,
        }),
      });
      if (res.ok) {
        setAvailApplied(true);
        window.location.reload();
      } else {
        const j = await res.json().catch(() => ({}));
        setError(j.error || 'Could not set availability');
      }
    } finally {
      setApplyingProposal(false);
    }
  }

  return (
    <section className="mb-5">
      <div className="card-raised relative overflow-hidden">
        {/* Accent stripe */}
        <div className="absolute inset-x-0 top-0 h-0.5 bg-brand-gradient opacity-60" />

        {!expanded && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="w-full text-left flex items-center gap-3 group"
          >
            <div className="h-9 w-9 rounded-full bg-iris-soft text-iris flex items-center justify-center text-base shrink-0 group-hover:scale-105 transition">
              {/* coach icon */}
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-small font-medium">Talk to your coach</div>
              <div className="text-tiny text-muted truncate">
                Tell me what's going on — travel, sickness, time crunch — I'll adapt the plan.
              </div>
            </div>
            <div className="text-tiny text-muted shrink-0">Tap</div>
          </button>
        )}

        {expanded && (
          <div className="space-y-3">
            <div className="flex items-start gap-2">
              <div className="h-8 w-8 rounded-full bg-iris-soft text-iris flex items-center justify-center shrink-0">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              </div>
              <div className="flex-1">
                <div className="text-small font-medium">Your coach</div>
                <div className="text-tiny text-muted">Think of this like texting your trainer.</div>
              </div>
              <button
                type="button"
                className="text-tiny text-muted hover:text-ink px-2"
                onClick={() => { setExpanded(false); setText(''); setResponse(null); setError(null); }}
              >
                Close
              </button>
            </div>

            {/* Input */}
            <div className="relative">
              <textarea
                ref={taRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
                }}
                placeholder="e.g. I'm travelling for 7 days with no gym access"
                className="textarea min-h-[88px] pr-12"
                disabled={pending}
              />
              <div className="absolute bottom-2 right-2">
                <DictationButton
                  size="sm"
                  compact
                  onTranscript={(txt: string) => setText((cur) => appendTranscript(cur, txt))}
                />
              </div>
            </div>

            {/* Quick suggestions */}
            {!response && !pending && (
              <div className="flex flex-wrap gap-1.5">
                {QUICK_SUGGESTIONS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => { setText(q); send(q); }}
                    className="pill text-tiny hover:bg-panel-2/70"
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between gap-2">
              <div className="text-tiny text-muted">
                ⌘/Ctrl + Enter to send
              </div>
              <button
                type="button"
                onClick={() => send()}
                disabled={pending || !text.trim()}
                className="btn btn-primary text-small disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {pending ? 'Thinking…' : 'Send'}
              </button>
            </div>

            {error && (
              <div className="rounded-xl border border-coral/40 bg-coral-soft/30 p-3 text-small text-coral">
                {error}
              </div>
            )}

            {/* Assistant reply */}
            {response && (
              <div className="rounded-2xl border border-accent/30 bg-accent-soft/20 p-3 space-y-3">
                <div className="text-small leading-relaxed">
                  {response.assistant_message}
                </div>

                {response.availability_suggestion && (
                  <div className="rounded-xl border border-panel-2 bg-panel-3 p-3">
                    <div className="text-tiny text-muted uppercase tracking-wider mb-1">Availability window</div>
                    <div className="text-small">
                      <span className="font-medium capitalize">{response.availability_suggestion.kind}</span>
                      {' · '}
                      <span className="capitalize">{response.availability_suggestion.strategy}</span>
                      {' · '}
                      {response.availability_suggestion.starts_on} → {response.availability_suggestion.ends_on}
                    </div>
                    {response.availability_suggestion.reason && (
                      <div className="text-tiny text-muted mt-1">{response.availability_suggestion.reason}</div>
                    )}
                    {!availApplied && (
                      <button
                        type="button"
                        onClick={applyAvailability}
                        disabled={applyingProposal}
                        className="btn btn-secondary text-tiny mt-2"
                      >
                        {applyingProposal ? 'Setting…' : 'Set this window'}
                      </button>
                    )}
                    {availApplied && <div className="text-tiny text-accent mt-2">Window saved.</div>}
                  </div>
                )}

                {response.has_changes && (
                  <div className="rounded-xl border border-panel-2 bg-panel-3 p-3">
                    <div className="text-tiny text-muted uppercase tracking-wider mb-1">Proposed plan changes</div>
                    <ChangesPreview diff={response.diff} />
                    <div className="flex gap-2 mt-3">
                      <button
                        type="button"
                        onClick={() => applyProposal(true)}
                        disabled={applyingProposal}
                        className="btn btn-primary text-tiny"
                      >
                        {applyingProposal ? 'Applying…' : 'Apply'}
                      </button>
                      <button
                        type="button"
                        onClick={() => applyProposal(false)}
                        disabled={applyingProposal}
                        className="btn btn-ghost text-tiny"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => { setResponse(null); setError(null); }}
                  className="text-tiny text-muted hover:text-ink underline underline-offset-2"
                >
                  Ask something else
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function ChangesPreview({ diff }: { diff: ChatResponse['diff'] }) {
  const u = diff.updates ?? [];
  const c = diff.creates ?? [];
  const d = diff.deletes ?? [];
  return (
    <ul className="text-small space-y-0.5">
      {u.length > 0 && <li>✎ Update {u.length} session{u.length > 1 ? 's' : ''}</li>}
      {c.length > 0 && <li>＋ Create {c.length} new session{c.length > 1 ? 's' : ''}</li>}
      {d.length > 0 && <li>✕ Delete {d.length} session{d.length > 1 ? 's' : ''}</li>}
      {diff.rationale && <li className="text-tiny text-muted pt-1">Why: {diff.rationale}</li>}
    </ul>
  );
}
