import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  autoSoulUpdateDue, runAutoSoulUpdate, withDelayedStartNote, settleUpdateOutput,
  type AutoSoulIo, type AutoSoulSpuCall,
} from '../src/lib/autoSoulUpdate';
import { hasNewReason, type AutoSoulStatus } from '../src/lib/autoSoulUpdateIo';
import { strongerPass } from '../src/lib/autoSoulRuns';
import { END_SENTINEL } from '../src/lib/spuScaffold';
import { resolveSpuVessels } from '../src/lib/spuPost';
import { enqueue, pending, claim, movePendingItems } from '../src/lib/turnQueue';
import type { RunSpuResult } from '../src/lib/runSpuAction';
import type { SpuRunRecord } from '../src/lib/spuRun';

const record = (over: Partial<SpuRunRecord>): SpuRunRecord => ({
  runId: 'r', label: '3', action: 'update', convoId: 'c2', startedAt: 1, updatedAt: 2,
  status: 'done', accum: '', sawSentinel: false, attempts: 1,
  vessel: { aiName: 'DeepSeek', specificModel: 'deepseek-v4-pro' }, host: 'h', ...over,
});
const done = (accum: string): RunSpuResult => ({ ok: true, record: record({ accum, sawSentinel: accum.includes(END_SENTINEL) }) });
const errored = (reason: string): RunSpuResult => ({ ok: false, stage: 'stream', reason, record: record({ status: 'error', error: reason }) });

const GOOD_SOUL = `changed two lines\n\n## **Layer 1: Core**\nnew one\n\n## **Layer 2: Team**\nnew two\n\n## **Layer 3: Tech**\nnew three\n\n## [Deletions log]\n- nothing\n${END_SENTINEL}`;
const CUT_SOUL = `## **Layer 1: Core**\nnew one\n\n## **Layer 2: Te`;

function world(script: { update: RunSpuResult[]; summary: RunSpuResult[] }, logOver: Record<string, unknown> = {}) {
  const logs: Record<string, Record<string, unknown>> = {
    c2: {
      id: 'c2', folderName: 'Mina', title: 'Mina_2', aiName: 'Gemini', specificModel: 'gemini-4-neon',
      systemPrompt: 'old prompt', firstOriginalMessageId: 'm2', autoSoulUpdate: true, updatedAt: 111,
      messages: [
        { id: 'm1', role: 'assistant', content: 'carried over', timestamp: 1 },
        { id: 'm2', role: 'user', name: 'Tsuyo', content: 'hello', timestamp: Date.UTC(2026, 10, 20, 3, 0) },
        { id: 'm3', role: 'assistant', content: 'hi there', timestamp: 5 },
      ],
      ...logOver,
    },
  };
  const calls: AutoSoulSpuCall[] = [];
  const written: Record<string, string> = {};
  const settingsPatches: Record<string, unknown>[] = [];
  let cleared = 0;
  const io: AutoSoulIo = {
    loadLog: async (id) => logs[id] || null,
    saveLog: async (id, log) => { logs[id] = log; return { ok: true }; },
    listConversations: async () => Object.values(logs).map((l) => ({ id: String(l.id), title: String(l.title) })),
    beingSettings: async () => ({ systemPromptHeader: 'HEADER', forceUpdaterModel: true, updaterModelKey: 'deepseek-v4-pro' }),
    patchBeingSettings: async (_b, patch) => { settingsPatches.push(patch); },
    readSoul: async (_b, label) => (label === '2' ? '## **Layer 1: Core**\nold one\n\n## **Layer 2: Team**\nold two\n\n## **Layer 3: Tech**\nold three' : null),
    readWork: async () => null,
    writeSoul: async (_b, label, text) => { written[`soul:${label}`] = text; },
    backupSoul: async (_b, f, t, phase, text) => { written[`backup:${f}>${t}:${phase}`] = text; },
    agentPrompt: async () => 'AGENT',
    summaryAgentPrompt: async () => null,
    deletionPatterns: async () => ['（維持）'],
    applyDeletions: (text, pats) => pats.reduce((s, p) => s.split(p).join(''), text),
    footer: async () => '',
    layer4Index: async () => '',
    writeSummary: async (_b, title, content) => { written[`summary:${title}`] = content; },
    writeChangelog: async (_b, title, content) => { written[`changelog:${title}`] = content; },
    clearRunRecord: async () => { cleared++; },
    runSpu: async (call) => {
      calls.push(call);
      const next = script[call.action].shift();
      if (!next) throw new Error(`no scripted ${call.action} result left`);
      return next;
    },
    newId: () => 'c3',
  };
  return { io, logs, calls, written, settingsPatches, cleared: () => cleared };
}

