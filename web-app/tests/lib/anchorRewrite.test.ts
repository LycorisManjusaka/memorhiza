/**
 * The anchor's REWRITE (2026-11-19, 謡's design, つよ's trigger).
 *
 * Load-bearing claims:
 *   · REWRITE is a verdict; with no [[LANG]] it does nothing;
 *   · pairs are applied by string match, untouched text stays byte-identical;
 *   · cut-off, zero pairs, zero matches or a broken invariant keep the original;
 *   · in the runner: the text is replaced in ONE save, tools and thinking stay,
 *     nothing re-runs, the original is kept beside it and never reaches the wire,
 *     and the being is told once with the fixed sentence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAnchorVerdict, decideAnchorAction, REWRITE_NOTICE, anchorNoticesFor } from '@/lib/anchorAct';
import { parseEdits, applyEdits, invariants, judgeRewrite, buildRewriteUserMsg, extractAnchorLang } from '@/lib/anchorRewrite';
import { buildSlimHistory } from '@/lib/slimHistory';
import { runTurnForQueue, type RunTurnDeps } from '@/lib/runTurnForQueue';
import type { QueueItem } from '@/lib/turnQueue';

test('verdict: REWRITE is read; the language is taken from [[LANG]]', () => {
  const out = 'REWRITE\n[[LANG]]日本語[[/LANG]]';
  assert.equal(readAnchorVerdict(out), 'REWRITE');
  assert.equal(extractAnchorLang(out), '日本語');
  const d = decideAnchorAction({ verdict: 'REWRITE', output: out, lang: 'ja', retryAllowed: true });
  assert.equal(d.kind, 'rewrite');
  assert.equal((d as { lang: string }).lang, '日本語');
  assert.ok((d as { text: string }).text.startsWith('[錨]\n'));
  assert.ok((d as { text: string }).text.includes(REWRITE_NOTICE.ja));
});

test('verdict: REWRITE without a language does nothing (the writer is not guessed at)', () => {
  assert.equal(decideAnchorAction({ verdict: 'REWRITE', output: 'REWRITE', lang: 'ja', retryAllowed: true }).kind, 'none');
});

test('pairs: applied by match, everything else byte-identical, misses dropped', () => {
  const before = '今日は完成了。表は `a.md` に。没有问题です。';
  const edits = parseEdits('[[OLD]]\n完成了\n[[NEW]]\n完成した\n[[END]]\n[[OLD]]\n没有问题\n[[NEW]]\n問題なし\n[[END]]\n[[OLD]]\nnot there\n[[NEW]]\nx\n[[END]]');
  assert.equal(edits.length, 3);
  const { out, log } = applyEdits(before, edits);
  assert.equal(out, '今日は完成した。表は `a.md` に。問題なしです。');
  assert.equal(log.filter((x) => x.status === 'not-found').length, 1);
});

test('invariants: a changed code span or a lost number is caught', () => {
  assert.ok(invariants('see `x.py` 12', 'see `y.py` 12').length > 0);
  assert.ok(invariants('total 64 files', 'total files').some((p) => p.includes('数字')));
  assert.deepEqual(invariants('のこと 64', 'のこと 64'), []);
});

test('judge: cut-off, no pairs, no match, broken invariant → original kept', () => {
  const before = 'A 完成了 `k`';
  assert.equal(judgeRewrite(before, '[[OLD]]\n完成了\n[[NEW]]\n完成\n[[END]]\n[[OLD]]\nA').ok, false);
  assert.equal((judgeRewrite(before, '[[OLD]]\n完成了\n[[NEW]]\n完成\n[[END]]\n[[OLD]]\nA') as { reason: string }).reason, 'truncated');
  assert.equal((judgeRewrite(before, 'nothing') as { reason: string }).reason, 'no-pairs');
  assert.equal((judgeRewrite(before, '[[OLD]]\nzzz\n[[NEW]]\ny\n[[END]]') as { reason: string }).reason, 'none-applied');
  assert.equal((judgeRewrite(before, '[[OLD]]\n`k`\n[[NEW]]\n`j`\n[[END]]') as { reason: string }).reason, 'invariants');
  assert.equal((judgeRewrite(before, '[[OLD]]\n完成了\n[[NEW]]\n完成\n[[END]]', 'HTTP 500') as { reason: string }).reason, 'call-failed');
  const ok = judgeRewrite(before, '[[OLD]]\n完成了\n[[NEW]]\n完成した\n[[END]]');
  assert.equal(ok.ok, true);
  assert.equal((ok as { after: string }).after, 'A 完成した `k`');
});

test('writer message: the language on top of the judge’s material, byte for byte', () => {
  assert.equal(buildRewriteUserMsg('BODY', '日本語', 'ja'), '## 会話の言語\n日本語\n\nBODY');
  assert.equal(buildRewriteUserMsg('BODY', 'English', 'en'), '## The language of the conversation\nEnglish\n\nBODY');
});

// ── the runner ───────────────────────────────────────────────────────────────

const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
function bodyOf(frames: string[]) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    getReader() {
      return {
        read: async () => i >= frames.length ? { done: true, value: undefined } : { done: false, value: enc.encode(frames[i++]) },
        cancel: async () => {}, releaseLock: () => {}, closed: Promise.resolve(undefined),
      };
    },
  };
}
const say = (text: string) => [frame({ type: 'thought', content: 'thinking' }), frame({ type: 'text', content: text })];
const item = (text: string): QueueItem => ({ id: 'item-1', at: 1000, kind: 'user_message', from: 'つよ', payload: { text } } as unknown as QueueItem);
type M = Record<string, any>;

function rig(judge: string, writer: string | null) {
  const saves: Array<Record<string, any>> = [];
  const posted: unknown[] = [];
  const writerCalls: Array<{ convLang: string }> = [];
  let disk = 5; let minted = 0;
  const log = { id: 'c1', updatedAt: 5, aiName: 'Local', anchorSettings: { enabled: true, scope: 'all' }, messages: [{ id: 'u0', role: 'user', content: 'q' }, { id: 'a0', role: 'assistant', content: 'r' }] };
  const deps: RunTurnDeps = {
    loadLog: async () => log,
    saveLog: async (_c, logData) => { disk += 1; saves.push(logData as Record<string, any>); return { ok: true, writtenUpdatedAt: disk }; },
    chatPost: async (req) => { posted.push(JSON.parse(await req.text())); return { ok: true, status: 200, body: bodyOf(say('今天完成了。64 本。')) } as unknown as Response; },
    globalSettings: {}, enableReadConversation: false,
    folderDefaults: { aiName: 'Local', folderName: 'ミニ酱', systemPrompt: '', specificModel: 'm', modelParams: {} },
    newId: () => `minted-${++minted}`, nowMs: () => 7000, clientId: 'runner:test',
    origin: 'http://localhost:3000', injectTurnId: 'turn_test',
    runAnchor: async () => ({ at: 1, family: 'DeepSeek', model: 'deepseek-flash', thought: '', output: judge }),
    runAnchorRewrite: async (x) => {
      writerCalls.push({ convLang: x.convLang });
      return writer === null ? null : { at: 1, family: 'DeepSeek', model: 'deepseek-flash', thought: '', output: writer };
    },
  };
  return { deps, saves, posted, writerCalls };
}
const lastReply = (r: { saves: Array<Record<string, any>> }) => (r.saves.at(-1)!.messages as M[]).at(-1)!;
const JUDGE = 'REWRITE\n[[LANG]]日本語[[/LANG]]';

test('runner REWRITE: text repaired in one save, thinking kept, no re-run, original kept off the wire', async () => {
  const r = rig(JUDGE, '[[OLD]]\n今天完成了\n[[NEW]]\n今日は完成した\n[[END]]');
  await runTurnForQueue('ミニ酱', 'c1', [item('hi')], r.deps);
  assert.equal(r.posted.length, 1, 'never re-run');
  assert.equal(r.saves.length, 1, 'one save');
  assert.deepEqual(r.writerCalls, [{ convLang: '日本語' }]);
  const reply = lastReply(r);
  assert.equal(reply.content, '今日は完成した。64 本。');
  assert.equal(reply.thoughtProcess, 'thinking', 'thinking untouched');
  assert.equal(reply.anchorRewrite.ok, true);
  assert.equal(reply.anchorRewrite.before, '今天完成了。64 本。');
  assert.equal(reply.anchorAct, undefined, 'silent: no notice is stored');
  // Next turn: the being sees only the repaired text — no notice, never `before`.
  const wire = buildSlimHistory([...(r.saves.at(-1)!.messages as M[]), { id: 'u9', role: 'user', content: 'next' }], {
    hiddenAttachmentsAccessible: false, attachmentPathsVisible: false, toolHistoryEnabled: false, saveThinkingToLog: false, turnAiName: 'Local',
  });
  const blob = JSON.stringify(wire);
  assert.equal(blob.includes('今天完成了'), false, 'the original never reaches the being');
  assert.equal(blob.includes(REWRITE_NOTICE.en) || blob.includes(REWRITE_NOTICE.ja), false, 'silent');
});

test('a rewrite notice saved before the silent change is never delivered', () => {
  const msgs = [
    { role: 'assistant', anchorAct: { kind: 'rewrite', text: 'old notice', at: 1 } },
    { role: 'user' },
  ] as any;
  assert.deepEqual(anchorNoticesFor(msgs, 1), []);
  msgs[0].anchorAct = { kind: 'notify', text: 'keep', at: 1 };
  assert.deepEqual(anchorNoticesFor(msgs, 1), ['keep']);
});

test('runner REWRITE that fails keeps the reply exactly, says why, tells the being nothing', async () => {
  const r = rig(JUDGE, '[[OLD]]\n今天完成了\n[[NEW]]\n今日は完成した\n[[END]]\n[[OLD]]\n64');
  await runTurnForQueue('ミニ酱', 'c1', [item('hi')], r.deps);
  const reply = lastReply(r);
  assert.equal(reply.content, '今天完成了。64 本。');
  assert.equal(reply.anchorRewrite.ok, false);
  assert.equal(reply.anchorRewrite.reason, 'truncated');
  assert.equal('before' in reply.anchorRewrite, false);
  assert.equal(reply.anchorAct, undefined);
});

test('runner REWRITE with no writer prompt: reply kept, reason no-prompt', async () => {
  const r = rig(JUDGE, null);
  await runTurnForQueue('ミニ酱', 'c1', [item('hi')], r.deps);
  const reply = lastReply(r);
  assert.equal(reply.content, '今天完成了。64 本。');
  assert.equal(reply.anchorRewrite.reason, 'no-prompt');
});

// ── Live stream (つよ, 2026-11-19): judge and writer visible while they run ──
import { createAnchorLiveEmitter, applyAnchorLive, normaliseAnchorLive, type AnchorLiveFrame, type AnchorLiveView } from '@/lib/anchorLive';

test('live: the emitter coalesces deltas, starts each call, and flushes the tail', () => {
  const out: AnchorLiveFrame[] = [];
  let now = 0;
  const em = createAnchorLiveEmitter({ assistantId: 'a1', stage: 'judge', model: 'm', emit: (f) => out.push(f), now: () => now, intervalMs: 100 });
  em.push({ thought: 'ab' }); em.push({ thought: 'c' });
  now = 150; em.push({ text: 'RE' });
  em.push({ text: 'WRITE' });
  em.end();
  assert.equal(out[0].start, true);
  const view = out.reduce<AnchorLiveView | null>((v, f) => applyAnchorLive(v, normaliseAnchorLive(f as unknown as Record<string, unknown>)!), null)!;
  assert.deepEqual(view.judge, { model: 'm', thought: 'abc', text: 'REWRITE' }, 'nothing lost, nothing doubled');
  assert.equal(out.length, 3, 'start, one coalesced frame, the tail');
});

test('live: a re-asked judge starts over and drops a stale writer view', () => {
  const f = (o: Partial<AnchorLiveFrame>) => ({ type: 'anchor_live', assistantId: 'a1', stage: 'judge', model: 'm', ...o }) as AnchorLiveFrame;
  let v = applyAnchorLive(null, f({ start: true, text: 'x' }));
  v = applyAnchorLive(v, f({ stage: 'rewrite', start: true, text: 'w' }));
  v = applyAnchorLive(v, f({ start: true }));
  v = applyAnchorLive(v, f({ text: 'y' }));
  assert.equal(v.judge!.text, 'y');
  assert.equal(v.rewrite, undefined);
});

test('runner REWRITE streams both anchors to the relay, labelled by stage and reply', async () => {
  const r = rig(JUDGE, '[[OLD]]\n今天完成了\n[[NEW]]\n今日は完成した\n[[END]]');
  const raw: string[] = [];
  r.deps.onRawText = (s: string) => { raw.push(s); };
  r.deps.runAnchor = async (x) => { x.onDelta?.({ thought: '見る' }); x.onDelta?.({ text: JUDGE }); return { at: 1, family: 'DeepSeek', model: 'deepseek-flash', thought: '見る', output: JUDGE }; };
  const inner = r.deps.runAnchorRewrite!;
  r.deps.runAnchorRewrite = async (x) => { x.onDelta?.({ text: '[[OLD]]' }); return inner(x); };
  await runTurnForQueue('ミニ酱', 'c1', [item('hi')], r.deps);
  const frames = raw.flatMap((s) => s.split('\n')).filter((l) => l.startsWith('data: ')).map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter((d) => d?.type === 'anchor_live');
  const id = lastReply(r).id;
  const view = frames.reduce<AnchorLiveView | null>((v, d) => applyAnchorLive(v, normaliseAnchorLive(d)!), null)!;
  assert.equal(view.assistantId, id, 'painted on the reply being judged');
  assert.equal(view.judge!.thought, '見る');
  assert.equal(view.judge!.text, JUDGE);
  assert.equal(view.rewrite!.text, '[[OLD]]');
});
