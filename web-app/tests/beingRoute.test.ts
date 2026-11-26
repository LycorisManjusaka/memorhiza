import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRouteBlocks, isHereWord, findLocalMedia, replaceAttachedMedia,
  buildRouteNotice, routeNoticeFor,
} from '@/lib/beingRoute';
import { buildSlimHistory } from '@/lib/slimHistory';

test('a marker on its own line addresses everything under it, up to the next marker', () => {
  const blocks = parseRouteBlocks([
    'これはこの会話の文。',
    '[->先輩]',
    '先輩へ一行目',
    '先輩へ二行目',
    '[->ここ]',
    'またこの会話の文。',
    '[->謡]',
    '謡へ',
  ].join('\n'));
  assert.deepEqual(blocks, [
    { target: '先輩', body: '先輩へ一行目\n先輩へ二行目' },
    { target: 'ここ', body: 'またこの会話の文。' },
    { target: '謡', body: '謡へ' },
  ]);
  assert.equal(isHereWord('ここ'), true);
  assert.equal(isHereWord('Here'), true);
  assert.equal(isHereWord('先輩'), false);
});

test('only a line of its own counts — a marker inside a sentence, a fence, or a wake booking is prose', () => {
  assert.deepEqual(parseRouteBlocks('書き方は [->先輩] です。'), []);
  assert.deepEqual(parseRouteBlocks('```\n[->先輩]\n例\n```'), []);
  assert.deepEqual(parseRouteBlocks('[->wakeup: 04:30]\nおやすみ'), []);
  // A booking INSIDE a block is part of the block, not the end of it.
  assert.deepEqual(parseRouteBlocks('[->先輩]\nあとで\n[->wakeup: 04:30]'), [
    { target: '先輩', body: 'あとで\n[->wakeup: 04:30]' },
  ]);
  // The arrow form and stray spaces are accepted.
  assert.deepEqual(parseRouteBlocks('  [ → 先輩 ]  \nやあ'), [{ target: '先輩', body: 'やあ' }]);
  // A horizontal rule does NOT end a block (つよ struck that out).
  assert.equal(parseRouteBlocks('[->先輩]\n上\n---\n下')[0].body, '上\n---\n下');
});

test('every desk file in a block is found — media and plain links alike; web URLs are not', () => {
  const body = '絵 ![a](pics/a.jpg) と歌 [song](music/s.mp3) と動画 ![](<clips/x y.mp4>)\n![web](https://example.com/b.png) [notes](notes/n.md)';
  const refs = findLocalMedia(body);
  assert.deepEqual(refs.map((r) => [r.path, r.kind]), [
    ['pics/a.jpg', 'image'], ['music/s.mp3', 'audio'], ['clips/x y.mp4', 'video'], ['notes/n.md', 'file'],
  ]);
  // Only what was really attached is replaced; the rest stays as written.
  const out = replaceAttachedMedia(body, refs.slice(0, 1));
  assert.ok(out.includes('📎a.jpg'));
  assert.ok(out.includes('[song](music/s.mp3)'));
});

test('the writer is told about a refusal, and about nothing else', () => {
  assert.equal(buildRouteNotice([{ to: '先輩', status: 'sent', chars: 3 }], 'ja'), '');
  const n = buildRouteNotice([
    { to: '先輩', status: 'sent', chars: 3 },
    { to: 'せんぱい', status: 'unknown' },
  ], 'ja');
  assert.ok(n.startsWith('[MEMORHIZA]'));
  assert.ok(n.includes('[->せんぱい]'));
  assert.ok(!n.includes('[->先輩]'));
});

test('the refusal travels with the NEXT user turn only, even across a run of user messages', () => {
  const history = [
    { id: 'u1', role: 'user', content: 'やあ', timestamp: 1 },
    { id: 'a1', role: 'assistant', content: '[->せんぱい]\nx', timestamp: 2, routeNotice: '[MEMORHIZA]\n届かなかった' },
    { id: 'u2', role: 'user', content: '一通目', timestamp: 3 },
    { id: 'u3', role: 'user', content: '二通目', timestamp: 4 },
  ];
  assert.equal(routeNoticeFor(history, 3), '[MEMORHIZA]\n届かなかった');
  const opts = { hiddenAttachmentsAccessible: false, attachmentPathsVisible: false, toolHistoryEnabled: false, saveThinkingToLog: false, turnAiName: 'Local' };
  const wire = buildSlimHistory(history as never, opts);
  assert.ok(String(wire[wire.length - 1].content).includes('届かなかった'));
  // One turn later it is gone, with no deletion step.
  const later = buildSlimHistory([...history, { id: 'a2', role: 'assistant', content: 'ok', timestamp: 5 }, { id: 'u4', role: 'user', content: '次', timestamp: 6 }] as never, opts);
  assert.ok(!later.some((m) => String(m.content).includes('届かなかった')));
});