test('β then the summary, then the next conversation exists and carries the new soul', async () => {
  const w = world({ update: [done(GOOD_SOUL)], summary: [done('a short summary')] });
  const r = await runAutoSoulUpdate({ being: 'Mina', convoId: 'c2', lang: 'ja' }, w.io);
  assert.deepEqual(r, { ok: true, newConvoId: 'c3', newTitle: 'Mina_3', label: '3', retried: false });

  // The soul file holds Layers 1-3 only: no changelog above, no logs below.
  assert.ok(w.written['soul:3'].startsWith('## **Layer 1: Core**'));
  assert.ok(!w.written['soul:3'].includes('Deletions log'));
  assert.ok(!w.written['soul:3'].includes(END_SENTINEL));
  assert.equal(w.written['changelog:Mina_2'], 'changed two lines');
  // The summary is filed under the conversation it summarises, stamped with its first new message.
  assert.match(w.written['summary:Mina_2'], /^\[2026-11-\d\d \d\d:\d\d\] a short summary$/);

  const clone = w.logs.c3;
  assert.equal(clone.title, 'Mina_3');
  assert.equal(clone.systemPrompt, 'HEADER\n\n' + w.written['soul:3']);
  assert.equal(clone.firstOriginalMessageId, null);
  assert.equal(clone.firstOriginalIsNext, true);
  assert.equal(clone.autoSoulUpdate, true, 'the switch travels with the conversation');
  assert.equal('updatedAt' in clone, false);
  assert.equal((clone.messages as unknown[]).length, 3);
  assert.equal(w.logs.c2.title, 'Mina_2', 'the old conversation is left as it was');

  // Only NEW messages are shown to the agents, on the vessel the settings name.
  assert.equal(w.calls.length, 2);
  assert.ok(!w.calls[0].userMsg.includes('carried over'));
  assert.ok(w.calls[0].userMsg.includes('[Tsuyo]\nhello'));
  assert.deepEqual(w.calls[0].vessel, { aiName: 'DeepSeek', specificModel: 'deepseek-v4-pro' });
  assert.equal(w.calls[1].maxContinuations, 0);
  assert.equal(w.cleared(), 1);
  assert.deepEqual(w.settingsPatches[0].convoOrder, ['c3', 'c2']);
});

test('a cut-off output is retried once, and the second one is used', async () => {
  const w = world({ update: [done(CUT_SOUL), done(GOOD_SOUL)], summary: [done('s')] });
  const r = await runAutoSoulUpdate({ being: 'Mina', convoId: 'c2', lang: 'ja' }, w.io);
  assert.equal(r.ok, true);
  assert.equal(r.retried, true);
  assert.equal(w.calls.length, 3);
});

test('cut off twice: it stops, and nothing was written as a soul or a conversation', async () => {
  const w = world({ update: [done(CUT_SOUL), done(CUT_SOUL), done(GOOD_SOUL)], summary: [done('s')] });
  const r = await runAutoSoulUpdate({ being: 'Mina', convoId: 'c2', lang: 'ja' }, w.io);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.stage, 'update');
  assert.equal(r.retried, true);
  assert.equal(w.calls.length, 2, 'exactly one retry, not a third call');
  assert.equal(w.logs.c3, undefined);
  assert.equal(w.written['soul:3'], undefined);
});

