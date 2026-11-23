import { readAttachmentBase64 } from '@/lib/attachmentStore';
import { isPdf, expandPdf, formatPdfText } from '@/lib/pdfExpand';
import { estimateTokensForModel } from '@/lib/tokenEstimate';

// What a PDF attachment costs once it is delivered — for the token gauge.
//
// A PDF is attached as an opaque binary (tokens: 0), and only at delivery time
// (api/chat/route.ts → lib/pdfExpand) does it become every page's text plus a
// picture per page. So the gauge counted every PDF as zero, and hiding or
// showing one changed nothing on screen even though it changed what was sent.
//
// This answers with the page count and the text block's token estimate. The
// image half depends on the vessel and on whether the message is past, so the
// client computes it (lib/attachmentVisibility, pdfAttachmentTokens). Text
// only here — rendering pages just to count them would cost a second per PDF;
// the text pass reads the same on-disk cache the send path fills.

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const ref = url.searchParams.get('ref') || '';
  const model = url.searchParams.get('model') || '';
  const stored = await readAttachmentBase64(ref);
  if (!stored) return Response.json({ error: 'not-found' }, { status: 404 });
  const raw = Buffer.from(stored.base64, 'base64');
  if (!isPdf(stored.mimeType, raw.subarray(0, 8))) return Response.json({ error: 'not-pdf' }, { status: 400 });
  try {
    const pdf = await expandPdf(raw, ref, false);
    const text = formatPdfText('document.pdf', pdf.pages, pdf.totalPages, 0, false);
    return Response.json({ totalPages: pdf.totalPages, textTokens: estimateTokensForModel(text, model) });
  } catch (e: any) {
    return Response.json({ error: 'unreadable', message: String(e?.message || e) }, { status: 422 });
  }
}
