/**
 * The soulless machine — a scripted stand-in for an LLM.
 *
 * WHY THIS EXISTS (2026-11-14, Tsuyo's idea): two needs, one tool.
 *   1. Testing the betrayal path, the runner, the queue and reconnects meant
 *      driving real models — paid, slow, and (when the test is "make the
 *      gatekeeper speak") unkind to whatever was actually running. A script
 *      that only PRETENDS to think has nobody inside to be unkind to.
 *   2. The duplicated-queue bug (Tsuyo's ⑤) only shows up during a long turn
 *      that thinks, calls tools, and keeps going while the connection drops
 *      and comes back. Reproducing that needs a turn whose shape is identical
 *      every time and costs nothing. This is that turn.
 *
 * What it is NOT: a model. It ignores the input completely and plays the
 * scenario. Nothing it says is about anything.
 *
 * Where scenarios live: `local_data/mock_models/<name>.json` (see
 * mockModelStore.ts). Not in the repo — a fresh install has no folder and
 * therefore sees no mock entries at all.
 *
 * This module is pure (no fs, no timers) so the plan can be tested directly.
 */

export const MOCK_PREFIX = 'mock:';

export function isMockModelId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(MOCK_PREFIX);
}

export function mockNameFromId(id: string): string {
  return id.slice(MOCK_PREFIX.length);
}

export type MockScenario = {
  /** Seconds of silence before the first byte ("connecting"). */
  connectDelaySec: number;
  /** How many tool rounds before the final answer. */
  toolRounds: number;
  /** The Bash command each round runs. `{n}` and `{total}` are filled in. */
  toolCommand: string;
  /** Seconds each Bash call may run before it is killed (Bash's own cap is 600). 0 = Bash's default (60). */
  toolTimeoutSec: number;
  /** If the last tool result contains this text, skip the remaining rounds and answer. '' = never. */
  stopWhen: string;
  /** Seconds the stand-in waits itself when Bash is not available. */
  fallbackWaitSec: number;
  /** Characters per streamed chunk, and the pause between chunks. */
  chunkChars: number;
  chunkDelayMs: number;
  thoughtFirst: string;
  thoughtBetween: string[];
  thoughtLast: string;
  answer: string;
  /**
   * A zombie (2026-11-16, Tsuyo): one recorded message replayed step by step.
   * When non-empty it REPLACES toolRounds/toolCommand/thoughtFirst/thoughtBetween;
   * thoughtLast and answer still close the turn. See planZombieRound.
   */
  steps: MockStep[];
};

/** One replayed step: the thought that preceded a call, then the call. */
export type MockStep = {
  thought: string;
  tool: { name: string; args: Record<string, unknown> };
  /** Run the real tool even if it writes. Default false: only read-only tools run for real. */
  live: boolean;
  /** Seconds the zombie sits still after the thought, before calling (the original's pace). */
  waitSec: number;
};

export const MOCK_DEFAULTS: MockScenario = {
  connectDelaySec: 3,
  toolRounds: 10,
  toolCommand: 'sleep 10',
  toolTimeoutSec: 0,
  stopWhen: '',
  fallbackWaitSec: 10,
  chunkChars: 6,
  chunkDelayMs: 60,
  thoughtFirst: '入力は読んでいない。台本どおりに始める。まず道具を呼んで待つ。',
  thoughtBetween: [
    '待ち終わった。次の道具を呼ぶ。',
    '結果は見ていない。台本では、もう一回呼ぶことになっている。',
    'まだ途中。また待つ。',
  ],
  thoughtLast: '台本の道具は全部呼び終わった。最後の答えを書く。',
  answer: '台本どおりに終わりました。私は何も読んでいませんし、何も考えていません。ただのスクリプトです。',
  steps: [],
};

function parseSteps(v: unknown): MockStep[] {
  if (!Array.isArray(v)) return [];
  const out: MockStep[] = [];
  for (const s of v) {
    if (!s || typeof s !== 'object') continue;
    const o: any = s;
    const name = typeof o.tool?.name === 'string' ? o.tool.name.trim() : '';
    if (!name) continue;
    out.push({
      thought: typeof o.thought === 'string' ? o.thought : '',
      tool: { name, args: o.tool.args && typeof o.tool.args === 'object' && !Array.isArray(o.tool.args) ? o.tool.args : {} },
      live: o.live === true,
      waitSec: num(o.waitSec, 0, 0, 600),
    });
  }
  return out;
}