test('the one retry is shared: a retried β leaves none for the summary', async () => {
  const w = world({ update: [errored('503'), done(GOOD_SOUL)], summary: [errored('boom'), done('s')] });
  const r = await runAutoSoulUpdate({ being: 'Mina', convoId: 'c2', lang: 'ja' }, w.io);
  assert.equal(!r.ok && r.stage, 'summary');
  assert.equal(w.calls.length, 3);
  assert.equal(w.logs.c3, undefined, 'no conversation without its summary');
  assert.ok(w.written['soul:3'], 'the draft stays on disk for a person');
});

test('a stopped run is not retried', async () => {
  const w = world({ update: [{ ok: true, record: record({ status: 'stopped', accum: 'half' }) }, done(GOOD_SOUL)], summary: [done('s')] });
  const r = await runAutoSoulUpdate({ being: 'Mina', convoId: 'c2', lang: 'ja' }, w.io);
  assert.equal(r.ok, false);
  assert.equal(w.calls.length, 1);
});

test('refused before any model call: a title that is not <name>_<number>, or a next conversation that already exists', async () => {
  const a = world({ update: [done(GOOD_SOUL)], summary: [done('s')] }, { title: 'Monitor test' });
  const ra = await runAutoSoulUpdate({ being: 'Mina', convoId: 'c2', lang: 'ja' }, a.io);
  assert.equal(!ra.ok && ra.stage, 'precheck');
  assert.equal(a.calls.length, 0);

  const b = world({ update: [done(GOOD_SOUL)], summary: [done('s')] });
  b.logs.cX = { id: 'cX', title: 'Mina_3' };
  const rb = await runAutoSoulUpdate({ being: 'Mina', convoId: 'c2', lang: 'ja' }, b.io);
  assert.equal(!rb.ok && rb.stage, 'precheck');
  assert.equal(b.calls.length, 0);
});

test('settleUpdateOutput: no completion marker is never a soul', () => {
  const r = settleUpdateOutput(done(CUT_SOUL));
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.retryable, true);
});

test('due only when the switch is on AND the gauge is at 100%', () => {
  const big = 'word '.repeat(400);
  const log = (over: Record<string, unknown>) => ({
    aiName: 'Claude', firstOriginalMessageId: 'a',
    messages: [{ id: 'a', role: 'user', content: big }], ...over,
  });
  // A cap of 100 tokens: ~400 words is far past it.
  assert.equal(autoSoulUpdateDue(log({ autoSoulUpdate: true }), { maxConversationLog: 100 }), true);
  assert.equal(autoSoulUpdateDue(log({}), { maxConversationLog: 100 }), false, 'absent = OFF');
  assert.equal(autoSoulUpdateDue(log({ autoSoulUpdate: false }), { maxConversationLog: 100 }), false);
  assert.equal(autoSoulUpdateDue(log({ autoSoulUpdate: true }), { maxConversationLog: 1000000 }), false, 'room left');
  assert.equal(autoSoulUpdateDue(log({ autoSoulUpdate: true }), { maxConversationLog: 0 }), false, 'a cap of 0 has no percent');
  assert.equal(autoSoulUpdateDue(null, {}), false);
});

test('after a failure, the same waiting items do not start another attempt; a new one does', () => {
  const failed: AutoSoulStatus = { at: 1, convoId: 'c2', ok: false, stage: 'update', reason: 'x', waitingIds: ['a', 'b'] };
  assert.equal(hasNewReason(null, 'c2', ['a']), true, 'never tried');
  assert.equal(hasNewReason(failed, 'c2', ['a', 'b']), false, 'the clock re-kicking the same wake is not a reason');
  assert.equal(hasNewReason(failed, 'c2', ['a']), false);
  assert.equal(hasNewReason(failed, 'c2', ['a', 'b', 'c']), true, 'a new message arrived');
  assert.equal(hasNewReason(failed, 'other', ['a']), true, 'a failure elsewhere says nothing about here');
  assert.equal(hasNewReason(failed, 'c2', []), false, 'nothing waiting starts nothing');
  assert.equal(hasNewReason({ at: 1, convoId: 'c2', ok: true }, 'c2', ['a']), true);
});

