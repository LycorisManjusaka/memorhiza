// OpenCode Go — a flat-rate subscription that serves Gemini 4 Argon on the
// native Gemini wire. Single source for: the routing prefix, the endpoint, the
// required headers, and reading the usage answer.
//
// Routing follows the DigitalOcean precedent: the provider lives in the model
// id as a prefix (`opencode/gemini-4-argon`), so there is one field and no
// second setting to drift out of sync with it. The prefix is a NEXUS routing
// tag only — it is stripped before the id reaches the provider or any
// capability table (bareModelId).
//
// MEASURED 2026-11-25 against this house's Go key (workspace/opencode_probe):
//   - base `https://opencode.ai/inference/go/google/v1beta`, generateContent and
//     streamGenerateContent both 200; `x-goog-api-key` accepted as auth.
//   - `x-opencode-session` is REQUIRED (400 MissingSessionID without it).
//   - no system-prompt overlay (prompt token counts equal direct Google's).
//   - tools, thinking levels, thought summaries, implicit cache all work.
//   - GET /v1/usage -> { usage: { rolling, weekly, monthly } }, each
//     { status, percent (integer), resetsAt }. No dollar figures.
//   - the only chat Gemini in the Go catalog is gemini-4-argon.
// NOT measured: behaviour at the limit, media parts, Google Search grounding,
// and what the 2026-12-01 price multiplier does to the percentages.

import type { UsageWindow, WindowView } from './claudeUsage';

export const OPENCODE_PREFIX = 'opencode/';
export const OPENCODE_GO_BASE = 'https://opencode.ai/inference/go';
/** What @google/genai needs as `httpOptions.baseUrl` (it appends /v1beta). */
export const OPENCODE_GO_GEMINI_BASE = `${OPENCODE_GO_BASE}/google`;
export const OPENCODE_GO_USAGE_URL = `${OPENCODE_GO_BASE}/v1/usage`;
/** The Gemini models Go serves for chat. One, as of the measured catalog. */
export const OPENCODE_GO_GEMINI_MODELS = ['gemini-4-argon'] as const;

export function isOpenCodeModel(id: string | undefined | null): boolean {
  return (id || '').toLowerCase().startsWith(OPENCODE_PREFIX);
}

/** The id without the routing prefix. Any other id comes back unchanged. */
export function bareModelId<T extends string | undefined | null>(id: T): T | string {
  if (typeof id !== 'string') return id;
  return isOpenCodeModel(id) ? id.slice(OPENCODE_PREFIX.length) : id;
}

/**
 * Headers every Go request must carry. The session id must be stable per
 * conversation; it is restricted to header-safe characters.
 */
export function openCodeGoHeaders(sessionSeed: string, appVersion = '0.1.0'): Record<string, string> {
  const safe = String(sessionSeed || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 96);
  return {
    'x-opencode-session': `nexus-${safe || 'session'}`,
    'User-Agent': `nexus/${appVersion}`,
  };
}

export interface GoUsageSnapshot {
  rolling?: UsageWindow;
  weekly?: UsageWindow;
  monthly?: UsageWindow;
  /** Epoch ms when NEXUS asked. */
  capturedAt: number;
}

function goWindow(raw: any): UsageWindow | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const p = raw.percent;
  if (typeof p !== 'number' || !Number.isFinite(p)) return undefined;
  let resetsAt: number | null = null;
  if (typeof raw.resetsAt === 'string') {
    const ms = Date.parse(raw.resetsAt);
    if (Number.isFinite(ms)) resetsAt = ms;
  } else if (typeof raw.resetsAt === 'number' && Number.isFinite(raw.resetsAt) && raw.resetsAt > 0) {
    resetsAt = raw.resetsAt < 1e12 ? raw.resetsAt * 1000 : raw.resetsAt;
  }
  return { utilization: p / 100, resetsAt };
}

/**
 * Read the /v1/usage answer (or our own stored copy of it). A window the
 * answer did not carry stays absent — it is never filled in as 0%.
 */
export function parseGoUsage(raw: unknown, capturedAt: number): GoUsageSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  // OpenCode wraps the three windows in { usage: {...} } (verbatim answer,
  // 2026-11-25, in workspace/opencode_probe/probe5_out.txt). Our own API route
  // sends them unwrapped with capturedAt. Both are read here.
  const top: any = raw;
  const r: any = top.usage && typeof top.usage === 'object' ? { ...top.usage, capturedAt: top.capturedAt } : top;
  const rolling = goWindow(r.rolling);
  const weekly = goWindow(r.weekly);
  const monthly = goWindow(r.monthly);
  if (!rolling && !weekly && !monthly) return null;
  const at = typeof r.capturedAt === 'number' && Number.isFinite(r.capturedAt) ? r.capturedAt : capturedAt;
  return { rolling, weekly, monthly, capturedAt: at };
}

/**
 * Start of the monthly window that ends at `resetsAt`: the same day-of-month
 * and time one calendar month earlier (the plan renews on the purchase date).
 * A day the earlier month does not have (31st -> 30-day month) clamps to that
 * month's last day.
 */
export function monthWindowStart(resetsAt: number): number {
  const end = new Date(resetsAt);
  const y = end.getUTCFullYear();
  const m = end.getUTCMonth();
  const lastDayPrev = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const day = Math.min(end.getUTCDate(), lastDayPrev);
  return Date.UTC(y, m - 1, day, end.getUTCHours(), end.getUTCMinutes(), end.getUTCSeconds(), end.getUTCMilliseconds());
}

export interface Pace { elapsedPct: number; ahead: boolean; catchUpAt: number | null }

/**
 * Even pace through a window that runs from `start` to the view's reset time.
 * Same rule as claudeUsage.weekPace, for any span. null when the window is not
 * live, has no reset time, or the span is not positive — no pace is invented.
 */
export function windowPace(v: WindowView, now: number, start: number): Pace | null {
  if (v.state !== 'live' || v.resetsAt === null) return null;
  const span = v.resetsAt - start;
  if (!(span > 0)) return null;
  const frac = Math.max(0, Math.min(1, (now - start) / span));
  const elapsedPct = Math.round(frac * 1000) / 10;
  const ahead = v.pct > elapsedPct;
  const catchUpAt = ahead ? Math.min(v.resetsAt, start + (v.pct / 100) * span) : null;
  return { elapsedPct, ahead, catchUpAt };
}
