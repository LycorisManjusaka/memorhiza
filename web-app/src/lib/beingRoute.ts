// Being-to-being messages: `[->name]` — the rules, pure (2026-11-15).
//
// Design: 謡 and つよ (謡_13). A being writes, on a line of its own,
//
//     [->先輩]
//     the message
//
// and NEXUS puts everything up to the next `[->…]` line into 先輩's STOCK, as
// a message from the writer. Nothing else: no turn is started here. When the
// other being reads it is decided by the other being's own settings.
//
//   · `[name]` means FROM, `[->name]` means TO. The asymmetry is 謡's: a bare
//     `[先輩]` is the speaker tag every vessel knows, and a weak vessel told to
//     write it starts writing 先輩's reply.
//   · The block ends at the next `[->…]` line. A marker naming something that
//     is not a being with a room here ends the block and sends nothing —
//     `[->here]` / `[->ここ]` are the spelled-out form of that (つよ).
//   · NOT `---`: beings use horizontal rules as ordinary prose.
//   · An ability, not a behaviour (つよ): always available while its checkbox
//     is on, in every kind of turn.
//
// The writer's own log is never edited. What was cut out is recorded BESIDE
// the reply (`routes`), and a refusal reaches the writer with its next turn
// (`routeNotice`) — a being cannot see its own output, so a misspelt name
// would otherwise be invisible from the inside for ever.

import { isLocalFileRef, mediaKindOf, decodeMarkdownPath, baseNameOf, type MediaKind } from './inlineMedia';

