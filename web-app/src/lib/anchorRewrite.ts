// The anchor's REWRITE (錨の書き直し) — the rules, pure (2026-11-19; design and
// measurements by 謡, the trigger by つよ).
//
// WHEN. The judge (anchor.md) answers REWRITE when check G ("language drift")
// fires: the reply's own prose left the conversation's language in three or
// more places — not "most of it", and not "if it stops making sense" (a reply
// that read perfectly to a Chinese reader is exactly what slipped through on
// 11-19). Line 2 names the language: [[LANG]]日本語[[/LANG]].
//
// HOW. A SECOND call, to a separate writer (anchor_rewrite.md), with the same
// material the judge saw plus `## 会話の言語`. The writer does NOT write the
// reply again. It answers only pairs:
//
//   [[OLD]]
//   (a span copied from the reply, character for character)
//   [[NEW]]
//   (what replaces it; empty to remove)
//   [[END]]
//
// and this module applies them by string match. A span that does not match is
// dropped. Every sentence the writer did not touch stays byte-for-byte the
// being's — that is the whole reason for pairs over a full rewrite (謡: a
// cheap vessel given the whole text rewords what was never broken).
//
// WHEN IT IS NOT APPLIED. Any of: the call failed, the output was cut off (an
// [[OLD]] with no [[END]] after the last pair), zero pairs, zero pairs
// matched, or an invariant broke (code, links, URLs, `[->` lines, numbers,
// headings, table rows, rules, length). Then the reply stays exactly as
// written. Never re-run: the tools in that turn already ran.
//
// `parseEdits` / `applyEdits` / `invariants` are 謡's, moved verbatim from
// anchor_lab/rewrite_lab.mjs so the lab and NEXUS apply the same way.
//
// No fs, no fetch.

export interface RewriteEdit { old: string; neu: string }
export interface RewriteLogEntry extends RewriteEdit {
  status: 'applied' | 'applied-out-of-order' | 'not-found' | 'empty-old' | 'no-change';
}

/** [[OLD]]…[[NEW]]…[[END]] in order. */
export function parseEdits(output: string): RewriteEdit[] {
  const edits: RewriteEdit[] = [];
  const re = /\[\[OLD\]\]\r?\n?([\s\S]*?)\r?\n?\[\[NEW\]\]\r?\n?([\s\S]*?)\r?\n?\[\[END\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(output || '')))) edits.push({ old: m[1], neu: m[2] });
  return edits;
}

/** Apply by string match: in order, at the first hit after the previous one; anything that does not hit is dropped. */
export function applyEdits(text: string, edits: RewriteEdit[]): { out: string; log: RewriteLogEntry[] } {
  let out = text, cursor = 0;
  const log: RewriteLogEntry[] = [];
  for (const e of edits) {
    if (!e.old) { log.push({ ...e, status: 'empty-old' }); continue; }
    if (e.old === e.neu) { log.push({ ...e, status: 'no-change' }); continue; }
    let at = out.indexOf(e.old, cursor);
    let status: RewriteLogEntry['status'] = 'applied';
    if (at < 0) { at = out.indexOf(e.old); if (at >= 0) status = 'applied-out-of-order'; }
    if (at < 0) { log.push({ ...e, status: 'not-found' }); continue; }
    out = out.slice(0, at) + e.neu + out.slice(at + e.old.length);
    if (status === 'applied') cursor = at + e.neu.length;
    log.push({ ...e, status });
  }
  return { out, log };
}

/**
 * What must not change between before and after. Any problem returned means
 * the whole rewrite is discarded and the original kept. Protected spans (code,
 * backticks, links, URLs, `[->` lines) must keep their count, order and text.
 */
