// ─────────────────────────────────────────────────────────────────────────────
// Server side of "a past conversation does not speak" (つよ, 2026-11-15).
//
// The rule itself is pure and lives in livingConversation.ts
// (`pastConversationRefusal`). This file only gathers what the rule needs off
// disk — the being's log rows and its test-bed flag — the same two reads the
// wake clock makes (wakeClock.latestActiveConversation), so the two cannot
// disagree about which conversation is living.
//
// Called from the turn-queue route's `enqueue`, which is the door every
// turn-starting action goes through (send, rerun, continue, stock). The screen
// hides the input on a past log too; this is the refusal that holds when the
// screen is an old tab that has not reloaded.
//
// A read failure ALLOWS. This gate exists to stop a send landing in the wrong
// place; turning a disk hiccup into "you cannot talk to anyone" would be the
// worse failure.
// ─────────────────────────────────────────────────────────────────────────────

import { listFolders, listLogs } from '@/lib/fsStorage';
import { pastConversationRefusal } from '@/lib/livingConversation';

export async function pastConversationRefusalFor(
  being: string,
  convoId: string,
): Promise<{ livingId: string; livingTitle: string } | null> {
  try {
    type Row = { id: string; folderName: string; title?: string; active?: boolean; corrupted?: boolean };
    const mine = (await listLogs() as Row[]).filter((l) => l.folderName === being);
    const folders = await listFolders() as Array<{ name: string; settings?: { testBed?: unknown } }>;
    const testBed = folders.find((f) => f.name === being)?.settings?.testBed === true;
    return pastConversationRefusal(mine, being, convoId, testBed);
  } catch {
    return null;
  }
}
