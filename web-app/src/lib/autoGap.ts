// The minimum interval between AUTOMATIC turns of one being (トカゲくん, 2026-11-28).
//
// MEASURED on the work PC that morning: two beings, both waking on stocked
// messages and both allowed `[->name]`, played chess from 09:00 to 09:42 —
// 33 pairs each, 132 messages — and spent a whole 5-hour window. Nothing had
// limited that on purpose ("catch it in practice"); this is the limit.
//
// The rule: a turn NOBODY ASKED FOR (a wake — timed, self-booked, mail — or a
// stock that starts by itself, whoever stocked it) does not start until the
// interval has passed since this being's previous such turn ENDED. Nothing is
// discarded: the items stay in the stock and run when the interval is over.
//
// NOT delayed, and NOT counted as "the previous automatic turn": a message a
// person sends, "run it now", regenerate/continue, ζ. Each has a hand behind it.
//
// The setting is the one that used to bound only self-bookings. It stays where
// it is ON DISK (`settings.wake.self.minGapMin`; null = off; absent = 15) —
// renaming a stored key silently resets it on every other install — and still
// bounds bookings and mail wakes as before. Only its place on screen and its
// reach changed.
//
// State: `wake/auto_turn/<being>.json`, one small file with one writer shape.
// Kept apart from the wake state file on purpose: that one is read-modify-
// written under an in-process lock, and a stock pass may run on the OTHER
// installation sharing this store.

import fs from 'fs/promises';
import path from 'path';
import { DATA_DIR } from '@/lib/beingPaths';
import { atomicWriteFile } from '@/lib/atomicWrite';
import { parseWakeSettings } from '@/lib/wakeSchedule';

/** The interval in minutes from a being's stored settings; null = off. */
export function autoGapMinFromSettings(beingSettings: Record<string, unknown> | null | undefined): number | null {
  const gap = parseWakeSettings(beingSettings?.wake).self.minGapMin;
  return gap !== null && gap > 0 ? gap : null;
}

/**
 * Milliseconds still to wait before an automatic turn may start. 0 = go.
 *
 * A `lastAt` in the future (a clock stepped back, a hand-edited file) is read
 * as "just now": the wait is never longer than the interval itself.
 */
export function autoGapRemainingMs(gapMin: number | null, lastAt: number | null | undefined, now: number): number {
  if (gapMin === null || !(gapMin > 0)) return 0;
  if (typeof lastAt !== 'number' || !Number.isFinite(lastAt)) return 0;
  const last = Math.min(lastAt, now);
  return Math.max(0, last + gapMin * 60_000 - now);
}

export interface AutoGapStatus {
  /** null = the interval is off for this being. */
  minGapMin: number | null;
  /** When the previous automatic turn started or ended, whichever is later. */
  lastAt: number | null;
  remainingMs: number;
  /** now + remainingMs; null when nothing is being waited for. */
  readyAt: number | null;
}

export function autoGapStatus(gapMin: number | null, lastAt: number | null, now: number): AutoGapStatus {
  const remainingMs = autoGapRemainingMs(gapMin, lastAt, now);
  return { minGapMin: gapMin, lastAt, remainingMs, readyAt: remainingMs > 0 ? now + remainingMs : null };
}

// ── Disk ────────────────────────────────────────────────────────────────────

function safeName(being: string) { return being.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_'); }
function filePath(being: string, dataDir = DATA_DIR) { return path.join(dataDir, 'wake', 'auto_turn', `${safeName(being)}.json`); }

export async function readLastAutoTurn(being: string, dataDir = DATA_DIR): Promise<number | null> {
  try {
    const p = JSON.parse(await fs.readFile(filePath(being, dataDir), 'utf-8'));
    return typeof p?.at === 'number' && Number.isFinite(p.at) ? p.at : null;
  } catch { return null; }
}

/**
 * Called when an automatic turn STARTS (so a second kick in the same instant
 * is already spaced) and again when it ENDS (so the interval is counted from
 * the end). Never throws: failing to note the time must not fail a turn.
 */
export async function recordAutoTurn(being: string, convoId: string, phase: 'start' | 'end', now = Date.now(), dataDir = DATA_DIR): Promise<void> {
  try {
    const p = filePath(being, dataDir);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await atomicWriteFile(p, JSON.stringify({ at: now, convoId, phase }, null, 2));
  } catch (e) {
    console.warn(`[auto-gap] could not record the automatic turn of ${being}:`, e);
  }
}

export async function autoGapStatusFor(being: string, beingSettings: Record<string, unknown> | null | undefined, now = Date.now(), dataDir = DATA_DIR): Promise<AutoGapStatus> {
  const gap = autoGapMinFromSettings(beingSettings);
  return autoGapStatus(gap, gap === null ? null : await readLastAutoTurn(being, dataDir), now);
}
