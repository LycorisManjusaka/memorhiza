import { NextResponse } from 'next/server';
import { loadTtsDictPairs } from '@/lib/ttsDictionary';
import { describeFetchFailure } from '@/lib/coeiroinkSpeakers';
import { synthesizeSegment, type SynthMeta } from '@/lib/ttsSynth';

function concatenateWavs(buffers: ArrayBuffer[]): Buffer {
    if (buffers.length === 0) return Buffer.alloc(0);
    if (buffers.length === 1) return Buffer.from(buffers[0]);
    
    const headerSize = 44;
    let totalDataSize = 0;
    
    for (const buf of buffers) {
        totalDataSize += (buf.byteLength - headerSize);
    }
    
    const finalBuffer = Buffer.alloc(headerSize + totalDataSize);
    
    const firstBuf = Buffer.from(buffers[0]);
    firstBuf.copy(finalBuffer, 0, 0, headerSize);
    
    finalBuffer.writeUInt32LE(finalBuffer.length - 8, 4);
    finalBuffer.writeUInt32LE(totalDataSize, 40);
    
    let offset = headerSize;
    for (const buf of buffers) {
        const nodeBuf = Buffer.from(buf);
        const dataSize = nodeBuf.length - headerSize;
        nodeBuf.copy(finalBuffer, offset, headerSize, nodeBuf.length);
        offset += dataSize;
    }
    
    return finalBuffer;
}

// Headers must be latin-1; engine errors carry Japanese and box characters.
function headerSafe(s: string): string {
  return encodeURIComponent(String(s || '').slice(0, 500));
}

export async function POST(req: Request) {
  const started = Date.now();
  const meta: SynthMeta = { engine: -1, engineState: 'unknown', chars: 0, skipped: false };
  try {
    const data = await req.json();
    let buffers: ArrayBuffer[] = [];

    // Load the per-entity pronunciation dictionary once per request (cached by
    // mtime in the lib). `folderName` is sent by the TTS callers.
    const dictPairs = loadTtsDictPairs(data.folderName || '');

    if (data.segments && Array.isArray(data.segments)) {
      for (const seg of data.segments) {
        const buf = await synthesizeSegment(seg.text, seg.engine, seg.char_idx, seg.style_idx, seg.speed || 1.0, seg.pitch ?? 0.0, dictPairs, meta, seg.char_name, seg.style_name);
        if (buf) buffers.push(buf);
      }
    } else {
       const buf = await synthesizeSegment(data.text, data.engine, data.char_idx, data.style_idx, data.speed || 1.0, data.pitch ?? 0.0, dictPairs, meta, data.char_name, data.style_name);
       if (buf) buffers.push(buf);
    }

    const finalWav = concatenateWavs(buffers);

    // Diagnostics ride along with the audio. The browser reads them to drive the
    // live TTS indicator; nothing here changes the audio itself.
    // BodyInit only admits views over a non-shared ArrayBuffer, while Node types
    // a Buffer as generic over its backing store (Buffer<ArrayBufferLike>) --
    // so a Buffer that is in fact non-shared still fails the check. These bytes
    // come from Node's own allocator via concatenateWavs, never from a
    // SharedArrayBuffer, so the cast states what the allocator already
    // guarantees. Chosen over `new Uint8Array(finalWav)`, which would copy the
    // whole WAV to satisfy the type alone.
    return new NextResponse(finalWav as unknown as BodyInit, {
      headers: {
        'Content-Type': 'audio/wav',
        'X-Tts-Engine': String(meta.engine),
        'X-Tts-Engine-State': meta.engineState,
        'X-Tts-Chars': String(meta.chars),
        'X-Tts-Skipped': meta.skipped ? '1' : '0',
        'X-Tts-Ms': String(Date.now() - started),
        ...(meta.engineError ? { 'X-Tts-Engine-Error': headerSafe(meta.engineError) } : {}),
      },
    });

  } catch (e: any) {
    console.error('TTS Error:', e);
    // The failure reason travels in the body AND in a header, because the
    // streaming client used to discard the body entirely — which is exactly why
    // an unstable AivisSpeech could not be diagnosed from the UI.
    return NextResponse.json(
      { error: describeFetchFailure(e), engine: meta.engine, engineState: meta.engineState, chars: meta.chars },
      {
        status: 500,
        headers: {
          'X-Tts-Engine': String(meta.engine),
          'X-Tts-Engine-State': meta.engineState,
          'X-Tts-Chars': String(meta.chars),
          'X-Tts-Ms': String(Date.now() - started),
          'X-Tts-Error': headerSafe(describeFetchFailure(e) || 'synthesis failed'),
        },
      },
    );
  }
}
