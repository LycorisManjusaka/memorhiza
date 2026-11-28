// The real storage behind lib/quietLeave.ts — one binding, used by the two
// places that call it (the enqueue of a quiet message, and the end of a turn),
// so they cannot write the log in two different ways.

import crypto from 'node:crypto';
import { claim, pending, release, readLease, holderIsGone } from './turnQueue';
import { loadLog, saveLog } from './fsStorage';
import { soulUpdateRunning } from './soulUpdateHold';
import { isQuietItem } from './quietStock';
import { leaveQuietInLog, type QuietLeaveResult } from './quietLeave';

export async function leaveQuietMessages(being: string, convoId: string, selfId: string): Promise<QuietLeaveResult> {
  return leaveQuietInLog(being, convoId, {
    pending: (b, c) => pending(b, c),
    // Any installation may write a quiet message into the log: nothing RUNS,
    // so the addressing rule (which clone runs this turn) has nothing to say.
    claimQuiet: (b, c, holder) => claim(b, c, holder, { accept: isQuietItem }),
    release: (b, c, token, ids) => release(b, c, token, ids),
    loadLog: (id) => loadLog(id),
    saveLog: (id, data, opts) => saveLog(id, data, opts),
    soulUpdateRunning: (b) => soulUpdateRunning(b),
    turnRunning: async (b, c) => { const l = await readLease(b, c); return !!l && !holderIsGone(l.pid); },
    newId: () => crypto.randomUUID(),
    nowMs: () => Date.now(),
    clientId: `quiet:${selfId}`,
  });
}