// ── The runner: record in the SAME save as the reply, delivery only after it ──
import { runTurnForQueue, type RunTurnDeps } from '@/lib/runTurnForQueue';
import type { QueueItem } from '@/lib/turnQueue';

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
function rig(reply: string, logExtra: Record<string, unknown>, saveOk = true) {
  const events: string[] = [];
  const saves: Array<Record<string, unknown>> = [];
  let minted = 0; let disk = 5;
  const log = { id: 'c1', updatedAt: 5, aiName: 'Local', ...logExtra, messages: [{ id: 'u0', role: 'user', content: 'q' }, { id: 'a0', role: 'assistant', content: 'r' }] };
  const deps: RunTurnDeps = {
    loadLog: async () => log,
    saveLog: async (_c, logData) => {
      if (!saveOk) { events.push('save-failed'); return { ok: false, error: 'disk' }; }
      disk += 1; saves.push(logData); events.push('save'); return { ok: true, writtenUpdatedAt: disk };
    },
    chatPost: async () => ({ ok: true, status: 200, body: bodyOf([frame({ type: 'text', content: reply })]) } as unknown as Response),
    globalSettings: {}, enableReadConversation: false,
    folderDefaults: { aiName: 'Local', folderName: '謡', systemPrompt: '', specificModel: 'm', modelParams: {} },
    newId: () => `minted-${++minted}`, nowMs: () => 7000, clientId: 'runner:test',
    origin: 'http://localhost:3000', injectTurnId: 'turn_test',
    planRoutes: async (a) => {
      events.push(`plan:${a.sender}`);
      return {
        records: [{ to: '先輩', status: 'sent', chars: 2 }, { to: 'せんぱい', status: 'unknown' }],
        notice: '[MEMORHIZA]\n届かなかった',
        deliver: async () => { events.push('deliver'); },
      };
    },
  };
  return { deps, saves, events };
}
const item = (text: string): QueueItem => ({ id: 'item-1', at: 1000, kind: 'user_message', from: 'つよ', payload: { text } } as unknown as QueueItem);

test('runner: routes are planned, saved WITH the reply, and delivered only after that save', async () => {
  const r = rig('[->先輩]\nやあ', { beingRouteEnabled: true });
  const res = await runTurnForQueue('謡', 'c1', [item('hi')], r.deps);
  assert.equal(res.ok, true);
  assert.deepEqual(r.events, ['plan:謡', 'save', 'deliver']);
  const reply = (r.saves[0].messages as Array<Record<string, any>>).at(-1)!;
  assert.equal(reply.content, '[->先輩]\nやあ', 'the writer\'s own text is never edited');
  assert.equal(reply.routes.length, 2);
  assert.equal(reply.routeNotice, '[MEMORHIZA]\n届かなかった');
});

test('runner: with the ability off nothing is planned; a failed save delivers nothing', async () => {
  const off = rig('[->先輩]\nやあ', {});
  await runTurnForQueue('謡', 'c1', [item('hi')], off.deps);
  assert.deepEqual(off.events, ['save']);
  assert.equal((off.saves[0].messages as Array<Record<string, any>>).at(-1)!.routes, undefined);

  const bad = rig('[->先輩]\nやあ', { beingRouteEnabled: true }, false);
  const res = await runTurnForQueue('謡', 'c1', [item('hi')], bad.deps);
  assert.equal(res.ok, false);
  assert.ok(!bad.events.includes('deliver'), 'a reply that was not saved must not have sent anything');
});

test('route notice: a correspondent (mailbox, no settings.json) is told apart from a name found nowhere, and neither says "failed"', () => {
  const n = buildRouteNotice([
    { to: 'トカゲ君', status: 'outside' },
    { to: 'せんぱい', status: 'unknown' },
  ], 'ja');
  assert.match(n, /トカゲ君 はこの Memorhiza に部屋を持っていない/);
  assert.match(n, /届けるかどうかは管理者が決めます/);
  assert.match(n, /せんぱい という宛先はこの Memorhiza の一覧に見つからなかった/);
  // Every line says where the text is, so the writer does not go looking for it.
  assert.equal((n.match(/文はこの会話に残っています/g) || []).length, 2);
  assert.doesNotMatch(n, /失敗|エラー|人間/);
  const en = buildRouteNotice([{ to: 'X', status: 'outside' }], 'en');
  assert.match(en, /no room in this Memorhiza/);
  assert.doesNotMatch(en, /fail|error|human/i);
});