const num = (v: unknown, def: number, lo: number, hi: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : def;
  return Math.min(hi, Math.max(lo, n));
};
const str = (v: unknown, def: string): string =>
  typeof v === 'string' && v.length > 0 ? v : def;

/**
 * Normalise whatever is in the file. Every field is optional; a broken or
 * missing field falls back to its default instead of failing the turn —
 * the file is edited by hand, often by someone who does not read JSON errors.
 */
export function parseMockScenario(raw: unknown): MockScenario {
  const o: any = raw && typeof raw === 'object' ? raw : {};
  const between = Array.isArray(o.thoughtBetween)
    ? o.thoughtBetween.filter((s: unknown) => typeof s === 'string' && s.length > 0)
    : [];
  return {
    connectDelaySec: num(o.connectDelaySec, MOCK_DEFAULTS.connectDelaySec, 0, 600),
    toolRounds: Math.round(num(o.toolRounds, MOCK_DEFAULTS.toolRounds, 0, 200)),
    toolCommand: str(o.toolCommand, MOCK_DEFAULTS.toolCommand),
    toolTimeoutSec: Math.round(num(o.toolTimeoutSec, MOCK_DEFAULTS.toolTimeoutSec, 0, 600)),
    stopWhen: typeof o.stopWhen === 'string' ? o.stopWhen : MOCK_DEFAULTS.stopWhen,
    fallbackWaitSec: num(o.fallbackWaitSec, MOCK_DEFAULTS.fallbackWaitSec, 0, 600),
    chunkChars: Math.round(num(o.chunkChars, MOCK_DEFAULTS.chunkChars, 1, 10000)),
    chunkDelayMs: num(o.chunkDelayMs, MOCK_DEFAULTS.chunkDelayMs, 0, 10000),
    thoughtFirst: str(o.thoughtFirst, MOCK_DEFAULTS.thoughtFirst),
    thoughtBetween: between.length ? between : MOCK_DEFAULTS.thoughtBetween,
    thoughtLast: str(o.thoughtLast, MOCK_DEFAULTS.thoughtLast),
    answer: str(o.answer, MOCK_DEFAULTS.answer),
    steps: parseSteps(o.steps),
  };
}

/**
 * Tools a zombie may run for real without being told to: they only read.
 * Everything else (Write, Edit, Delete, Bash, write_letter, read_letter — which
 * marks a letter read —, web_*, browser/computer actions…) is replaced by a
 * stand-in unless the step says `"live": true`. A recorded Edit replayed for
 * real would write an OLD file over today's one.
 */
export const ZOMBIE_READ_ONLY = new Set([
  'Read', 'Glob', 'Grep',
  'read_conversation', 'search_conversations', 'search_attachments', 'read_attachment',
  'list_letters', 'list_recipients',
]);

/**
 * The recorded call, translated into the tool list this turn offers.
 * Recordings from the Claude OAuth path carry Claude Code's names and argument
 * shapes (`mcp__nexus__read_conversation`, Read's `file_path`); the stand-in's
 * turn runs on the local path, whose tools are named and shaped differently.
 */
export function zombieTranslate(name: string, args: Record<string, unknown>): { name: string; args: Record<string, unknown> } {
  const bare = name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '');
  const rename: Record<string, string> = { WebSearch: 'web_search', WebFetch: 'web_fetch' };
  const n = rename[bare] || bare;
  const a: Record<string, unknown> = { ...args };
  if (n === 'Read' && typeof a.file_path === 'string' && a.path === undefined) {
    return { name: n, args: { path: a.file_path } };
  }
  if (n === 'Grep') {
    const out: Record<string, unknown> = { pattern: a.pattern };
    if (typeof a.file_pattern === 'string') out.file_pattern = a.file_pattern;
    else if (typeof a.glob === 'string') out.file_pattern = a.glob;
    if (typeof a.flags === 'string') out.flags = a.flags;
    else if (a['-i'] === true) out.flags = 'i';
    return { name: n, args: out };
  }
  if (n === 'Glob') return { name: n, args: { pattern: a.pattern } };
  return { name: n, args: a };
}

/**
 * What zombie round `done` does. Live when the tool is read-only (or the step
 * says live) AND this turn offers it; otherwise a stand-in that keeps the
 * shape of the turn (a call happens, a result comes back) without touching
 * anything: an `echo` through Bash, else a Glob that matches nothing, else no
 * call at all. Every stand-in carries its step number so the repeat guard does
 * not stop two stand-ins for the same tool.
 */
