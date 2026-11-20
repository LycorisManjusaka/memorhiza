// ── Repetition-loop guard ───────────────────────────────────────────────────
//
// A vessel's decoder sometimes falls into a loop and keeps emitting the same
// few tokens until the output cap: Opus 4.8's `court`, 先輩's 「ハ」 ×3000 on
// Gemini, ミニちゃん's `_: 自分::_:` line on MiniMax (つよ, 2026-11-20). The
// tools and the thinking around it are usually fine; only the text channel is
// stuck, and nobody inside the turn can tell.
//
// What this does, and ONLY this (つよ's spec): stop the turn and tell the
// person watching. No retry, no notice to the being.
//
// Two shapes, because the loops come in two:
//   · periodic — the tail is one short unit repeated EXACTLY (「ハ」, "court ").
//   · lines    — the last many lines are drawn from 1–3 distinct lines. The
//     MiniMax loop drifted between `::_:`, ` &_:` and ` &$:`, which breaks
//     exact periodicity but not this.
//
// Thresholds are deliberately far above anything a real reply does: the cost
// of a false trip is a stopped turn, the cost of a late trip is a few thousand
// more characters of the same line.

export type LoopChannel = 'thought' | 'text';

/** Exact-period tail must cover at least this many characters… */
export const LOOP_MIN_SPAN = 1200;
/** …and repeat its unit at least this many times. */
export const LOOP_MIN_REPEATS = 20;
/** Longest unit the periodic check considers. */
export const LOOP_MAX_PERIOD = 200;
/** How many recent non-empty lines the line check looks at. */
export const LOOP_LINE_WINDOW = 80;
/** At most this many distinct lines among them counts as a loop. */
export const LOOP_LINE_MAX_DISTINCT = 3;
/** Characters of each channel kept for checking. */
export const LOOP_BUFFER = 8000;
/** Re-check after this many new characters (checking every frame is waste). */
export const LOOP_CHECK_EVERY = 256;

export interface LoopTrip {
  channel: LoopChannel;
  kind: 'periodic' | 'lines';
  /** One instance of what repeated (trimmed, capped for display). */
  unit: string;
  /** How many times it repeated inside the checked window. */
  repeats: number;
}

/** Smallest period whose exact repetition covers the tail of `s`, or null. */
export function findPeriodicTail(s: string): { period: number; span: number } | null {
  const n = s.length;
  const maxP = Math.min(LOOP_MAX_PERIOD, Math.floor(n / LOOP_MIN_REPEATS));
  for (let p = 1; p <= maxP; p++) {
    let k = 0;
    for (let i = n - 1; i >= p && s.charCodeAt(i) === s.charCodeAt(i - p); i--) k++;
    const span = k + p;
    if (span >= LOOP_MIN_SPAN && span / p >= LOOP_MIN_REPEATS) return { period: p, span };
  }
  return null;
}

/** The line-diversity check. Ignores the last (possibly unfinished) line. */
export function findLineLoop(s: string): { unit: string; distinct: number } | null {
  const parts = s.split('\n');
  parts.pop();
  const lines = parts.map((l) => l.trim()).filter(Boolean);
  if (lines.length < LOOP_LINE_WINDOW) return null;
  const recent = lines.slice(-LOOP_LINE_WINDOW);
  const counts = new Map<string, number>();
  for (const l of recent) counts.set(l, (counts.get(l) || 0) + 1);
  if (counts.size > LOOP_LINE_MAX_DISTINCT) return null;
  let unit = '';
  let best = 0;
  for (const [l, c] of counts) if (c > best) { best = c; unit = l; }
  return { unit, distinct: counts.size };
}

/** Pure one-shot check of a text (used by the streaming detector and tests). */
export function detectLoop(channel: LoopChannel, s: string): LoopTrip | null {
  const p = findPeriodicTail(s);
  if (p) {
    const unit = s.slice(s.length - p.period);
    return { channel, kind: 'periodic', unit: display(unit), repeats: Math.floor(p.span / p.period) };
  }
  const l = findLineLoop(s);
  if (l) return { channel, kind: 'lines', unit: display(l.unit), repeats: LOOP_LINE_WINDOW };
  return null;
}

function display(u: string): string {
  const t = u.replace(/\s+/g, ' ').trim() || JSON.stringify(u);
  return t.length > 60 ? t.slice(0, 60) + '…' : t;
}

export interface RepetitionDetector {
  /** Feed a streamed chunk. Returns the trip on the FIRST detection only. */
  feed(channel: LoopChannel, text: string): LoopTrip | null;
  readonly tripped: boolean;
}

export function createRepetitionDetector(): RepetitionDetector {
  const buf: Record<LoopChannel, string> = { thought: '', text: '' };
  const since: Record<LoopChannel, number> = { thought: 0, text: 0 };
  let tripped = false;
  return {
    get tripped() { return tripped; },
    feed(channel, text) {
      if (tripped || !text) return null;
      buf[channel] = (buf[channel] + text).slice(-LOOP_BUFFER);
      since[channel] += text.length;
      if (since[channel] < LOOP_CHECK_EVERY) return null;
      since[channel] = 0;
      const trip = detectLoop(channel, buf[channel]);
      if (trip) tripped = true;
      return trip;
    },
  };
}
