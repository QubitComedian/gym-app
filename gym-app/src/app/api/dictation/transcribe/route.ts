/**
 * AssemblyAI dictation — server-side audio → text proxy.
 *
 * The browser records audio (via MediaRecorder), POSTs the blob here, and we:
 *   1. Upload the bytes to AssemblyAI's /upload endpoint with our server-side key
 *      (keeps the key out of the browser)
 *   2. Kick off a transcript job
 *   3. Poll until `status === 'completed'` or `'error'` (capped ~25s)
 *   4. Return { text, confidence } to the client
 *
 * We accept either a multipart body (field name: `audio`) or a raw binary body.
 *
 * Edge cases handled:
 *   - empty body → 400
 *   - missing env key → 500 with explanatory payload (so the client can toast)
 *   - upstream error (non-2xx) → surface the AAI message
 *   - poll timeout → return 504 with partial info
 *   - no speech detected → returns empty string + low confidence; client decides
 */

import { NextResponse } from 'next/server';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

const AAI = 'https://api.assemblyai.com/v2';
const POLL_INTERVAL_MS = 900;
const POLL_MAX_MS = 25_000;

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

export async function POST(req: Request) {
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: 'assemblyai_key_missing', hint: 'Set ASSEMBLYAI_API_KEY in .env.local' },
      { status: 500 }
    );
  }

  // Body → ArrayBuffer. We accept multipart (easier with FormData on the
  // client) OR raw binary (slightly cheaper). Order matters: try multipart
  // first because raw bytes in a multipart body would still have a
  // content-type header that isn't application/octet-stream.
  const ct = req.headers.get('content-type') || '';
  let bytes: ArrayBuffer;
  try {
    if (ct.startsWith('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('audio');
      if (!(file instanceof Blob)) {
        return NextResponse.json({ error: 'no_audio_field' }, { status: 400 });
      }
      bytes = await file.arrayBuffer();
    } else {
      bytes = await req.arrayBuffer();
    }
  } catch (e: any) {
    return NextResponse.json({ error: 'bad_body', detail: e.message }, { status: 400 });
  }
  if (!bytes || bytes.byteLength < 200) {
    // Less than ~200 bytes is basically silence or a click. Short-circuit.
    return NextResponse.json({ text: '', confidence: 0, reason: 'too_short' });
  }

  // Step 1 — upload bytes to AssemblyAI.
  let uploadUrl: string;
  try {
    const res = await fetch(`${AAI}/upload`, {
      method: 'POST',
      headers: { authorization: key, 'content-type': 'application/octet-stream' },
      body: Buffer.from(bytes) as any,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return NextResponse.json({ error: 'upload_failed', detail }, { status: 502 });
    }
    const j = await res.json();
    uploadUrl = j.upload_url;
  } catch (e: any) {
    return NextResponse.json({ error: 'upload_threw', detail: e.message }, { status: 502 });
  }

  // Step 2 — kick off transcript. We use the fastest config that still
  // gives reasonable English punctuation + formatting.
  let id: string;
  try {
    const res = await fetch(`${AAI}/transcript`, {
      method: 'POST',
      headers: { authorization: key, 'content-type': 'application/json' },
      body: JSON.stringify({
        audio_url: uploadUrl,
        speech_model: 'universal',
        punctuate: true,
        format_text: true,
        language_detection: true,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return NextResponse.json({ error: 'transcript_create_failed', detail }, { status: 502 });
    }
    const j = await res.json();
    id = j.id;
  } catch (e: any) {
    return NextResponse.json({ error: 'transcript_threw', detail: e.message }, { status: 502 });
  }

  // Step 3 — poll until finished. AssemblyAI exposes a /transcript/:id GET.
  const started = Date.now();
  while (Date.now() - started < POLL_MAX_MS) {
    await sleep(POLL_INTERVAL_MS);
    const res = await fetch(`${AAI}/transcript/${id}`, {
      headers: { authorization: key },
    });
    if (!res.ok) continue; // transient — keep polling until the budget is gone
    const j = await res.json();
    if (j.status === 'completed') {
      return NextResponse.json({
        text: j.text ?? '',
        confidence: typeof j.confidence === 'number' ? j.confidence : null,
        language: j.language_code ?? null,
      });
    }
    if (j.status === 'error') {
      return NextResponse.json(
        { error: 'transcript_error', detail: j.error ?? 'unknown' },
        { status: 502 }
      );
    }
    // queued | processing → keep waiting
  }

  // Budget exhausted. The transcript will still complete on AAI's side; we
  // just can't block the client any longer. Surface a 504 so the UI can
  // offer to retry or fall back to typing.
  return NextResponse.json(
    { error: 'poll_timeout', transcript_id: id },
    { status: 504 }
  );
}
