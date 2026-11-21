import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { fitImageForWire, fitNote } from '@/lib/fitImageForWire';

async function noisyPng(w: number, h: number): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  let s = 12345;
  for (let i = 0; i < raw.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; raw[i] = s & 0xff; }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
}

test('under the ceiling: same bytes, nothing said', async () => {
  const png = await noisyPng(64, 64);
  const f = await fitImageForWire(png, 'image/png', 1024 * 1024);
  assert.equal(f.change, 'none');
  assert.equal(f.data, png);
  assert.equal(fitNote(f, true), '');
});

test('over the ceiling: lands under it, and the note tells the truth about size', async () => {
  const png = await noisyPng(800, 600); // ~1.4 MB raw-ish PNG
  const max = 300 * 1024;
  assert.ok(png.length > max);
  const f = await fitImageForWire(png, 'image/png', max);
  assert.notEqual(f.change, 'none');
  assert.ok(f.data.length <= max, `got ${f.data.length}`);
  assert.equal(f.mimeType, 'image/jpeg');
  const meta = await sharp(f.data).metadata();
  assert.equal(meta.width, f.to!.w);
  if (f.change === 'reencoded') assert.equal(meta.width, 800);
  else assert.match(fitNote(f, false), /Coordinates/);
});

test('unreadable bytes: original returned, never throws', async () => {
  const junk = Buffer.alloc(2048, 7);
  const f = await fitImageForWire(junk, 'image/png', 1024);
  assert.equal(f.change, 'none');
  assert.equal(f.data, junk);
});
