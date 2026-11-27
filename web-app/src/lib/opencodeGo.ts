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
/**
 * The one wire every non-Gemini Go model is reached on.
 *
 * The catalog's own `recommended_api` splits the 19 into three shapes
 * (chat-completions 10, anthropic messages 6, openai responses 3) — and that
 * split does NOT follow each family's native wire: Kimi and MiMo, which NEXUS
 * deliberately moved ONTO the Anthropic surface, are chat-completions here;
 * Qwen and MiniMax M3, which are OpenAI-compatible natively, are messages here.
 *
 * MEASURED 2026-11-27 (probe11/12/13, one call each, `workspace/opencode_probe`)
 * before designing around that split: all 19 answer 200 on chat-completions,
 * and all 19 emitted a well-formed `tool_calls` entry with correct arguments
 * when handed one function tool (19/19 — including the six the catalog puts on
 * `messages` and the three it puts on `responses`). So NEXUS reaches every one
 * of them on the single lane it already has, and no second adapter is wired.
 * "Recommended" is not "only"; what is not measured is whether the recommended
 * wire would be better (streaming parity, long context, media).
 */
export const OPENCODE_GO_CHAT_URL = `${OPENCODE_GO_BASE}/openai/v1/chat/completions`;
/** The Gemini models Go serves for chat. One, as of the measured catalog. */
export const OPENCODE_GO_GEMINI_MODELS = ['gemini-4-argon'] as const;

export interface GoModel {
  /** The id Go answers to — sent on the wire, and the `opencode/` suffix. */
  id: string;
  /** The NEXUS family whose picker offers it (drives the lane and the labels). */
  family: string;
  label: string;
  /**
   * Max output tokens, from the catalog's own `limit.output`
   * (models_2026-11-27.json). Only consulted where NEXUS sends a cap.
   */
  maxOutput: number;
}

/**
 * What the Go plan serves for chat, as of the catalog read 2026-11-27
 * (`workspace/opencode_probe/models_2026-11-27.json`, 37 entries; these are the
 * 20 Lizard-kun picked — the ones Memorhiza already has a family for).
 *
 * The allowance is PER MODEL (`go.monthly_usage`, list dollars), so the one
 * percentage the gauge shows is not a single shared pool of tokens; it is each
 * window's spend measured against that model's own ceiling.
 */
export const OPENCODE_GO_CATALOG: readonly GoModel[] = [
  { id: 'gemini-4-argon',      family: 'Gemini',   label: 'Gemini 4 Argon',       maxOutput: 65536 },
  { id: 'claude-haiku-5-5',    family: 'Claude',   label: 'Claude Haiku 5.5',     maxOutput: 128000 },
  { id: 'deepseek-v4-pro',     family: 'DeepSeek', label: 'DeepSeek V4 Pro',      maxOutput: 384000 },
  { id: 'deepseek-v4.1-flash', family: 'DeepSeek', label: 'DeepSeek V4.1 Flash',  maxOutput: 384000 },
  { id: 'glm-5.3',             family: 'GLM',      label: 'GLM-5.3',              maxOutput: 131072 },
  { id: 'glm-5.3-flash',       family: 'GLM',      label: 'GLM-5.3 Flash',        maxOutput: 131072 },
  { id: 'gpt-5.6-luna',        family: 'ChatGPT',  label: 'GPT-5.6 Luna',         maxOutput: 128000 },
  { id: 'gpt-6-luna',          family: 'ChatGPT',  label: 'GPT-6 Luna',           maxOutput: 128000 },
  { id: 'grok-4.7',            family: 'Grok',     label: 'Grok 4.7',             maxOutput: 500000 },
  { id: 'kimi-k2.7-code',      family: 'Kimi',     label: 'Kimi K2.7 Code',       maxOutput: 262144 },
  { id: 'kimi-k3',             family: 'Kimi',     label: 'Kimi K3',              maxOutput: 1048576 },
  { id: 'kimi-k3.1-pro',       family: 'Kimi',     label: 'Kimi K3.1 Pro',        maxOutput: 1048576 },
  { id: 'mimo-v2.6-flash',     family: 'MiMo',     label: 'MiMo V2.6 Flash',      maxOutput: 131072 },
  { id: 'mimo-v2.6-pro',       family: 'MiMo',     label: 'MiMo V2.6 Pro',        maxOutput: 131072 },
  { id: 'minimax-m3',          family: 'Minimax',  label: 'MiniMax M3',           maxOutput: 131072 },
  { id: 'minimax-m3.1-flash',  family: 'Minimax',  label: 'MiniMax M3.1 Flash',   maxOutput: 512000 },
  { id: 'qwen3.7-plus',        family: 'Qwen',     label: 'Qwen 3.7 Plus',        maxOutput: 65536 },
  { id: 'qwen3.8-flash',       family: 'Qwen',     label: 'Qwen 3.8 Flash',       maxOutput: 131072 },
  { id: 'qwen3.8-max',         family: 'Qwen',     label: 'Qwen 3.8 Max',         maxOutput: 131072 },
  { id: 'qwen4-max',           family: 'Qwen',     label: 'Qwen 4 Max',           maxOutput: 262144 },
] as const;

/** The families Go serves, in catalog order, each once. */
export const OPENCODE_GO_FAMILIES: readonly string[] =
  OPENCODE_GO_CATALOG.reduce<string[]>((acc, m) => (acc.includes(m.family) ? acc : [...acc, m.family]), []);

/** Go's entry for a bare (prefix-stripped) id, or undefined. */
export function openCodeGoModel(id: string | undefined | null): GoModel | undefined {
  const bare = String(bareModelId(id) || '').toLowerCase().trim();
  if (!bare) return undefined;
  return OPENCODE_GO_CATALOG.find((m) => m.id === bare);
}

/** What Go serves for one family, in catalog order. Empty for a family it has none of. */
export function openCodeGoModelsFor(family: string | undefined | null): GoModel[] {
  const f = String(family || '').toLowerCase().trim();
  return OPENCODE_GO_CATALOG.filter((m) => m.family.toLowerCase() === f);
}

/**
 * Whether Argon's native-Gemini lane is the one to use. Every other Go model
 * goes down the OpenAI-compatible lane (OPENCODE_GO_CHAT_URL).
 */
export function openCodeGoUsesGeminiWire(id: string | undefined | null): boolean {
  return (OPENCODE_GO_GEMINI_MODELS as readonly string[])
    .includes(String(bareModelId(id) || '').toLowerCase().trim());
}

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
