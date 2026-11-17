// "Hold automatic turns once the context is at 100%" (つよ, 2026-11-17).
//
// Past 100% the oldest exchanges are already leaving the verbatim transcript.
// A person looking at the gauge decides when to sleep; a turn that starts by
// itself has nobody looking. So every turn nobody asked for — a wake (timed,
// self-booked, mail) and a stock that starts by itself — WAITS while the
// conversation is full. Nothing is discarded: stocked messages stay in the
// stock, and a wake that is due simply does not fire (same as a slot missed
// while NEXUS was stopped).
//
// NOT held: a message a person sends, "run it now", regenerate/continue, and
// the ζ turn — each of those has a hand behind it.
//
// Stored on the CONVERSATION (`autoStopAtFull`), next to `autoTriggers`.
// Absent = ON: an install that never saw this switch is protected.

import { makeIsOriginalIndex } from '@/lib/firstOriginal';
import { messageTextTokens, contextElapsedPercent, DEFAULT_MAX_CONVERSATION_LOG } from '@/lib/handoverRestore';
import { WAKE_PURPOSE } from '@/lib/wakeSchedule';

export function autoStopAtFullEnabled(raw: unknown): boolean {
  return raw !== false;
}

/**
 * The conversation's "context elapsed" %, the same number its header gauge
 * shows: NEW (non-copied) message text over the being's log cap, measured with
 * the gauge's own functions and the same family argument. A stored log has no
 * optimistic landing message, so a pending boundary reads as 0 — exactly what
 * the gauge shows on a freshly slept conversation before anyone writes.
 */
export function logContextElapsedPercent(log: Record<string, unknown>, family: string | null, capRaw: unknown): number {
  const messages = Array.isArray(log.messages) ? log.messages as Array<{ id?: string }> : [];
  const isOrig = makeIsOriginalIndex(
    { firstOriginalMessageId: log.firstOriginalMessageId as string | undefined, firstOriginalIsNext: log.firstOriginalIsNext as boolean | undefined },
    messages,
  );
  let original = 0;
  messages.forEach((m, i) => { if (isOrig(i)) original += messageTextTokens(m, family); });
  const cap = typeof capRaw === 'number' && Number.isFinite(capRaw) ? capRaw : DEFAULT_MAX_CONVERSATION_LOG;
  return contextElapsedPercent({ original }, cap);
}

/** The one rule, on numbers — the tab asks it with the gauge's own reading. */
export function autoTurnsHeld(switchRaw: unknown, elapsedPct: number): boolean {
  return autoStopAtFullEnabled(switchRaw) && elapsedPct >= 100;
}

/** The same rule for a log read from disk (the runner and the clock). */
export function autoTurnsHeldForLog(
  log: Record<string, unknown> | null | undefined,
  beingSettings: Record<string, unknown> | null | undefined,
): boolean {
  if (!log) return false;
  if (!autoStopAtFullEnabled(log.autoStopAtFull)) return false;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const family = str(log.aiName) ?? str(beingSettings?.aiName);
  return autoTurnsHeld(log.autoStopAtFull, logContextElapsedPercent(log, family, beingSettings?.maxConversationLog));
}

/** A queued item that is a wake (not ζ, which shares `kind: 'system'`). */
export function isWakeItem(it: { kind?: unknown; payload?: unknown }): boolean {
  return it.kind === 'system' && (it.payload as { purpose?: unknown } | undefined)?.purpose === WAKE_PURPOSE;
}

/**
 * Does this pass start a turn nobody asked for?
 *  · `auto` — a stock starting by itself;
 *  · `wake` — the clock's own kick, or the follow-up after a finished turn
 *    when the system items left waiting are all wakes.
 */
export function passIsUnattended(flags: { auto: boolean; wake: boolean }): boolean {
  return flags.auto || flags.wake;
}
