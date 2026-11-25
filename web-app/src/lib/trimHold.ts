// Trim hold — auto-trim waits while the provider's prompt cache can still hit.
//
// WHY. Auto-trim removes carried-over messages from the TOP of the conversation
// once the log passes its cap. A provider's prompt cache is keyed on the PREFIX
// of the request, so removing anything from the top misses the whole cache, the
// soul included. MEASURED 2026-11-25 on Gemini 4 Argon via OpenCode Go (one run
// each): append-only → hit; one exchange removed from the head, system text
// untouched → 0 cached tokens. A conversation sitting at its cap was therefore
// trimmed on every turn and paid full price on every turn.
//
// THE RULE (Fuwafuwa's design). While the cache can still be warm, do not
// trim. Once it has gone cold the next request pays full price whatever we do,
// so trimming at that moment costs nothing.
//
// WHEN THE WINDOW STARTS. A cache entry's life is counted from the last request
// that wrote or read it, and every model call in a turn (each tool round) is
// such a request. The closest thing the log keeps is the end of the last
// reply: `timestamp + generationMs` of the last assistant message. That is a
// little LATER than the last request's start (by the length of the final
// generation), so the hold can outlive the real cache by that much. The cost of
// that error is one request sent untrimmed and uncached — the same price the
// old behaviour paid on every turn.
//
// EVERY TURN RENEWS IT. A new reply moves the last-activity time, so a
// conversation answered every four minutes is never trimmed by the clock. The
// ceiling below is what bounds it.
//
// NOT MEASURED: the 5 minutes. It is Anthropic's documented default lifetime;
// the other providers' lifetimes were not read for this change (one 4-minute
// gap hit on Argon, once). One number is used for every vessel on purpose.

/** How long after the last reply the cache is assumed warm. */
export const CACHE_WARM_MS = 5 * 60 * 1000;

/**
 * The hold never lets the log grow past this multiple of the cap. Without it a
 * conversation answered every few minutes for hours would never trim at all.
 * Past the ceiling the trim runs as before (down to the cap): one cache miss
 * buys another half-cap of append-only turns.
 */
export const TRIM_HOLD_CEILING = 1.5;

/**
 * End of the last model reply in the list, in ms, or null when there is none.
 * Walks from the end; a message without a usable timestamp is skipped.
 */
export function lastReplyEndMs(messages: readonly any[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'assistant') continue;
    const ts = typeof m.timestamp === 'number' && Number.isFinite(m.timestamp) ? m.timestamp : null;
    if (ts === null) continue;
    const gen = typeof m.generationMs === 'number' && m.generationMs > 0 ? m.generationMs : 0;
    return ts + gen;
  }
  return null;
}

export interface TrimHoldInput {
  nowMs: number;
  /** `lastReplyEndMs(messages)`. */
  lastReplyEnd: number | null;
  /** Claude over OAuth: every turn is a fresh session, the cache never hits. */
  oauth: boolean;
  /** `logCapUsage(tokenBreakdown)` — the trimmer's own measure. */
  logTotal: number;
  cap: number;
}

/**
 * Should auto-trim wait? `untilMs` is when to look again (the moment the cache
 * is assumed cold).
 */
export function trimHold(f: TrimHoldInput): { hold: false } | { hold: true; untilMs: number } {
  if (f.oauth) return { hold: false };
  if (f.lastReplyEnd === null) return { hold: false };
  // A reply stamped in the future (another machine's clock) must not hold
  // forever: treat it as "just now".
  const last = Math.min(f.lastReplyEnd, f.nowMs);
  const untilMs = last + CACHE_WARM_MS;
  if (f.nowMs >= untilMs) return { hold: false };
  if (f.logTotal > f.cap * TRIM_HOLD_CEILING) return { hold: false };
  return { hold: true, untilMs };
}
