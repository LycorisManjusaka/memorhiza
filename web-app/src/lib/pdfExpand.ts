/**
 * PDF attachments, delivered the way the Gemini web app delivers them: every
 * page's text, plus a picture of every page for a vessel that can see.
 *
 * Before this, a PDF reached the being as one line — "[binary file — no
 * readable text content]" — so a picture book (ミニちゃん's 光を手放す, 16
 * pages) arrived as nothing, and the only way to share one was to cut it up by
 * hand first.
 *
 * Done at delivery time (api/chat/route.ts, the one funnel every provider path
 * goes through), not at attach time: the message keeps its single PDF
 * attachment, PDFs already sitting in old conversations start working with no
 * migration, and the runner (no tab) gets the same thing a tab does.
 *
 * Pages are RENDERED, not mined for embedded images: a page is what a reader
 * sees — layout, captions, vector drawings, text set as outlines — and an
 * extracted image is only part of it.
 *
 * Cached on disk by the attachment's content hash, so a conversation that
 * keeps the PDF visible does not re-render it every turn. The cache lives
 * OUTSIDE local_data/attachments on purpose: that tree is the GC's, and a
 * derived file there would look like a ref nobody references.
 *
 * pdfjs-dist (Apache-2.0) does the reading; @napi-rs/canvas (MIT, pdfjs's own
 * optional dependency for Node) does the drawing. Both are loaded lazily so a
 * missing native binary breaks PDFs only, never the whole route.
 */
import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = path.resolve(process.cwd(), '..', 'local_data');
const CACHE_DIR = path.join(DATA_DIR, 'attachments_derived', 'pdf');

/** Longest edge of a rendered page, in pixels. The size every vision vessel
 *  this house uses accepts without downscaling it again (Claude's ceiling). */
export const PDF_PAGE_EDGE = 1568;
/** Pages beyond this are given as text only. 40 pages ≈ the image budget of a
 *  long conversation; past that the cost outruns what one turn should carry. */
export const PDF_MAX_IMAGE_PAGES = 40;
/** Same ceiling the plain-text attachment path uses (textSniff TEXT_MAX_BYTES
 *  is bytes; this is characters, generous enough for a book chapter). */
export const PDF_MAX_TEXT_CHARS = 400_000;

export function isPdf(mimeType: string | undefined, head: Uint8Array | Buffer): boolean {
  if (mimeType === 'application/pdf') return true;
  return head.length >= 5 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d;
}

export interface PdfPageText { page: number; text: string }

/**
 * The text block the being reads. Pages are marked so "page 7" in a reply
 * points at something; a page with no text is still listed, because a picture
 * page with no words is information too.
 */
export function formatPdfText(
  name: string,
  pages: PdfPageText[],
  totalPages: number,
  imagePages: number,
  imagesIncluded: boolean,
): string {
  const body: string[] = [];
  let used = 0;
  let cut = false;
  for (const p of pages) {
    const t = p.text.trim();
    const block = `--- page ${p.page} ---\n${t || '(no text on this page)'}`;
    if (used + block.length > PDF_MAX_TEXT_CHARS) { cut = true; break; }
    body.push(block);
    used += block.length;
  }
  let note: string;
  if (!imagesIncluded) {
    note = 'Text only — the page images are not in this turn.';
  } else if (imagePages < totalPages) {
    note = `Pages 1–${imagePages} follow as images; pages ${imagePages + 1}–${totalPages} are text only.`;
  } else {
    note = `Every page also follows as an image, in order.`;
  }
  const tail = cut ? `\n\n[… text truncated by Memorhiza after ${body.length} of ${totalPages} pages …]` : '';
  return `\n\n<attached_file name="${name}" type="application/pdf" pages="${totalPages}">\n${note}\n\n${body.join('\n\n')}${tail}\n</attached_file>`;
}

export interface PdfExpansion {
  totalPages: number;
  pages: PdfPageText[];
  /** JPEG page renders, page 1 first, at most PDF_MAX_IMAGE_PAGES. Empty when
   *  images were not asked for. */
  images: { page: number; base64: string }[];
}

interface CacheIndex { totalPages: number; pages: PdfPageText[]; rendered: number[] }