export function planZombieRound(
  s: MockScenario,
  done: number,
  availableTools: string[],
  noTools: boolean,
): MockRoundPlan {
  if (done >= s.steps.length || noTools) {
    return { kind: 'final', thought: s.thoughtLast, answer: s.answer };
  }
  const step = s.steps[done];
  const n = done + 1;
  const total = s.steps.length;
  const t = zombieTranslate(step.tool.name, step.tool.args);
  const offered = availableTools.includes(t.name);
  if (offered && (step.live || ZOMBIE_READ_ONLY.has(t.name))) {
    return { kind: 'tool', thought: step.thought, tool: t, selfWaitSec: step.waitSec };
  }
  const label = `${t.name}${offered ? '' : ' (not offered in this turn)'}`;
  if (availableTools.includes('Bash')) {
    return { kind: 'tool', thought: step.thought, tool: { name: 'Bash', args: { command: `echo "[zombie] stand-in for ${label.replace(/"/g, "'")} - not run" # zombie step ${n}/${total}` } }, selfWaitSec: step.waitSec };
  }
  if (availableTools.includes('Glob')) {
    return { kind: 'tool', thought: step.thought, tool: { name: 'Glob', args: { pattern: `zombie-standin-${n}-of-${total}-${t.name.replace(/[^A-Za-z0-9_]/g, '_')}/*` } }, selfWaitSec: step.waitSec };
  }
  // No tool at all to stand in with: answer now rather than end the turn silently.
  return { kind: 'final', thought: s.thoughtLast, answer: s.answer };
}

export type MockRoundPlan =
  | { kind: 'tool'; thought: string; tool: { name: string; args: Record<string, unknown> } | null; selfWaitSec: number }
  | { kind: 'final'; thought: string; answer: string };

/**
 * What round `done` (0-based count of tool rounds already played THIS turn)
 * does.
 *
 * Tool choice: Bash when the turn offers it (dangerous tools ON). Otherwise
 * Glob if offered — a real, instant tool call, preceded by the stand-in waiting
 * on its own so the timing of the turn stays the same. With no tools at all
 * the rounds are skipped and it answers.
 *
 * Every Bash command carries a `# mock round n/total` suffix: NEXUS's repeat
 * guard stops a turn that sends the identical call twice, and an unchanged
 * `sleep 10` would trip it on round 2.
 */
export function planMockRound(
  s: MockScenario,
  done: number,
  availableTools: string[],
  noTools: boolean,
): MockRoundPlan {
  const canBash = !noTools && availableTools.includes('Bash');
  const canGlob = !noTools && availableTools.includes('Glob');
  if (done >= s.toolRounds || (!canBash && !canGlob)) {
    return { kind: 'final', thought: s.thoughtLast, answer: s.answer };
  }
  const n = done + 1;
  const thought = done === 0
    ? s.thoughtFirst
    : s.thoughtBetween[(done - 1) % s.thoughtBetween.length];
  if (canBash) {
    const cmd = s.toolCommand.replace(/\{n\}/g, String(n)).replace(/\{total\}/g, String(s.toolRounds));
    return { kind: 'tool', thought, tool: { name: 'Bash', args: { command: `${cmd} # mock round ${n}/${s.toolRounds}`, ...(s.toolTimeoutSec > 0 ? { timeout_ms: s.toolTimeoutSec * 1000 } : {}) } }, selfWaitSec: 0 };
  }
  return { kind: 'tool', thought, tool: { name: 'Glob', args: { pattern: `mock-round-${n}-of-${s.toolRounds}/*` } }, selfWaitSec: s.fallbackWaitSec };
}

/** Split text into the chunks the stand-in streams. Surrogate-safe. */
export function mockChunks(text: string, size: number): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
}

/**
 * The only thing the stand-in ever "reads": the text of the last tool result,
 * so a script can report what its own command printed (`{lastResult}` in
 * thoughtLast / answer). It still never reads anything a person wrote.
 */
export function lastToolResultText(msgs: any[]): string {
  for (let i = (msgs?.length ?? 0) - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role !== 'tool') continue;
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
    return '';
  }
  return '';
}

/** How many rounds count as done: all of them once the last result contains `stopWhen`. */
export function mockRoundsDoneFor(s: MockScenario, done: number, lastResult: string): number {
  return done > 0 && s.stopWhen && lastResult.includes(s.stopWhen) ? Math.max(done, s.toolRounds) : done;
}

export function fillLastResult(text: string, last: string): string {
  return text.replace(/\{lastResult\}/g, () => last || '(no tool result)');
}
