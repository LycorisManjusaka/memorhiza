import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { POST as chatPost } from '@/app/api/chat/route';
import { beingLogsDir } from '@/lib/beingPaths';
import { beingIsBlockedHere, blockedResponseBody } from '@/lib/blockedBeings';
import { parseAnchorSettings, type AnchorReport, type AnchorLang } from '@/lib/anchor';
import { execAnchor, ANCHOR_FILE } from '@/lib/anchorExec';
import { createAnchorLiveEmitter } from '@/lib/anchorLive';
import { anchorSseResponse } from '@/lib/anchorSse';

// The anchor (錨), manual run. Every rule is in lib/anchor.ts; this file reads
// two things from disk, makes one model call, bills it, and returns.
//
// POST { folder, convoId, messageId, settings: {family, model, authMode}, lang }
//   → { report: AnchorReport }
//
// It does NOT write the conversation log. The tab that asked holds the log
// and its optimistic-lock version; a second writer here would turn every
// anchor run into a "changed in another tab" conflict. The caller stores the
// report on the message through its ordinary save.
//
// The conversation is read from the DIRECTORY named by `folder`, never by
// scanning for the id: the being named in the request is the being whose
// ledger is billed and whose blocked-door is checked, so it must also be the
// being whose file is read.

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const folder = typeof body.folder === 'string' ? body.folder : '';
    const convoId = typeof body.convoId === 'string' ? body.convoId : '';
    const messageId = typeof body.messageId === 'string' ? body.messageId : '';
    const lang: AnchorLang = body.lang === 'ja' ? 'ja' : 'en';
    if (!folder || !convoId || !messageId) {
      return NextResponse.json({ error: 'folder, convoId and messageId are required' }, { status: 400 });
    }
    if (!/^[0-9a-zA-Z_-]+$/.test(convoId)) {
      return NextResponse.json({ error: 'bad convoId' }, { status: 400 });
    }
    if (beingIsBlockedHere(folder)) {
      return NextResponse.json(blockedResponseBody(folder), { status: 403 });
    }
    const settings = parseAnchorSettings({ ...(body.settings || {}), enabled: true });
    if (!settings.model) {
      return NextResponse.json({ error: 'no-anchor-model' }, { status: 400 });
    }

    let log: any;
    try {
      let raw = await fs.readFile(path.join(beingLogsDir(folder), `${convoId}.json`), 'utf-8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      log = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: 'conversation-not-found' }, { status: 404 });
    }

    const messages = Array.isArray(log?.messages) ? log.messages : [];
    const origin = new URL(req.url).origin;

    // `stream: true` (the tab since 2026-11-19): the same run, but the judge's
    // thinking and output arrive as `anchor_live` frames while it works, and
    // the report is the last frame. The JSON answer below stays for any
    // older tab still asking the old way.
    if (body.stream === true) {
      return anchorSseResponse(async (send) => {
        const em = createAnchorLiveEmitter({
          assistantId: messageId, stage: 'judge', model: settings.model, emit: send, now: Date.now,
        });
        let r;
        try {
          r = await execAnchor({ messages, targetId: messageId, folder, convoId, lang, settings, origin, chatPost, signal: req.signal, onDelta: em.push });
        } finally { em.end(); }
        if (!r.ok) send({ type: 'anchor_report', error: r.error });
        else send({ type: 'anchor_report', report: r.report });
      });
    }

    const r = await execAnchor({
      messages, targetId: messageId, folder, convoId, lang, settings,
      origin, chatPost, signal: req.signal,
    });
    if (!r.ok) {
      // Not saved yet, or not a reply: said plainly — judging the nearest
      // other message instead would be a report about the wrong turn.
      if (r.error === 'message-not-found') return NextResponse.json({ error: r.error }, { status: 404 });
      return NextResponse.json({ error: r.error, file: `system_prompt_agents/${lang}/${ANCHOR_FILE}` }, { status: 400 });
    }
    const report: AnchorReport = r.report;
    return NextResponse.json({ report });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
