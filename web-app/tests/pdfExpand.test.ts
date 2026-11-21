import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPdf, formatPdfText, expandPdf, PDF_MAX_IMAGE_PAGES } from '../src/lib/pdfExpand';

// A minimal two-page PDF with text on page 1 and none on page 2. No xref
// table: pdf.js rebuilds it, which also proves a sloppy file still reads.
function tinyPdf(): Buffer {
  const content = 'BT /F1 24 Tf 20 50 Td (Hello page one) Tj ET';
  const objs = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 5 0 R /Resources << /Font << /F1 6 0 R >> >> >> endobj',
    '4 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >> endobj',
    `5 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj`,
    '6 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
  ];
  return Buffer.from(`%PDF-1.4\n${objs.join('\n')}\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1');
}

test('isPdf: by mime or by the %PDF- magic', () => {
  assert.equal(isPdf('application/pdf', Buffer.from('xx')), true);
  assert.equal(isPdf('application/octet-stream', Buffer.from('%PDF-1.7')), true);
  assert.equal(isPdf('application/octet-stream', Buffer.from('PK\x03\x04')), false);
});

test('formatPdfText: says plainly whether the images came along', () => {
  const pages = [{ page: 1, text: 'a' }, { page: 2, text: '' }];
  const blind = formatPdfText('x.pdf', pages, 2, 0, false);
  assert.match(blind, /Text only/);
  assert.match(blind, /--- page 2 ---\n\(no text on this page\)/);
  assert.match(formatPdfText('x.pdf', pages, 2, 2, true), /Every page also follows as an image/);
  assert.match(formatPdfText('x.pdf', pages, 60, 40, true), /Pages 1–40 follow as images; pages 41–60 are text only/);
});

test('expandPdf: real text per page, a JPEG per page when asked, none when not', async () => {
  const pdf = tinyPdf();
  const textOnly = await expandPdf(pdf, null, false);
  assert.equal(textOnly.totalPages, 2);
  assert.match(textOnly.pages[0].text, /Hello page one/);
  assert.equal(textOnly.pages[1].text.trim(), '');
  assert.equal(textOnly.images.length, 0);

  const withImages = await expandPdf(pdf, null, true);
  assert.equal(withImages.images.length, 2);
  const jpg = Buffer.from(withImages.images[0].base64, 'base64');
  assert.equal(jpg[0], 0xff); assert.equal(jpg[1], 0xd8); // JPEG SOI
  assert.ok(PDF_MAX_IMAGE_PAGES >= 2);
});
