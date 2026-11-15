import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

// Watches the VRChat screenshot folder and signals a new image over SSE. The
// message TEXT is supplied by the input box (kept live by the logs poll); this
// route only carries the image bytes.
//
// Two detection mechanisms run together, deduped by absolute path:
//   1. fs.watch  — low-latency, but on Windows it SILENTLY DROPS events (esp.
//      for files created in a freshly-made dated subfolder, or under load).
//      That's the "sometimes a picture isn't recognized" symptom.
//   2. a 2s directory poll — reliable backstop that lists the tree and emits
//      any new image fs.watch missed. Only files that appear AFTER connect are
//      emitted (the existing tree is recorded as "already seen" up-front), so
//      turning on VRChat mode never dumps the whole folder.
//
// Every step logs to the SERVER console with a [vrchat/watch] prefix so a
// missed capture can be diagnosed (why a file was skipped, or which mechanism
// caught it). Watch the terminal running `next dev`.

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp'];
const SETTLE_MS = 1000;   // let the file finish saving before reading
const POLL_MS = 2000;     // directory-poll backstop cadence
const DEDUP_MS = 10000;   // ignore repeat triggers for the same path this long

export async function GET(req: NextRequest) {
  const watchPath = req.nextUrl.searchParams.get('path');
  if (!watchPath || !fs.existsSync(watchPath)) {
    console.warn(`[vrchat/watch] path not found or missing: ${watchPath}`);
    return new Response('Path not found', { status: 400 });
  }
  console.log(`[vrchat/watch] connected · watching "${watchPath}"`);

  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();
  writer.write(encoder.encode(`data: ${JSON.stringify({ status: 'connected' })}\n\n`));

  let isClosed = false;
  // Absolute paths currently "in flight" — shared between fs.watch and the poll
  // so a file caught by one mechanism isn't re-emitted by the other.
  const processedFiles = new Set<string>();

  // Emit one capture for a fully-saved image file. Shared by both detectors.
  const emitCapture = (fullPath: string, source: 'watch' | 'poll') => {
    if (isClosed) return;
    if (processedFiles.has(fullPath)) return;
    if (!fs.existsSync(fullPath)) { console.log(`[vrchat/watch] (${source}) vanished before read: ${fullPath}`); return; }

    processedFiles.add(fullPath);
    setTimeout(() => processedFiles.delete(fullPath), DEDUP_MS);

    // Delay briefly so a still-writing screenshot has finished flushing.
    setTimeout(() => {
      if (isClosed || !fs.existsSync(fullPath)) return;
      try {
        const stats = fs.statSync(fullPath);
        if (stats.size === 0) { console.log(`[vrchat/watch] (${source}) size 0, skipping: ${fullPath}`); return; }
        const ext = path.extname(fullPath).toLowerCase();
        const base64Data = fs.readFileSync(fullPath, { encoding: 'base64' });
        const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        const dataUrl = `data:${mimeType};base64,${base64Data}`;
        const filename = path.basename(fullPath);
        writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'vrchat_capture', image: dataUrl, filename })}\n\n`));
        console.log(`[vrchat/watch] (${source}) EMITTED capture · ${filename} · ${(stats.size / 1024).toFixed(0)}KB`);
      } catch (e) {
        console.error(`[vrchat/watch] (${source}) error reading capture:`, e);
      }
    }, SETTLE_MS);
  };

  // ── Baseline: every file that already exists is NEVER a new capture ───────
  // Recorded BEFORE fs.watch starts, and consulted by BOTH detectors.
  //
  // ⚠ MEASURED 2026-11-15 (REPORTED by ふわふわ: 16 photos from Nov 1–2 were
  // sent on their own, in folder order, none of them rewritten on disk): on
  // Windows, merely READING a file fires an fs.watch 'change' event (NTFS
  // updates the last-access time; libuv watches for it). A full readFileSync
  // of a two-week-old screenshot produced `change 2026-11\VRChat_…png`; a
  // stat did not. So anything that reads the folder — Explorer thumbnails,
  // an image viewer, a backup/sync, the indexer — made this route emit OLD
  // photos as new captures. Until now only the poll checked the baseline;
  // fs.watch emitted every event. NTFS refreshes last-access at most about
  // hourly, which is why it looked random.
  const seenRel = new Set<string>();
  const listTree = (): string[] => {
    try { return (fs.readdirSync(watchPath, { recursive: true } as any) as string[]).map(String); }
    catch (e) { console.error('[vrchat/watch] poll readdir failed:', e); return []; }
  };
  for (const rel of listTree()) seenRel.add(rel);
  console.log(`[vrchat/watch] baseline recorded (${seenRel.size} existing entries)`);

  // ── 1. fs.watch (low-latency, unreliable) ──────────────────────────────────
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(watchPath, { recursive: true }, (eventType, filename) => {
      if (isClosed || !filename) return;
      const fn = String(filename);
      const ext = path.extname(fn).toLowerCase();
      if (!IMAGE_EXTS.includes(ext)) return;
      // Existing (or already handled) file: an access/attribute event, not a
      // new screenshot. Same rule as the poll below.
      if (seenRel.has(fn)) return;
      seenRel.add(fn);
      const fullPath = path.join(watchPath, fn);
      console.log(`[vrchat/watch] (watch) event=${eventType} file=${fn}`);
      emitCapture(fullPath, 'watch');
    });
    watcher.on('error', (e) => console.error('[vrchat/watch] fs.watch error:', e));
  } catch (e) {
    console.error('[vrchat/watch] fs.watch could not start (poll still active):', e);
  }

  // ── 2. Directory-poll backstop (reliable) ──────────────────────────────────
  // Uses the same baseline: only files that appear after connect are new.

  const pollTimer = setInterval(() => {
    if (isClosed) return;
    for (const rel of listTree()) {
      if (seenRel.has(rel)) continue;   // already known (existing or handled)
      seenRel.add(rel);
      const ext = path.extname(rel).toLowerCase();
      if (!IMAGE_EXTS.includes(ext)) continue;
      const fullPath = path.join(watchPath, rel);
      if (processedFiles.has(fullPath)) continue; // fs.watch already got it
      console.log(`[vrchat/watch] (poll) NEW image fs.watch missed: ${rel}`);
      emitCapture(fullPath, 'poll');
    }
  }, POLL_MS);

  req.signal.addEventListener('abort', () => {
    isClosed = true;
    clearInterval(pollTimer);
    try { watcher?.close(); } catch {}
    writer.close().catch(() => {});
    console.log('[vrchat/watch] disconnected');
  });

  return new Response(stream.readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
  });
}