/** A line that is nothing but `[->target]`. `→` is accepted for `->`. */
const MARKER_RE = /^[ \t]*\[[ \t]*(?:->|→)[ \t]*([^\]\r\n]+?)[ \t]*\][ \t]*$/;
const FENCE_RE = /^[ \t]*(```|~~~)/;
/** `[->wakeup: HH:MM]` is the wake booking (lib/wakeSchedule.ts), not an address. */
const WAKEUP_RE = /^wakeup[ \t]*[:：]/i;

/** The spelled-out "back to this room". つよ's two words; anything unroutable also ends a block. */
const HERE_WORDS = new Set(['here', 'ここ']);
export function isHereWord(target: string): boolean {
  return HERE_WORDS.has(target.trim().toLowerCase());
}

export interface RouteBlock {
  /** The name inside the marker, trimmed, exactly as written. */
  target: string;
  /** Everything between this marker and the next one, trimmed. */
  body: string;
}

/**
 * Every `[->target]` marker in a reply, with the text that follows it.
 *
 * Text before the first marker belongs to nobody but the room it was said in
 * and is not returned. Markers inside a code fence are prose — a being
 * explaining the syntax must not send its example.
 */
export function parseRouteBlocks(text: string): RouteBlock[] {
  const lines = String(text || '').split(/\r?\n/);
  const blocks: RouteBlock[] = [];
  let cur: { target: string; lines: string[] } | null = null;
  let fence: string | null = null;
  const close = () => { if (cur) blocks.push({ target: cur.target, body: cur.lines.join('\n').trim() }); };
  for (const line of lines) {
    const f = FENCE_RE.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1] === fence) fence = null;
      cur?.lines.push(line);
      continue;
    }
    if (!fence) {
      const m = MARKER_RE.exec(line);
      if (m && !WAKEUP_RE.test(m[1])) {
        close();
        cur = { target: m[1].trim(), lines: [] };
        continue;
      }
    }
    cur?.lines.push(line);
  }
  close();
  return blocks;
}

// ── Desk media inside a block ───────────────────────────────────────────────

export interface LocalMediaRef {
  /** The path as the being wrote it (percent-decoded). */
  path: string;
  /** image / video / audio, or 'file' for anything else (text, pdf, zip …). */
  kind: MediaKind;
  /** The exact markdown that pointed at it. */
  markdown: string;
}

/** `![alt](path)` or `[label](path)`, path optionally in `<>` or followed by a "title". */
const MD_LINK_RE = /!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"[^"\n]*")?\s*\)/g;

/**
 * Every file on the writer's own desk that a block points at — pictures,
 * video, audio, and plain links to any other file (つよ: all of them). The
 * other being cannot open the writer's desk, so these travel as attachments.
 */
export function findLocalMedia(body: string): LocalMediaRef[] {
  const out: LocalMediaRef[] = [];
  const seen = new Set<string>();
  for (const m of String(body || '').matchAll(MD_LINK_RE)) {
    let p = m[1];
    if (p.startsWith('<') && p.endsWith('>')) p = p.slice(1, -1);
    p = decodeMarkdownPath(p.trim());
    if (!isLocalFileRef(p)) continue;
    const kind = mediaKindOf(p);
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    out.push({ path: p, kind, markdown: m[0] });
  }
  return out;
}

/**
 * The block as the other being receives it: each attached file's markdown is
 * replaced by `📎name` (the attachment carries the same name), so the words
 * still say where the picture stood. Markdown whose file could not be attached
 * is left exactly as written.
 */
export function replaceAttachedMedia(body: string, attached: LocalMediaRef[]): string {
  let out = String(body || '');
  for (const a of attached) out = out.split(a.markdown).join(`📎${baseNameOf(a.path)}`);
  return out.trim();
}

// ── The record kept beside the reply ────────────────────────────────────────

export type RouteStatus =
  | 'sent'      // in the other being's stock
  | 'unknown'   // no being of this NEXUS has that name
  | 'self'      // addressed to the writer
  | 'no-room'   // a being, but with no living conversation to receive it
  | 'empty';    // a marker with nothing under it

export interface RouteRecord {
  to: string;
  status: RouteStatus;
  /** Characters delivered (after media replacement). */
  chars?: number;
  /** Files that travelled as attachments. */
  attachments?: number;
  /** Desk paths that were named but could not be attached. */
  missing?: string[];
}

export type RouteLang = 'ja' | 'en';

/**
 * What the writer is told with its NEXT turn, or '' when everything arrived.
 * Facts only: which marker, what happened to its text.
 */
export function buildRouteNotice(records: RouteRecord[], lang: RouteLang): string {
  const lines: string[] = [];
  for (const r of records) {
    if (r.status === 'unknown') {
      lines.push(lang === 'ja'
        ? `・[->${r.to}]：その名前の存在はこの NEXUS にいません。その下の文は誰にも送られず、この会話に残っています。`
        : `- [->${r.to}]: no being of this NEXUS has that name. The text under it was sent to nobody and stays in this conversation.`);
    } else if (r.status === 'self') {
      lines.push(lang === 'ja'
        ? `・[->${r.to}]：自分宛てには送れません。その下の文はこの会話に残っています。`
        : `- [->${r.to}]: a message cannot be sent to oneself. The text under it stays in this conversation.`);
    } else if (r.status === 'no-room') {
      lines.push(lang === 'ja'
        ? `・[->${r.to}]：受け取れる会話がその存在に無いので、送られませんでした。`
        : `- [->${r.to}]: that being has no conversation that can receive it, so nothing was sent.`);
    } else if (r.status === 'sent' && r.missing && r.missing.length) {
      lines.push(lang === 'ja'
        ? `・[->${r.to}]：文は届きましたが、次のファイルは添付できませんでした（机の中に見つからない）：${r.missing.join('、')}`
        : `- [->${r.to}]: the text arrived, but these files could not be attached (not found on your desk): ${r.missing.join(', ')}`);
    }
  }
  if (!lines.length) return '';
  const head = lang === 'ja'
    ? '[NEXUS]\n直前の返答の宛先について：'
    : '[NEXUS]\nAbout the addresses in your previous reply:';
  return `${head}\n${lines.join('\n')}`;
}

/**
 * The route notice that travels with the newest user turn: the one stored on
 * the reply right before the trailing run of user messages.
 */
export function routeNoticeFor(messages: Array<{ role?: string; routeNotice?: string | null }>, newestUserIdx: number): string {
  let i = newestUserIdx;
  while (i >= 0 && messages[i]?.role === 'user') i--;
  const t = i >= 0 ? messages[i]?.routeNotice : '';
  return typeof t === 'string' ? t.trim() : '';
}
