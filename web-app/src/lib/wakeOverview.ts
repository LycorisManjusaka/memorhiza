// Preferences → Runner: who can wake by themselves, and the one hand that stops
// it (つよ, 2026-11-16: "別に誰かを止めたいわけじゃないくてさぁ、逆よ？" —
// a brake that exists is what makes it safe to switch the rest on).
//
// Rules: wakeOverviewRules.ts. This file only reads and writes the disk.

import { listFolders, listLogs, loadLog, saveLog, writeBeingSettings } from '@/lib/fsStorage';
import { parseWakeSettings, WAKE_PURPOSE } from '@/lib/wakeSchedule';
import { readWakeState, latestActiveConversation, clearBookings } from '@/lib/wakeClock';
import { autoTriggerEnabled, setAutoTrigger } from '@/lib/autoTriggers';
import { pending, queuedConversations, removePendingItem } from '@/lib/turnQueue';
import { logContextElapsedPercent as elapsedOf } from '@/lib/autoHold';
import { logCapUnlimited } from '@/lib/handoverRestore';
import {
  canWakeByItself, overviewRow, sortOverview, stoppedWakeSettings,
  type WakeOverviewFacts, type WakeOverviewRow,
} from '@/lib/wakeOverviewRules';

type LogRow = { id: string; folderName: string; title?: string };

export async function wakeOverview(now = Date.now()): Promise<WakeOverviewRow[]> {
  const folders = await listFolders() as Array<{ name: string; settings?: Record<string, unknown> }>;
  const logs = await listLogs() as LogRow[];
  const rows: WakeOverviewRow[] = [];
  for (const f of folders) {
    const wake = parseWakeSettings(f.settings?.wake);
    const state = await readWakeState(f.name);
    const convoId = await latestActiveConversation(f.name);
    let stock = false;
    let log: Record<string, unknown> | null = null;
    if (convoId) {
      try { log = (await loadLog(convoId)) as Record<string, unknown> | null; } catch {}
      stock = autoTriggerEnabled(log?.autoTriggers, 'stock');
    }
    // The vessel a wake would actually run on: the conversation's own pick,
    // else the being's default — the same `||` turnInputFromLog uses.
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const model = str(log?.specificModel) ?? str(f.settings?.specificModel);
    const family = str(log?.aiName) ?? str(f.settings?.aiName);
    const facts: WakeOverviewFacts = {
      being: f.name,
      wake,
      bookings: state.bookings,
      stock,
      convoId,
      convoTitle: convoId ? (logs.find(l => l.id === convoId)?.title ?? null) : null,
      testBed: f.settings?.testBed === true,
      model,
      family,
      oauth: log?.claudeAuthMode === 'oauth',
      // A 0 cap has no ceiling, so there is no % to show.
      elapsedPct: log && !logCapUnlimited(f.settings?.maxConversationLog) ? elapsedOf(log, family, f.settings?.maxConversationLog) : null,
    };
    if (canWakeByItself(facts)) rows.push(overviewRow(facts, now));
  }
  return sortOverview(rows);
}

export interface StopReport {
  wakeSwitchedOff: boolean;
  bookingsCleared: number;
  stockSwitchedOff: string[];
  waitingWakesRemoved: number;
  errors: string[];
}

/**
 * Every way this being could start a turn by itself, off, at once:
 *   - timed wake, self-booking and mail wake switched off (the times are kept,
 *     so switching back on is one tick, not retyping)
 *   - pending self-bookings deleted
 *   - "stocked messages" off on EVERY conversation of the being that had it
 *     on (a test bed can be woken in any of them)
 *   - wakes already queued but not yet run (the being was busy) removed
 * A message a PERSON stocked is left alone: stopping self-turns is not
 * deleting someone's words.
 */
export async function stopSelfTurns(being: string): Promise<StopReport> {
  const report: StopReport = { wakeSwitchedOff: false, bookingsCleared: 0, stockSwitchedOff: [], waitingWakesRemoved: 0, errors: [] };
  const folders = await listFolders() as Array<{ name: string; settings?: Record<string, unknown> }>;
  const f = folders.find(x => x.name === being);
  if (!f) { report.errors.push(`no such being: ${being}`); return report; }

  try {
    await writeBeingSettings(being, { patch: { wake: stoppedWakeSettings(f.settings?.wake) } });
    report.wakeSwitchedOff = true;
  } catch (e) { report.errors.push(`settings: ${e instanceof Error ? e.message : String(e)}`); }

  try {
    report.bookingsCleared = (await readWakeState(being)).bookings.length;
    await clearBookings(being);
  } catch (e) { report.errors.push(`bookings: ${e instanceof Error ? e.message : String(e)}`); }

  for (const l of (await listLogs() as LogRow[]).filter(x => x.folderName === being)) {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const log = (await loadLog(l.id)) as Record<string, unknown> | null;
        if (!log || !autoTriggerEnabled(log.autoTriggers, 'stock')) break;
        const { updatedAt, ...rest } = log;
        // No `updatedAt` in the body: saveLog stamps a fresh version, so an open
        // tab sees the change instead of keeping its own copy.
        const r = await saveLog(l.id, { ...rest, autoTriggers: setAutoTrigger(log.autoTriggers, 'stock', false) },
          typeof updatedAt === 'number' ? { expectedUpdatedAt: updatedAt } : undefined);
        if (r.ok) { report.stockSwitchedOff.push(l.title || l.id); break; }
      }
    } catch (e) { report.errors.push(`${l.title || l.id}: ${e instanceof Error ? e.message : String(e)}`); }
  }

  try {
    for (const q of await queuedConversations(being)) {
      for (const it of await pending(being, q.convoId)) {
        if (it.kind === 'system' && (it.payload as { purpose?: unknown })?.purpose === WAKE_PURPOSE) {
          const r = await removePendingItem(being, q.convoId, it.id);
          if (r.ok) report.waitingWakesRemoved++;
        }
      }
    }
  } catch (e) { report.errors.push(`queue: ${e instanceof Error ? e.message : String(e)}`); }

  return report;
}
