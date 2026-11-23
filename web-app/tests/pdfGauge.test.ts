import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentTokens, rememberPdfInfo, isPdfAttachment, pdfImagesDelivered } from '@/lib/attachmentVisibility';

const ctx = (over: any = {}) => ({ specificModel: 'gemini-4-neon', aiName: 'Gemini', isOAuthClaude: false, eyesEnabled: false, earsEnabled: false, watcherEnabled: false, ...over });
const pdf = { name: 'book.pdf', type: 'application/pdf', ref: 'a'.repeat(64) + '.pdf', tokens: 0 };

test('a PDF is not zero once its size is known, and hiding it zeroes it', () => {
  rememberPdfInfo(pdf.ref, { totalPages: 16, textTokens: 900 });
  assert.equal(isPdfAttachment(pdf), true);
  const shown = attachmentTokens(pdf, false, ctx() as any);
  assert.ok(shown > 900, 'text plus page images for a seeing vessel');
  assert.equal(attachmentTokens({ ...pdf, excluded: true }, false, ctx() as any), 0);
});

test('past OAuth-Claude PDFs count text only, like the send path', () => {
  const c = ctx({ specificModel: 'claude-opus-5', aiName: 'Claude', isOAuthClaude: true });
  assert.equal(pdfImagesDelivered(true, c as any), false);
  assert.equal(attachmentTokens(pdf, true, c as any), 900);
  assert.equal(pdfImagesDelivered(false, c as any), true);
});
