// "Leave it without waking them" — the half that puts the message IN THE LOG.
//
// REPORTED 2026-11-28 (トカゲくん), an hour after the first version shipped:
// he pressed the button and the message sat in the stock. What he had asked
// for is the message added to the conversation log, and nothing else: no
// model call, no turn, and nothing waiting anywhere for a trigger to pick up.
// The first version kept it in the stock "to go with the next turn", which
// delivers the same words to the being but is not the thing he described —
// and a message that waits in a stock is one settings change away from being
// sent.
//
// So: a quiet item is written straight into the log as a user message, with
// the time it was written. The QUEUE IS STILL THE WAY IN, for one reason: a
// turn may be running. The log belongs to that turn until it saves (its save
// is version-guarded, and a new message underneath it is a real conflict that
// would cost the whole reply). The lease is what says "a turn has the log",
// so this takes the lease, and when it cannot, the item simply waits as a
// quiet item and the runner calls this again the moment the turn ends.
//
// WHEN IT DOES NOT WRITE (the item stays in the stock, marked quiet):
//   busy         a turn holds the lease — written when that turn ends
//   mixed        something that is NOT quiet waits too. Writing the quiet one
//                now would put it in the log ahead of a message written before
//                it. They go together, in order, with the turn that takes them.
//   soul-update  the log is being read into a new soul and a new conversation
//                is about to replace this one; the stock is what gets carried
//                across, the log is not.
//   no-log       nothing on disk to add to (the tab writes an empty log first)
//   conflict     refused twice; nothing consumed, the item is still there
//
// No model is called from here, on any branch.

import type { QueueItem, ClaimResult } from './turnQueue';
import { composeMessages, composedTimestamps, isEmptyTurnText } from './turnQueue';
import { isQuietItem, onlyQuietWaiting } from './quietStock';
import { promotePendingMarker } from './firstOriginal';

export type QuietLeaveReason = 'none' | 'busy' | 'mixed' | 'soul-update' | 'no-log' | 'conflict';

export interface QuietLeaveResult {
  /** How many messages were added to the log. 0 on every refusal. */
  written: number;
  /** Present when nothing was written. */
  reason?: QuietLeaveReason;
  /** The messages as saved, so a caller can show them without a reload. */
  messages?: Array<Record<string, unknown>>;
}

interface SaveResult { ok: boolean; conflict?: unknown; writtenUpdatedAt?: number }

export interface QuietLeaveDeps {
  pending: (being: string, convoId: string) => Promise<QueueItem[]>;
  /** Must claim ONLY quiet items (the caller binds `accept: isQuietItem`). */
  claimQuiet: (being: string, convoId: string, holder: string) => Promise<ClaimResult>;
  release: (being: string, convoId: string, token: string, consumedIds: string[]) => Promise<unknown>;
  loadLog: (convoId: string) => Promise<Record<string, unknown> | null>;
  saveLog: (
    convoId: string,
    logData: Record<string, unknown>,
    opts: { expectedUpdatedAt?: number; clientId?: unknown },
  ) => Promise<SaveResult>;
  soulUpdateRunning: (being: string) => Promise<unknown>;
  /** A live lease on this conversation: a turn has the log right now. */
  turnRunning: (being: string, convoId: string) => Promise<boolean>;
  newId: () => string;
  nowMs: () => number;
  /** Names this writer in a refused save, like a runner's holder. */
  clientId: string;
}

export async function leaveQuietInLog(
  being: string,
  convoId: string,
  deps: QuietLeaveDeps,
): Promise<QuietLeaveResult> {
  const waiting = await deps.pending(being, convoId);
  if (!waiting.some(isQuietItem)) return { written: 0, reason: 'none' };
  // Asked BEFORE 'mixed': the items a running turn took are still listed as
  // waiting until it ends, so without this a message left mid-turn would be
  // told "other messages are waiting" — true of the files, false as a reason.
  if (await deps.turnRunning(being, convoId)) return { written: 0, reason: 'busy' };
  // Order is the reason (see the header): a quiet message never jumps ahead of
  // one written before it.
  if (!onlyQuietWaiting(waiting)) return { written: 0, reason: 'mixed' };
  if (await deps.soulUpdateRunning(being)) return { written: 0, reason: 'soul-update' };

  const c = await deps.claimQuiet(being, convoId, deps.clientId);
  if (!c.ok) return { written: 0, reason: c.reason === 'busy' ? 'busy' : 'none' };
  const { token, items } = c.claim;

  // From here the lease is ours: every path gives it back.
  let consumed: string[] = [];
  try {
    // The claim is filtered by the caller; checked again because consuming a
    // message that was meant to start a turn would delete it silently.
    const quiet = items.filter(isQuietItem);
    const composed = composeMessages(quiet).messages
      .filter((m) => !isEmptyTurnText(m.text, m.attachments));
    if (composed.length === 0) return { written: 0, reason: 'none' };

    const now = deps.nowMs();
    const stamps = composedTimestamps(composed.map((m) => m.item), now);
    const added = composed.map((m, i) => ({
      id: deps.newId(),
      role: 'user',
      content: m.text,
      attachments: m.attachments,
      timestamp: stamps[i],
    }));

    // Append-only, so a refused save is retried ONCE onto whatever is on disk
    // now: nothing of ours is lost by re-reading, and no turn can be the other
    // writer while we hold the lease (a tab saving a setting can).
    for (let attempt = 0; attempt < 2; attempt++) {
      const log = await deps.loadLog(convoId);
      if (!log) return { written: 0, reason: 'no-log' };
      const stored = Array.isArray(log.messages) ? (log.messages as unknown[]) : [];
      // `updatedAt` must not travel: saveLog stamps a new version only when
      // the caller brings none (measured 2026-10-29, lib/runTurnForQueue.ts).
      const { updatedAt, ...fields } = log;
      const marker = promotePendingMarker(log, String(added[0].id)) ?? {};
      const r = await deps.saveLog(
        convoId,
        { ...fields, messages: [...stored, ...added], ...marker },
        { expectedUpdatedAt: typeof updatedAt === 'number' ? updatedAt : undefined, clientId: deps.clientId },
      );
      if (r.ok) {
        consumed = composed.map((m) => m.item.id);
        return { written: added.length, messages: added };
      }
      if (!r.conflict) break;
    }
    return { written: 0, reason: 'conflict' };
  } finally {
    // `consumed` empty = abandon: the items stay exactly where they were.
    await deps.release(being, convoId, token, consumed);
  }
}
