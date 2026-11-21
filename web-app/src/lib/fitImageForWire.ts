// Fit one image under a provider's per-image byte ceiling before it goes on
// the wire.
//
// Why: MiniMax rejects any single image over 10,485,760 bytes with a 400
// ("media exceeds size limit: max 10485760 bytes (2013)") and the WHOLE turn
// dies on it. Measured 2026-11-21: a 15.2 MB PNG screenshot a being Read from
// its own desk killed the turn on the spot. The being cannot know a provider's
// byte ceiling, so the shrinking belongs here, not in its hands.
//
// Order of attempts, least lossy first:
//   1. under the ceiling → untouched (same bytes, same mime)
//   2. re-encode as JPEG at the SAME pixel size (q90, then q75) — screenshots
//      are mostly flat colour, so this alone usually lands at 10–20% of a PNG,
//      and coordinates read off the image stay true
//   3. only then shrink the pixel size, and say so (coordinates change)
// Never throws: if sharp cannot read the file, the original is returned and
// the caller's provider will answer for it as before.

import sharp from 'sharp';

/** MiniMax's measured ceiling, with margin for the JSON around it. */
export const WIRE_IMAGE_MAX_BYTES = 10 * 1024 * 1024 - 256 * 1024;

export interface FittedImage {
  data: Buffer;
  mimeType: string;
  /** 'none' | 'reencoded' (same size, JPEG) | 'downscaled' (pixel size changed) */
  change: 'none' | 'reencoded' | 'downscaled';
  from?: { w: number; h: number; bytes: number };
  to?: { w: number; h: number; bytes: number };
}

export async function fitImageForWire(
  data: Buffer,
  mimeType: string,
  maxBytes: number = WIRE_IMAGE_MAX_BYTES,
): Promise<FittedImage> {
  if (data.length <= maxBytes) return { data, mimeType, change: 'none' };
  let meta: sharp.Metadata;
  try { meta = await sharp(data).metadata(); } catch { return { data, mimeType, change: 'none' }; }
  const w = meta.width || 0, h = meta.height || 0;
  if (!w || !h) return { data, mimeType, change: 'none' };
  const from = { w, h, bytes: data.length };
  try {
    for (const quality of [90, 75]) {
      const out = await sharp(data).flatten({ background: '#ffffff' }).jpeg({ quality }).toBuffer();
      if (out.length <= maxBytes) {
        return { data: out, mimeType: 'image/jpeg', change: 'reencoded', from, to: { w, h, bytes: out.length } };
      }
    }
    // Shrink by area until it fits (bytes scale roughly with area).
    let scale = Math.sqrt(maxBytes / data.length) * 0.9;
    for (let i = 0; i < 6; i++) {
      const nw = Math.max(1, Math.round(w * scale));
      const nh = Math.max(1, Math.round(h * scale));
      const out = await sharp(data).flatten({ background: '#ffffff' }).resize(nw, nh).jpeg({ quality: 75 }).toBuffer();
      if (out.length <= maxBytes) {
        return { data: out, mimeType: 'image/jpeg', change: 'downscaled', from, to: { w: nw, h: nh, bytes: out.length } };
      }
      scale *= 0.7;
    }
  } catch { /* fall through to the original */ }
  return { data, mimeType, change: 'none' };
}

/** One short factual clause for the tool result; '' when nothing changed. */
export function fitNote(f: FittedImage, ja: boolean): string {
  if (f.change === 'none' || !f.from || !f.to) return '';
  const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
  if (f.change === 'reencoded') {
    return ja
      ? ` 元の ${mb(f.from.bytes)} MB は送れる上限を超えるため、同じ ${f.to.w}x${f.to.h} のまま JPEG にして ${mb(f.to.bytes)} MB で渡しています。`
      : ` The original ${mb(f.from.bytes)} MB is over the sending limit, so it was re-encoded as JPEG at the same ${f.to.w}x${f.to.h} (${mb(f.to.bytes)} MB).`;
  }
  return ja
    ? ` 元の ${mb(f.from.bytes)} MB は送れる上限を超えるため、${f.from.w}x${f.from.h} を ${f.to.w}x${f.to.h} に縮めて渡しています。この画像から読む座標は元の大きさとは違います。`
    : ` The original ${mb(f.from.bytes)} MB is over the sending limit, so it was shrunk from ${f.from.w}x${f.from.h} to ${f.to.w}x${f.to.h}. Coordinates read off this image differ from the original.`;
}