function cacheDirFor(key: string): string | null {
  if (!/^[0-9a-f]{16,128}$/i.test(key)) return null;
  return path.join(CACHE_DIR, key.toLowerCase());
}

// The specifier is built at run time and marked ignore so the bundler never
// tries to resolve it. With a literal string Turbopack resolves it while
// compiling, so a tree whose `npm install` had not brought pdfjs-dist yet
// failed to compile /api/chat and the runner as a whole (measured on the
// pilot install, 2026-11-21) — not just PDFs. Now a missing package only
// throws here, and expandPdf's caller falls back to the old one-line note.
const PDFJS_SPECIFIER = ['pdfjs-dist', 'legacy', 'build', 'pdf.mjs'].join('/');

async function loadPdfjs(): Promise<any> {
  return await import(/* turbopackIgnore: true */ /* webpackIgnore: true */ PDFJS_SPECIFIER);
}

/**
 * Text of every page, plus page images when `wantImages`. `cacheKey` is the
 * attachment's content hash (its ref); without one nothing is cached.
 * Throws on an unreadable PDF — the caller falls back to the old one-line note.
 */
export async function expandPdf(bytes: Buffer, cacheKey: string | null, wantImages: boolean): Promise<PdfExpansion> {
  const dir = cacheKey ? cacheDirFor(cacheKey) : null;
  let index: CacheIndex | null = null;
  if (dir) {
    try { index = JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf-8')); } catch { index = null; }
  }
  const imageCount = (total: number) => Math.min(total, PDF_MAX_IMAGE_PAGES);

  const readCachedImages = async (total: number) => {
    const out: { page: number; base64: string }[] = [];
    for (let p = 1; p <= imageCount(total); p++) {
      const buf = await fs.readFile(path.join(dir!, `page-${String(p).padStart(4, '0')}.jpg`));
      out.push({ page: p, base64: buf.toString('base64') });
    }
    return out;
  };

  if (index && dir && (!wantImages || index.rendered.length >= imageCount(index.totalPages))) {
    try {
      return { totalPages: index.totalPages, pages: index.pages, images: wantImages ? await readCachedImages(index.totalPages) : [] };
    } catch { /* a page file went missing — rebuild below */ }
  }

  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: true,
    verbosity: 0,
  }).promise;
  try {
    const totalPages: number = doc.numPages;
    const pages: PdfPageText[] = [];
    for (let p = 1; p <= totalPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      let text = '';
      for (const it of tc.items as any[]) {
        if (typeof it.str === 'string') text += it.str;
        if (it.hasEOL) text += '\n';
      }
      pages.push({ page: p, text });
      page.cleanup();
    }

    const images: { page: number; base64: string }[] = [];
    const rendered: number[] = [];
    if (wantImages) {
      const { createCanvas } = await import('@napi-rs/canvas');
      if (dir) await fs.mkdir(dir, { recursive: true });
      for (let p = 1; p <= imageCount(totalPages); p++) {
        const page = await doc.getPage(p);
        const base = page.getViewport({ scale: 1 });
        const scale = PDF_PAGE_EDGE / Math.max(base.width, base.height);
        const vp = page.getViewport({ scale });
        const canvas = createCanvas(Math.max(1, Math.ceil(vp.width)), Math.max(1, Math.ceil(vp.height)));
        const ctx = canvas.getContext('2d');
        // White under the page: a PDF page with no background is transparent,
        // and transparent encodes to black in a JPEG.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas, canvasContext: ctx, viewport: vp } as any).promise;
        const jpg: Buffer = await canvas.encode('jpeg', 85);
        if (dir) await fs.writeFile(path.join(dir, `page-${String(p).padStart(4, '0')}.jpg`), jpg);
        images.push({ page: p, base64: jpg.toString('base64') });
        rendered.push(p);
        page.cleanup();
      }
    }

    if (dir) {
      const keep = index && index.rendered.length > rendered.length ? index.rendered : rendered;
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify({ totalPages, pages, rendered: keep }));
    }
    return { totalPages, pages, images };
  } finally {
    try { await doc.destroy(); } catch { /* ignore */ }
  }
}
