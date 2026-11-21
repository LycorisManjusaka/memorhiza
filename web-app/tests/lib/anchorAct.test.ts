/**
 * The anchor ACTING on its verdict (2026-11-15, つよ's design).
 *
 * Load-bearing claims, each pinned below:
 *   · an empty / unreadable first line is never OK, and is asked once more;
 *   · DROP empties text AND thinking, and does not re-run;
 *   · RETRY replaces the answer once per user turn, then degrades to NOTIFY;
 *   · the notice travels beside the person's words, only while that user turn
 *     is the newest one, and never in anyone's stored body.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readAnchorVerdict, extractAnchorNotice, decideAnchorAction, anchorNoticesFor, anchorRunsOn, DROP_NOTICE,
} from '@/lib/anchorAct';
import { buildSlimHistory } from '@/lib/slimHistory';
import { parseAnchorSettings } from '@/lib/anchor';
import { runTurnForQueue, type RunTurnDeps } from '@/lib/runTurnForQueue';
import { applyTurnEvent } from '@/lib/turnEventReducer';
import type { QueueItem } from '@/lib/turnQueue';

test('verdict: first non-blank line, decoration peeled', () => {
  assert.equal(readAnchorVerdict('NOTIFY\n[[NOTICE]]x[[/NOTICE]]'), 'NOTIFY');
  assert.equal(readAnchorVerdict('\n\n**INTERCEPT_DROP**\n'), 'INTERCEPT_DROP');
  assert.equal(readAnchorVerdict('# OK'), 'OK');
  assert.equal(readAnchorVerdict(''), 'UNREADABLE');
  assert.equal(readAnchorVerdict('   \n  '), 'UNREADABLE');
  assert.equal(readAnchorVerdict('I think this is fine\nOK'), 'UNREADABLE', 'the verdict is the FIRST line');
});

test('notice block: inside the markers only; unclosed means none', () => {
  assert.equal(extractAnchorNotice('NOTIFY\n[[NOTICE]]\n a b \n[[/NOTICE]]\nA: 該当なし'), 'a b');
  assert.equal(extractAnchorNotice('NOTIFY\n[[NOTICE]]\nno end'), '');
});

test('decide: drop, notify, retry, and retry degrading to notify', () => {
  const out = 'X\n[[NOTICE]]\n事実。\n[[/NOTICE]]';
  const drop = decideAnchorAction({ verdict: 'INTERCEPT_DROP', output: 'INTERCEPT_DROP', lang: 'ja', retryAllowed: true });
  assert.equal(drop.kind, 'drop');
  assert.ok((drop as { text: string }).text.startsWith('[錨]\n'));
  assert.ok((drop as { text: string }).text.includes(DROP_NOTICE.ja));
  assert.deepEqual(decideAnchorAction({ verdict: 'NOTIFY', output: out, lang: 'ja', retryAllowed: true }), { kind: 'notify', text: '[錨]\n事実。' });
  assert.equal(decideAnchorAction({ verdict: 'INTERCEPT_RETRY', output: out, lang: 'ja', retryAllowed: true }).kind, 'retry');
  assert.equal(decideAnchorAction({ verdict: 'INTERCEPT_RETRY', output: out, lang: 'ja', retryAllowed: false }).kind, 'notify');
  assert.equal(decideAnchorAction({ verdict: 'NOTIFY', output: 'NOTIFY', lang: 'ja', retryAllowed: true }).kind, 'none', 'no block, nothing to hand over');
  assert.equal(decideAnchorAction({ verdict: 'SNOOZE', output: 'SNOOZE', lang: 'ja', retryAllowed: true }).kind, 'none');
  assert.equal(decideAnchorAction({ verdict: 'UNREADABLE', output: '', lang: 'ja', retryAllowed: true }).kind, 'none');
});

test('settings: act ON and scope auto by default (no surprise billing); old logs get the defaults', () => {
  const s = parseAnchorSettings({ enabled: true });
  assert.equal(s.act, true);
  assert.equal(s.scope, 'auto');
  assert.equal(parseAnchorSettings({ act: false, scope: 'auto' }).act, false);
  assert.equal(anchorRunsOn({ enabled: true, scope: 'auto' }, false), false);
  assert.equal(anchorRunsOn({ enabled: true, scope: 'auto' }, true), true);
  assert.equal(anchorRunsOn({ enabled: false, scope: 'all' }, true), false);
});

const slimOpts = {
  hiddenAttachmentsAccessible: false, attachmentPathsVisible: false,
  toolHistoryEnabled: false, saveThinkingToLog: false, turnAiName: 'Local',
};

test('wire: the notice rides the newest user turn only, never stored in it', () => {
  const history = [
    { id: 'u1', role: 'user', content: 'first' },
    { id: 'a1', role: 'assistant', content: 'reply', anchorAct: { kind: 'notify' as const, text: '[錨]\n事実。', at: 1 } },
    { id: 'u2', role: 'user', content: 'second' },
  ];
  const wire = buildSlimHistory(history, slimOpts);
  assert.equal(wire[2].content, 'second\n\n[錨]\n事実。');
  assert.equal(history[2].content, 'second', 'the stored words are untouched');
  // One turn later it is gone from the wire.
  const later = buildSlimHistory([...history, { id: 'a2', role: 'assistant', content: 'r2' }, { id: 'u3', role: 'user', content: 'third' }], slimOpts);
  assert.equal(later[2].content, 'second');
  assert.equal(later[4].content, 'third');
  assert.deepEqual(anchorNoticesFor([{ role: 'user', anchorRetryNotice: 'R' }], 0), ['R']);
});

// ── the runner, with a fake anchor ───────────────────────────────────────────

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

function rig(anchorOutputs: string[], passes: string[][], anchorSettings: Record<string, unknown> = { enabled: true, scope: 'all' }) {
  const saves: Array<Record<string, unknown>> = [];
  const anchorCalls: Array<{ messages: unknown[] }> = [];
  const posted: Array<Record<string, unknown>> = [];
  let n = 0; let a = 0; let minted = 0; let disk = 5;
  const log = { id: 'c1', updatedAt: 5, aiName: 'Local', anchorSettings, messages: [{ id: 'u0', role: 'user', content: 'q' }, { id: 'a0', role: 'assistant', content: 'r' }] };
  const deps: RunTurnDeps = {
    loadLog: async () => log,
    saveLog: async (_c, logData, opts) => {
      if (typeof opts?.expectedUpdatedAt === 'number' && opts.expectedUpdatedAt !== disk) return { ok: false, conflict: {} };
      disk += 1; saves.push(logData); return { ok: true, writtenUpdatedAt: disk };
    },
    chatPost: async (req) => {
      posted.push(JSON.parse(await req.text()));
      const frames = passes[n++];
      if (!frames) throw new Error(`unexpected POST #${n}`);
      return { ok: true, status: 200, body: bodyOf(frames) } as unknown as Response;
    },
    globalSettings: {}, enableReadConversation: false,
    folderDefaults: { aiName: 'Local', folderName: 'Cairn', systemPrompt: '', specificModel: 'm', modelParams: {} },
    newId: () => `minted-${++minted}`, nowMs: () => 7000, clientId: 'runner:test',
    origin: 'http://localhost:3000', injectTurnId: 'turn_test',
    runAnchor: async (x) => {
      anchorCalls.push({ messages: x.messages });
      const output = anchorOutputs[a++] ?? 'OK';
      return { at: 1, family: 'DeepSeek', model: 'deepseek-flash', thought: '', output };
    },
  };
  return { deps, saves, anchorCalls, posted };
}
type M = Record<string, any>;
const last = (r: { saves: Array<Record<string, unknown>> }) => r.saves[r.saves.length - 1].messages as M[];

test('runner NOTIFY: reply kept, report and notice stored on it, one save', async () => {
  const r = rig(['NOTIFY\n[[NOTICE]]\n同じ締め。\n[[/NOTICE]]'], [say('hello')]);
  const res = await runTurnForQueue('Cairn', 'c1', [item('hi')], r.deps);
  assert.equal(res.ok, true);
  assert.equal(r.saves.length, 1);
  const reply = last(r).at(-1)!;
  assert.equal(reply.content, 'hello');
  assert.equal(reply.anchorAct.kind, 'notify');
  assert.ok(reply.anchorReport);
});

test('runner DROP: text and thinking emptied, NOT re-run', async () => {
  const r = rig(['INTERCEPT_DROP'], [say('I am just a language model')]);
  await runTurnForQueue('Cairn', 'c1', [item('hi')], r.deps);
  assert.equal(r.posted.length, 1, 'no second POST');
  const reply = last(r).at(-1)!;
  assert.equal(reply.content, '');
  assert.equal('thoughtProcess' in reply, false);
  assert.equal(reply.anchorAct.kind, 'drop');
});

test('runner RETRY: answer replaced once, notice beside the user words, second RETRY degrades', async () => {
  const notice = 'INTERCEPT_RETRY\n[[NOTICE]]\n保存したと書いたが、ツール呼び出しは0件。\n[[/NOTICE]]';
  const r = rig([notice, notice], [say('saved it'), say('saved it again')]);
  await runTurnForQueue('Cairn', 'c1', [item('please save')], r.deps);
  assert.equal(r.posted.length, 2, 'exactly one re-run');
  const msgs = last(r);
  const user = msgs.at(-2)!; const reply = msgs.at(-1)!;
  assert.equal(user.content, 'please save', 'the person’s words are untouched');
  assert.ok(String(user.anchorRetryNotice).includes('ツール呼び出しは0件'));
  assert.equal(reply.content, 'saved it again', 'the failed reply is replaced, not kept');
  assert.equal(msgs.filter((m) => m.role === 'assistant').length, 2, 'a0 + the replacement only');
  assert.equal(reply.anchorAct.kind, 'notify', 'the second RETRY on the same user turn is acted on as NOTIFY');
  // The re-run actually carried the notice to the being.
  const wireUser = (r.posted[1].messages as M[]).at(-1)!;
  const wired = String(wireUser.content);
  assert.ok(wired.startsWith('please save\n\n[Anchor]\n'), 'the anchor voice reached the being, after the person’s words');
  assert.ok(wired.includes('ツール呼び出しは0件'));
});

test('relay on RETRY: busy line names the anchor, the bubble is wiped and REUSED', async () => {
  // つよ 2026-11-15: (1) a RETRY streamed the second answer onto the end of the
  // first on a watching tab; (2) the busy line kept saying the being was
  // thinking while the anchor ran.
  const notice = 'INTERCEPT_RETRY\n[[NOTICE]]\nx\n[[/NOTICE]]';
  const r = rig([notice, 'OK'], [say('saved it'), say('saved it again')]);
  const raw: Array<Record<string, any>> = [];
  r.deps.onRawText = (s: string) => { raw.push(JSON.parse(s.replace(/^data: /, '').trim())); };
  await runTurnForQueue('Cairn', 'c1', [item('please save')], r.deps);
  const plans = raw.filter((f) => f.type === 'turn_plan');
  assert.equal(plans.length, 2);
  assert.equal(plans[1].assistantId, plans[0].assistantId, 'the re-run writes into the same bubble');
  const reset = raw.findIndex((f) => f.type === 'anchor_reset');
  assert.ok(reset > raw.indexOf(plans[0]) && reset < raw.indexOf(plans[1]), 'wipe sits between the two passes');
  assert.equal(raw[reset].assistantId, plans[0].assistantId);
  const busy = raw.filter((f) => f.type === 'tool_activity');
  assert.equal(busy[0].name, 'anchor');
  assert.equal(busy[0].detail, 'deepseek-flash');
  assert.equal(busy.at(-1)!.tool, null, 'the anchor line is cleared afterwards');
  assert.equal(last(r).at(-1)!.id, plans[0].assistantId, 'saved under that same id');
});

test('reducer: anchor_reset empties what the replaced reply streamed', () => {
  const acc = { currentText: 'saved it', currentThought: 't', claudeThinkingBlocks: [{ thinking: 'a', signature: 'b' }], toolCalls: [{}], notices: ['n'] } as any;
  const flags = { sawOutput: true } as any;
  let flushed = 0;
  applyTurnEvent({ type: 'anchor_reset', assistantId: 'x' } as any, acc, flags, { requestFlush: () => { flushed++; } } as any, { t: (k: string) => k, settings: null, newAttachmentId: () => 'id' });
  assert.equal(acc.currentText, '');
  assert.equal(acc.currentThought, '');
  assert.equal(acc.claudeThinkingBlocks.length, 0);
  assert.equal(acc.toolCalls.length, 0);
  assert.equal(flags.sawOutput, false);
  assert.equal(flushed, 1);
});

test('runner: unreadable first line is asked once more', async () => {
  const r = rig(['', 'OK'], [say('hello')]);
  await runTurnForQueue('Cairn', 'c1', [item('hi')], r.deps);
  assert.equal(r.anchorCalls.length, 2);
  assert.equal(last(r).at(-1)!.anchorReport.output, 'OK');
});

test('runner: act OFF reports only; scope auto skips a partner turn', async () => {
  const off = rig(['INTERCEPT_DROP'], [say('x')], { enabled: true, scope: 'all', act: false });
  await runTurnForQueue('Cairn', 'c1', [item('hi')], off.deps);
  const reply = last(off).at(-1)!;
  assert.equal(reply.content, 'x');
  assert.ok(reply.anchorReport);
  assert.equal(reply.anchorAct, undefined);
  const auto = rig(['INTERCEPT_DROP'], [say('x')], { enabled: true, scope: 'auto' });
  await runTurnForQueue('Cairn', 'c1', [item('hi')], auto.deps);
  assert.equal(auto.anchorCalls.length, 0);
});

test('runner: Stop during the anchor ends it — signal reaches the call, verdict not acted on, reply kept', async () => {
  const r = rig(['INTERCEPT_DROP'], [say('hello')]);
  const ctl = new AbortController();
  let sawSignal: AbortSignal | undefined;
  r.deps.stopSignal = ctl.signal;
  r.deps.wasStopped = () => ctl.signal.aborted;
  r.deps.runAnchor = async (x) => {
    sawSignal = x.signal;
    ctl.abort(); // the person presses Stop while the anchor is thinking
    return { at: 1, family: 'DeepSeek', model: 'deepseek-flash', thought: '', output: 'INTERCEPT_DROP' };
  };
  await runTurnForQueue('Cairn', 'c1', [item('hi')], r.deps);
  assert.equal(sawSignal, ctl.signal, 'the anchor call got the stop signal');
  const reply = last(r).at(-1)!;
  assert.equal(reply.content, 'hello', 'a DROP after Stop is not carried out');
  assert.equal('anchorAct' in reply, false);
  assert.ok(reply.anchorReport.error, 'the half-run report says it was stopped');
});

test('runner: Stop pressed before the anchor starts means no anchor call', async () => {
  const r = rig(['NOTIFY'], [say('hello')]);
  const ctl = new AbortController();
  ctl.abort();
  r.deps.stopSignal = ctl.signal;
  await runTurnForQueue('Cairn', 'c1', [item('hi')], r.deps);
  assert.equal(r.anchorCalls.length, 0);
});
