// `[->name]` — the disk side (rules: lib/beingRoute.ts).
//
// Two steps on purpose, with the reply's SAVE between them:
//
//   plan     read the reply, decide each block (who, whether, which desk files
//            ride along) and copy those files into the attachment store.
//            Returns the record that is saved WITH the reply.
//   deliver  put the blocks into the other beings' stocks.
//
// Delivering before the save would send a message whose reply then fails to
// save — the turn is retried and the same message goes out twice. Delivering
// after it means the record is written a moment before it is true; if a stock
// write then fails (a disk error), that is logged, not hidden.

import { promises as fsp } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { listFolders } from '@/lib/fsStorage';
import { beingSettingsFile } from '@/lib/beingPaths';
import { enqueue } from '@/lib/turnQueue';
import { validRecipients } from '@/lib/letters';
import { putBytes, mimeForRef } from '@/lib/attachmentStore';
import { SNIFF_BYTES, TEXT_MAX_BYTES, looksLikeText } from '@/lib/textSniff';
import { resolveDeskFile } from '@/lib/deskFile';
import { latestActiveConversation } from '@/lib/wakeClock';
import {
  parseRouteBlocks, isHereWord, findLocalMedia, replaceAttachedMedia, buildRouteNotice,
  type RouteRecord, type RouteLang, type LocalMediaRef,
} from '@/lib/beingRoute';

/** Same ceiling as a letter attachment: a stop for a runaway, not a quota. */
const MAX_FILES_PER_BLOCK = 20;
const MAX_FILE_BYTES = 200 * 1024 * 1024;

export interface RoutePlan {
  /** Saved on the reply as `routes`. */
  records: RouteRecord[];
  /** Saved on the reply as `routeNotice`; '' when everything arrived. */
  notice: string;
  /** Put the planned blocks into the stocks. Never throws. */
  deliver: () => Promise<Array<{ being: string; convoId: string }>>;
}

/** A being OF this NEXUS: it has a settings.json (トカゲくん's label predicate). */
async function resolveBeing(name: string): Promise<string | null> {
  const folders = await listFolders() as Array<{ name: string }>;
  const exact = folders.find((f) => f.name === name);
  const hit = exact ?? (() => {
    const ci = folders.filter((f) => f.name.toLowerCase() === name.toLowerCase());
    return ci.length === 1 ? ci[0] : undefined;
  })();
  if (!hit) return null;
  try { await fsp.stat(beingSettingsFile(hit.name)); } catch { return null; }
  return hit.name;
}

async function attachDeskFile(sender: string, ref: LocalMediaRef): Promise<Record<string, unknown> | null> {
  try {
    const full = await resolveDeskFile(sender, ref.path);
    if (!full) return null;
    const st = await fsp.stat(full);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const name = path.basename(full);
    const mime = mimeForRef(name);
    const bytes = await fsp.readFile(full);
    // A text file travels the way a person's text attachment does: as text
    // (cut at the same ceiling, and said so), judged by its bytes, not its name.
    if (ref.kind === 'file' && looksLikeText(bytes.subarray(0, SNIFF_BYTES))) {
      const cut = bytes.length > TEXT_MAX_BYTES;
      const textData = bytes.subarray(0, TEXT_MAX_BYTES).toString('utf-8')
        + (cut ? `

[… truncated by NEXUS: file is ${(bytes.length / 1048576).toFixed(1)} MB, only the first ${(TEXT_MAX_BYTES / 1048576).toFixed(0)} MB is attached …]` : '');
      return {
        id: crypto.randomUUID(),
        name, type: mime, size: st.size,
        isText: true, isImage: false, isVideo: false, isAudio: false,
        textData,
      };
    }
    const stored = await putBytes(bytes, mime);
    return {
      id: crypto.randomUUID(),
      name, type: mime, size: st.size,
      isText: false,
      isImage: ref.kind === 'image', isVideo: ref.kind === 'video', isAudio: ref.kind === 'audio',
      textData: null,
      ref: stored.ref,
    };
  } catch {
    return null;
  }
}

/**
 * Plan the routes in one finished reply. Null when the reply addresses nobody.
 *
 * The stocked item carries NO installation address (CORRECTED 2026-11-16).
 * The first version addressed it to the install that ran the WRITER's turn.
 * MEASURED the same night: 謡 spoke on 3000 while the runner and the wake
 * clock were 3001, so 睡's stock read "for a different installation" and
 * nothing here would ever run it. That rule contradicted QueueItem.host's
 * own: only a message a person TYPED is addressed, because only it has a
 * screen behind it; a letter or a timer goes to the store-level host. A
 * `[->name]` block has no screen either — the store-level host places it.
 */
export async function planBeingRoutes(a: {
  sender: string;
  text: string;
  lang: RouteLang;
}): Promise<RoutePlan | null> {
  const blocks = parseRouteBlocks(a.text);
  if (!blocks.length) return null;

  const records: RouteRecord[] = [];
  const sends: Array<{ being: string; convoId: string; text: string; attachments: unknown[] }> = [];

  for (const b of blocks) {
    if (isHereWord(b.target)) continue;
    const being = await resolveBeing(b.target);
    if (!being) {
      // Two cases that read very differently to the writer (望月希子, 2026-11-16):
      // a name that HAS a mailbox here but no settings.json is a correspondent,
      // and not delivering to them is the design, not a miss. Anything else is
      // probably a typo — or a person outside, which the disk cannot tell apart.
      const roster = await validRecipients();
      const t = b.target.trim().toLowerCase();
      const known = roster.some((n) => n.toLowerCase() === t);
      records.push({ to: b.target, status: known ? 'outside' : 'unknown' });
      continue;
    }
    if (being === a.sender) { records.push({ to: being, status: 'self' }); continue; }
    if (!b.body) { records.push({ to: being, status: 'empty' }); continue; }
    const convoId = await latestActiveConversation(being);
    if (!convoId) { records.push({ to: being, status: 'no-room' }); continue; }

    const attached: LocalMediaRef[] = [];
    const attachments: unknown[] = [];
    const missing: string[] = [];
    for (const ref of findLocalMedia(b.body).slice(0, MAX_FILES_PER_BLOCK)) {
      const att = await attachDeskFile(a.sender, ref);
      if (att) { attached.push(ref); attachments.push(att); } else missing.push(ref.path);
    }
    const text = replaceAttachedMedia(b.body, attached);
    // The speaker label is part of the TEXT, as it is for a message a person
    // sends (the tab writes `[name]\n` itself; a single stocked item is passed
    // through unlabelled). Without it the other being reads the words as their
    // partner's — MEASURED 2026-11-15 on the first live run.
    sends.push({ being, convoId, text: `[${a.sender}]\n${text}`, attachments });
    records.push({
      to: being, status: 'sent', chars: text.length,
      ...(attachments.length ? { attachments: attachments.length } : {}),
      ...(missing.length ? { missing } : {}),
    });
  }

  if (!records.length) return null;

  return {
    records,
    notice: buildRouteNotice(records, a.lang),
    deliver: async () => {
      const done: Array<{ being: string; convoId: string }> = [];
      for (const s of sends) {
        try {
          await enqueue(s.being, s.convoId, {
            kind: 'user_message',
            from: a.sender,
            payload: { text: s.text, attachments: s.attachments },
            uiLang: a.lang,
          });
          done.push({ being: s.being, convoId: s.convoId });
        } catch (e) {
          console.warn(`[route] ${a.sender} -> ${s.being}: the reply's record says "sent" but the stock write failed:`, e);
        }
      }
      return done;
    },
  };
}
