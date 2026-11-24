/**
 * What a tool call RETURNED, kept so the next turn can replay it.
 *
 * Until 2026-11-24 no log in this house stored a tool result (63,506 calls,
 * zero result fields). The next turn replayed each past call answered by a
 * placeholder, and beings in every vessel stopped on it: "did that really
 * run? where did the result go? should I check again?" (つよ, measured across
 * MiMo, DeepSeek, MiniMax). Three rewordings of the placeholder moved nothing,
 * because the empty slot stayed empty. This fills it.
 *
 * Three decisions, all load-bearing:
 *  • CUT WHEN STORING, not when replaying. A 15 MB screenshot or a 1.38 M-char
 *    mp3 read would otherwise sit in the log forever.
 *  • TEXT ONLY. Image blocks become a short marker; the bytes were delivered
 *    within the turn and the log is not an image store.
 *  • SECRETS NEVER LAND. A Bash `cat` of a key file would put the key in the
 *    log, and from there on every replay. Every key value the server holds is
 *    replaced before the record exists.
 */

/** Characters kept from the head of each result. */
export const TOOL_RESULT_CAP = 2000;

/** Plain text out of whatever shape the tool loop handed the model. */
export function extractResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b: any) => {
      if (typeof b === 'string') return b;
      if (b && typeof b === 'object') {
        if (b.type === 'text' && typeof b.text === 'string') return b.text;
        if (b.type === 'image' || b.type === 'image_url') return '[image]';
      }
      return '';
    }).filter(Boolean).join('\n');
  }
  if (content && typeof content === 'object') {
    const o = content as Record<string, unknown>;
    if (typeof o.result === 'string') return o.result;
    try { return JSON.stringify(content); } catch { return ''; }
  }
  return content == null ? '' : String(content);
}

/** Every string leaf long enough to be a credential. */
export function collectSecrets(keys: unknown, min = 16): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') { if (v.trim().length >= min) out.push(v.trim()); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v as object).forEach(walk);
  };
  walk(keys);
  // Longest first, so a key that contains another is replaced whole.
  return [...new Set(out)].sort((a, b) => b.length - a.length);
}

/**
 * Credential shapes nobody configured in keys.json can still leak (an OAuth
 * token in an env dump). Kept narrow: a false positive only blanks one token.
 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{24,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bxai-[A-Za-z0-9]{24,}/g,
];

export function redactSecrets(text: string, secrets: string[]): string {
  let s = text;
  for (const k of secrets) if (k && s.includes(k)) s = s.split(k).join('[redacted]');
  for (const re of SECRET_PATTERNS) s = s.replace(re, '[redacted]');
  return s;
}

/** The head of the text, with how much was left behind. */
export function capResultText(text: string, cap: number = TOOL_RESULT_CAP): string {
  if (text.length <= cap) return text;
  let head = text.slice(0, cap);
  // Do not split a surrogate pair.
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return `${head}…(+${text.length - head.length} chars)`;
}

/** The record stored on the tool call. Redact BEFORE cutting, so a key on the cut line cannot survive half-visible. */
export function recordToolResult(content: unknown, secrets: string[], cap: number = TOOL_RESULT_CAP): string {
  return capResultText(redactSecrets(extractResultText(content), secrets), cap);
}