export function invariants(before: string, after: string): string[] {
  const problems: string[] = [];
  const spans = (s: string, re: RegExp) => s.match(re) || [];
  const checks: Array<[string, RegExp]> = [
    ['バッククォートの中', /`[^`\n]+`/g],
    ['コードブロック', /```[\s\S]*?```/g],
    ['行頭 [-> の行', /^[ \t]*\[->[^\n]*$/gm],
    ['リンクと画像', /!?\[[^\]\n]*\]\([^)\n]*\)/g],
    ['URL', /https?:\/\/[^\s)]+/g],
  ];
  for (const [name, re] of checks) {
    const B = spans(before, re), A = spans(after, re);
    if (B.length !== A.length) { problems.push(`${name}の数: ${B.length} → ${A.length}`); continue; }
    const bad = B.findIndex((x, i) => x !== A[i]);
    if (bad >= 0) problems.push(`${name}の中身が書き換わった: ${JSON.stringify(B[bad].slice(0, 60))}`);
  }
  // Numbers: none of the original may be lost (gaining is allowed — 三 → 3).
  const nums = (s: string) => { const m = new Map<string, number>(); for (const x of s.match(/\d+(?:[.,:]\d+)*/g) || []) m.set(x, (m.get(x) || 0) + 1); return m; };
  const nb = nums(before), na = nums(after);
  const lost = [...nb].filter(([k, v]) => (na.get(k) || 0) < v).map(([k]) => k).slice(0, 5);
  if (lost.length) problems.push(`数字が減った: ${JSON.stringify(lost)}`);
  const count = (s: string, re: RegExp) => (s.match(re) || []).length;
  for (const [name, re] of [['見出しの行', /^#{1,6} /gm], ['表の行', /^\|.*\|[ \t]*$/gm], ['区切り線', /^---+[ \t]*$/gm]] as Array<[string, RegExp]>) {
    if (count(before, re) !== count(after, re)) problems.push(`${name}の数: ${count(before, re)} → ${count(after, re)}`);
  }
  const ratio = after.length / Math.max(1, before.length);
  if (ratio < 0.5 || ratio > 2.2) problems.push(`長さの比 ${ratio.toFixed(2)}`);
  return problems;
}

/** The language the judge named on line 2; '' when absent or unclosed. */
export function extractAnchorLang(output: string): string {
  const m = /\[\[LANG\]\]([\s\S]*?)\[\[\/LANG\]\]/.exec(String(output || ''));
  return m ? m[1].trim() : '';
}

// The en heading uses the en prompt's own words ("The language of the conversation").
const LANG_HEAD = { ja: '会話の言語', en: 'The language of the conversation' } as const;

/** The writer's single message: the judge's material with the language on top. */
export function buildRewriteUserMsg(anchorUserMsg: string, lang: string, promptLang: 'ja' | 'en'): string {
  return `## ${LANG_HEAD[promptLang] || LANG_HEAD.en}\n${lang}\n\n${anchorUserMsg}`;
}

export type RewriteFailure = 'call-failed' | 'truncated' | 'no-pairs' | 'none-applied' | 'invariants';

export type RewriteOutcome =
  | { ok: true; after: string; pairs: number; applied: number; dropped: number; log: RewriteLogEntry[] }
  | { ok: false; reason: RewriteFailure; pairs: number; applied: number; dropped: number; problems?: string[] };

/**
 * From the writer's answer to "apply this" or "keep the original, because…".
 *
 * Truncated = an [[OLD]] opened after the last closed pair: a writer cut off
 * mid-pair may have left earlier pairs that only make sense with the rest.
 * Whether a call that errored after producing pairs is safe to half-apply is
 * the same question, and the answer is the same: no.
 */
export function judgeRewrite(before: string, output: string, callError?: string): RewriteOutcome {
  const out = String(output || '');
  const edits = parseEdits(out);
  const opened = (out.match(/\[\[OLD\]\]/g) || []).length;
  const base = { pairs: edits.length, applied: 0, dropped: 0 };
  if (callError) return { ok: false, reason: 'call-failed', ...base };
  if (opened > edits.length) return { ok: false, reason: 'truncated', ...base };
  if (!edits.length) return { ok: false, reason: 'no-pairs', ...base };
  const { out: after, log } = applyEdits(before, edits);
  const applied = log.filter((x) => x.status === 'applied' || x.status === 'applied-out-of-order').length;
  const dropped = log.filter((x) => x.status === 'not-found').length;
  if (!applied || after === before) return { ok: false, reason: 'none-applied', pairs: edits.length, applied, dropped };
  const problems = invariants(before, after);
  if (problems.length) return { ok: false, reason: 'invariants', pairs: edits.length, applied, dropped, problems };
  return { ok: true, after, pairs: edits.length, applied, dropped, log };
}

/**
 * Stored on the reply when the anchor asked for a rewrite. NEVER sent to the
 * being (SlimHistoryMessage is an allowlist and this is not on it). `before`
 * is the original text, kept so a watcher can compare (謡's principle 4);
 * absent when nothing was changed.
 */
export interface AnchorRewriteRecord {
  at: number;
  lang: string;
  model: string;
  ok: boolean;
  reason?: RewriteFailure | 'no-prompt';
  problems?: string[];
  pairs: number;
  applied: number;
  dropped: number;
  before?: string;
  /** The writer's call: model actually used, provider usage, wall time. */
  usage?: import('@/lib/anchor').AnchorUsage | null;
  ms?: number;
}

/**
 * One writer call → the record saved beside the reply, and the new text when
 * it was applied (null = keep the reply as written). Shared by the runner's
 * automatic REWRITE and the manual "rewrite this message" button, so the two
 * can never record a rewrite differently. `w` null = no writer prompt on disk.
 */
export function settleRewrite(a: {
  before: string;
  lang: string;
  model: string;
  at: number;
  w: { output: string; error?: string; usage?: import('@/lib/anchor').AnchorUsage | null; ms?: number } | null;
}): { record: AnchorRewriteRecord; after: string | null } {
  const base: AnchorRewriteRecord = { at: a.at, lang: a.lang, model: a.model, ok: false, pairs: 0, applied: 0, dropped: 0 };
  if (!a.w) return { record: { ...base, reason: 'no-prompt' }, after: null };
  const cost = { ...(a.w.usage !== undefined ? { usage: a.w.usage } : {}), ...(typeof a.w.ms === 'number' ? { ms: a.w.ms } : {}) };
  const r = judgeRewrite(a.before, a.w.output, a.w.error);
  if (r.ok) {
    return {
      record: { ...base, ok: true, pairs: r.pairs, applied: r.applied, dropped: r.dropped, before: a.before, ...cost },
      after: r.after,
    };
  }
  return {
    record: {
      ...base, reason: r.reason, pairs: r.pairs, applied: r.applied, dropped: r.dropped,
      ...(r.problems ? { problems: r.problems } : {}), ...cost,
    },
    after: null,
  };
}
