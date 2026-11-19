// The manual anchor routes answer as a small SSE stream: `anchor_live` frames
// while the call runs, one final frame with the result, then [DONE]. The tab
// reads it with lib/sseFrames.ts like every other stream in NEXUS.
//
// Here, not in a route file: a route may only export its handlers.

import { createSseReader, isSseDone } from '@/lib/sseFrames';

export function anchorSseResponse(run: (send: (frame: object) => void) => Promise<void>): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (frame: object) => {
        if (!open) return;
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`)); } catch { open = false; }
      };
      try {
        await run(send);
      } catch (e: any) {
        send({ type: 'anchor_report', error: e?.message || String(e) });
      } finally {
        send({ type: 'done' });
        if (open) { try { controller.enqueue(enc.encode('data: [DONE]\n\n')); controller.close(); } catch { /* tab gone */ } }
      }
    },
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform' },
  });
}

/**
 * Read one of those streams on the tab: every frame goes to `onFrame`; the
 * final result frame (`type` = `finalType`) is returned. Null when the stream
 * ended without one.
 */
export async function readAnchorSse(
  res: Response,
  finalType: string,
  onFrame: (d: Record<string, unknown>) => void,
): Promise<Record<string, unknown> | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const sse = createSseReader();
  let final: Record<string, unknown> | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const payload of sse.push(decoder.decode(value, { stream: true }))) {
      if (isSseDone(payload)) continue;
      let d: Record<string, unknown>;
      try { d = JSON.parse(payload); } catch { continue; }
      if (d.type === finalType) final = d;
      else onFrame(d);
    }
  }
  return final;
}