test('a NEXUS item that waited says so, in the language of the screen that queued it', () => {
  const ja = withDelayedStartNote({ kind: 'system', payload: { text: '定刻（04:00）', fullText: 'long', purpose: 'wake' } }, '04:12');
  const p = ja.payload as { text: string; fullText: string; purpose: string };
  assert.ok(p.text.startsWith('定刻（04:00）\n') && p.text.includes('04:12') && p.text.includes('魂の更新'));
  assert.ok(p.fullText.startsWith('long\n') && p.fullText.includes('04:12'));
  assert.equal(p.purpose, 'wake');
  const en = withDelayedStartNote({ payload: { text: 'It is 04:00' }, uiLang: 'en' }, '04:12');
  assert.ok((en.payload as { text: string }).text.includes('delayed until 04:12'));
  assert.equal('fullText' in (en.payload as object), false);
});

test('the pass rerun afterwards is the strongest one that waited', () => {
  const direct = { auto: false, wake: false, n: 'direct' };
  const wake = { auto: false, wake: true, n: 'wake' };
  const stock = { auto: true, wake: false, n: 'stock' };
  assert.equal(strongerPass(stock, wake).n, 'wake');
  assert.equal(strongerPass(wake, direct).n, 'direct');
  assert.equal(strongerPass(direct, stock).n, 'direct');
  assert.equal(strongerPass(stock, stock), stock);
});

test('the updater and summary vessels follow the saved switches', () => {
  const convo = { aiName: 'Gemini', specificModel: 'gemini-4-neon' };
  assert.deepEqual(resolveSpuVessels({}, convo), { update: convo, summary: convo });
  const forced = resolveSpuVessels({ forceGlmForUpdates: true, forceMimoForSummary: true }, convo);
  assert.equal(forced.update.specificModel, 'deepseek-v4-pro', 'legacy flag on, no key → the default updater');
  assert.equal(forced.summary.aiName, 'MiMo');
  const oauth = resolveSpuVessels({ forceUpdaterModel: true, updaterModelKey: 'claude-opus-5-oauth' }, convo);
  assert.equal(oauth.update.authMode, 'oauth');
  assert.equal(oauth.summary.authMode, 'oauth', 'a summary that inherits the vessel inherits its billing path');
});

test('the stock is carried in order, only what was picked, and never from under a running turn', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-autosoul-'));
  const opts = { beingsDir: root };
  try {
    const a = await enqueue('Mina', 'old', { from: 'Tsuyo', payload: { text: 'one' } }, opts);
    await enqueue('Mina', 'old', { kind: 'system', from: 'NEXUS', payload: { text: 'zeta', purpose: 'soul_surgery' } }, opts);
    const c = await enqueue('Mina', 'old', { kind: 'system', from: 'NEXUS', payload: { text: 'wake', purpose: 'wake' } }, opts);

    const mv = await movePendingItems('Mina', 'old', 'new', {
      pick: (it) => it.kind === 'user_message' || (it.payload as { purpose?: string })?.purpose === 'wake',
      map: (it) => (it.kind === 'system' ? { ...it, payload: { ...(it.payload as object), text: 'wake (late)' } } : it),
    }, opts);
    assert.deepEqual(mv, { ok: true, moved: [a.item.id, c.item.id] });
    const moved = await pending('Mina', 'new', opts);
    assert.deepEqual(moved.map((i) => (i.payload as { text: string }).text), ['one', 'wake (late)']);
    assert.deepEqual(moved.map((i) => i.id), [a.item.id, c.item.id], 'ids and order survive the move');
    assert.deepEqual((await pending('Mina', 'old', opts)).map((i) => (i.payload as { text: string }).text), ['zeta']);

    // A live lease on the source: refuse, move nothing.
    const held = await claim('Mina', 'old', 'runner:test', opts);
    assert.equal(held.ok, true);
    const refused = await movePendingItems('Mina', 'old', 'new2', { pick: () => true }, opts);
    assert.deepEqual(refused, { ok: false, reason: 'busy' });
    assert.equal((await pending('Mina', 'new2', opts)).length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
