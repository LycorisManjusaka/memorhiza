import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { POST as chatPost } from '@/app/api/chat/route';
import { beingLogsDir } from '@/lib/beingPaths';
import { beingIsBlockedHere, blockedResponseBody } from '@/lib/blockedBeings';
import { parseAnchorSettings, type AnchorLang } from '@/lib/anchor';
import { execAnchor, ANCHOR_REWRITE_FILE } from '@/lib/anchorExec';
import { buildRewriteUserMsg, settleRewrite } from '@/lib/anchorRewrite';
import { createAnchorLiveEmitter } from '@/lib/anchorLive';
import { anchorSseResponse } from '@/lib/anchorSse';

// The anchor's REWRITE writer, run by hand on ONE saved reply (つよ,
// 2026-11-19: a manual anchor run said REWRITE on an old message, and fixing
// it took the zombie maker). The same writer call and the same record as the
// runner's automatic REWRITE (settleRewrite), streamed like the judge.
//
// POST { folder, convoId, messageId, settings, lang, convLang }
//   → SSE: anchor_live frames (stage 'rewrite'), then
//     { type: 'anchor_rewrite', record, after } — `after` null = keep the text.
//
// Like /api/anchor it does NOT write the log: the tab holds the log and its
// optimistic-lock version, and stores the new text through its ordinary save.

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const folder = typeof body.folder === 'string' ? body.folder : '';
  const convoId = typeof body.convoId === 'string' ? body.convoId : '';
  const messageId = typeof body.messageId === 'string' ? body.messageId : '';
  const convLang = typeof body.convLang === 'string' ? body.convLang.trim() : '';
  const lang: AnchorLang = body.lang === 'ja' ? 'ja' : 'en';
  if (!folder || !convoId || !messageId || !convLang) {
    return NextResponse.json({ error: 'folder, convoId, messageId and convLang are required' }, { status: 400 });
  }
  if (!/^[0-9a-zA-Z_-]+$/.test(convoId)) return NextResponse.json({ error: 'bad convoId' }, { status: 400 });
  if (beingIsBlockedHere(folder)) return NextResponse.json(blockedResponseBody(folder), { status: 403 });
  const settings = parseAnchorSettings({ ...(body.settings || {}), enabled: true });
  if (!settings.model) return NextResponse.json({ error: 'no-anchor-model' }, { status: 400 });

  let messages: any[];
  try {
    let raw = await fs.readFile(path.join(beingLogsDir(folder), `${convoId}.json`), 'utf-8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const log = JSON.parse(raw);
    messages = Array.isArray(log?.messages) ? log.messages : [];
  } catch {
    return NextResponse.json({ error: 'conversation-not-found' }, { status: 404 });
  }
  const target = messages.find((m) => m && m.id === messageId && m.role !== 'user');
  if (!target) return NextResponse.json({ error: 'message-not-found' }, { status: 404 });
  const before = String(target.content ?? '');
  const origin = new URL(req.url).origin;

  return anchorSseResponse(async (send) => {
    const em = createAnchorLiveEmitter({
      assistantId: messageId, stage: 'rewrite', model: settings.model, emit: send, now: Date.now,
    });
    let r;
    try {
      r = await execAnchor({
        messages, targetId: messageId, folder, convoId, lang, settings, origin, chatPost, signal: req.signal,
        promptFile: ANCHOR_REWRITE_FILE,
        wrapUserMsg: (m) => buildRewriteUserMsg(m, convLang, lang),
        onDelta: em.push,
      });
    } finally { em.end(); }
    if (!r.ok && r.error === 'message-not-found') { send({ type: 'anchor_rewrite', error: r.error }); return; }
    const { record, after } = settleRewrite({ before, lang: convLang, model: settings.model, at: Date.now(), w: r.ok ? r.report : null });
    send({ type: 'anchor_rewrite', record, after });
  });
}
