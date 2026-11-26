import { NextResponse } from 'next/server';
import { loadUserSettings } from '@/lib/fsStorage';
import { serverSpeech, speechModeFromSettings, type SpeechSnapshot } from '@/lib/serverSpeech';
import { splitTtsSentences, type TtsSegment } from '@/lib/ttsSentences';

export const dynamic = 'force-dynamic';

/** Re-read the house setting; the queue keeps the last value it was told. */
async function syncMode(): Promise<void> {
  try { serverSpeech().setMode(speechModeFromSettings(await loadUserSettings())); } catch { /* keep the last known mode */ }
}

/**
 * GET            -> one JSON snapshot ({ mode, current, queued }).
 * GET ?stream=1  -> the same as an SSE stream, one frame per change.
 *
 * A tab opens the stream only while the mode is 'server' and the tab is
 * visible: browsers allow ~6 connections per host ACROSS tabs, so a permanent
 * stream in every open tab would starve the rest of the app.
 */
export async function GET(req: Request) {
  await syncMode();
  const q = serverSpeech();
  if (new URL(req.url).searchParams.get('stream') !== '1') {
    return NextResponse.json(q.snapshot());
  }
  const enc = new TextEncoder();
  let off: (() => void) | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;
  const release = () => {
    off?.(); off = null;
    if (beat) { clearInterval(beat); beat = null; }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        release();
        try { controller.close(); } catch { /* already closed */ }
      };
      const send = (s: SpeechSnapshot) => {
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(s)}\n\n`)); } catch { close(); }
      };
      send(q.snapshot());
      off = q.subscribe(send);
      beat = setInterval(() => {
        try { controller.enqueue(enc.encode(': keep-alive\n\n')); } catch { close(); }
      }, 20000);
      req.signal.addEventListener('abort', close);
    },
    cancel() { release(); },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

/**
 * POST { action: 'speak' | 'stop' | 'pause' | 'resume' | 'sync', ... }
 *
 * `speak` takes phrases the TAB already resolved (voices for `[name]` tags and
 * the user voice live in the browser), and answers at once — the tab learns
 * progress from the stream, not from this response.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    await syncMode();
    const q = serverSpeech();
    const action = String(body.action || '');
    if (action === 'sync') return NextResponse.json(q.snapshot());
    if (action === 'pause') { q.pause(); return NextResponse.json(q.snapshot()); }
    if (action === 'resume') { q.resume(); return NextResponse.json(q.snapshot()); }
    if (action === 'stop') {
      q.stop({
        messageId: typeof body.messageId === 'string' ? body.messageId : undefined,
        convoId: typeof body.convoId === 'string' ? body.convoId : undefined,
      });
      return NextResponse.json(q.snapshot());
    }
    if (action === 'speak') {
      if (q.getMode() !== 'server') {
        return NextResponse.json({ error: 'read-aloud is set to "tab" on this Memorhiza' }, { status: 409 });
      }
      const messageId = String(body.messageId || '');
      const raw = Array.isArray(body.sentences) ? (body.sentences as TtsSegment[]) : [];
      const sentences = splitTtsSentences(raw.filter((s) => s && typeof s.text === 'string'));
      if (!messageId || sentences.length === 0) {
        return NextResponse.json({ error: 'nothing to read' }, { status: 400 });
      }
      void q.speak({
        messageId,
        convoId: typeof body.convoId === 'string' ? body.convoId : undefined,
        folderName: typeof body.folderName === 'string' ? body.folderName : '',
        isUser: body.isUser === true,
        sentences,
      });
      return NextResponse.json(q.snapshot());
    }
    return NextResponse.json({ error: `unknown action "${action}"` }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
