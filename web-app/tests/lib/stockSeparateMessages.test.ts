/**
 * STOCKED MESSAGES ARE SEPARATE USER MESSAGES (2026-11-15, つよ).
 *
 * Before: the stock merged into ONE user message holding everybody's files,
 * and a wake behind it ran as a SECOND turn. Now: [user, user, system] is one
 * turn, three user messages (each with its own attachments, the wake last),
 * one answer, all three items consumed. The wire folds the run back into one
 * user turn for the vessels that refuse two in a row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTurnForQueue, type RunTurnDeps } from '@/lib/runTurnForQueue';
import { composeMessages, type QueueItem } from '@/lib/turnQueue';
import { foldUserRuns, buildSlimHistory } from '@/lib/slimHistory';
import { applyDescriptions } from '@/lib/applyDescriptions';

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

const user = (id: string, text: string, atts: unknown[] = []): QueueItem =>
  ({ id, at: 1, kind: 'user_message', from: 'つよ', payload: { text, attachments: atts } } as unknown as QueueItem);
const wake = (id: string): QueueItem =>
  ({ id, at: 2, kind: 'system', from: 'NEXUS', payload: { text: '[NEXUS]\n定刻', attachments: [], fullText: 'FULL WAKE', purpose: 'wake' } } as unknown as QueueItem);

test('composeMessages: one message per item, each keeping its own attachments', () => {
  const { messages } = composeMessages([user('a', '[つよ]\nやほ1', [{ id: 'img1' }]), user('b', 'やほ2', [{ id: 'img2' }])]);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0].attachments, [{ id: 'img1' }]);
  assert.deepEqual(messages[1].attachments, [{ id: 'img2' }]);
  assert.equal(messages[0].text, '[つよ]\nやほ1', 'an existing label is not doubled');
  assert.equal(messages[1].text, '[つよ]\nやほ2', 'a missing label is added when there are several');
  assert.equal(composeMessages([user('a', 'solo')]).messages[0].text, 'solo', 'a single item is verbatim');
});

test('runner: stocked messages + a wake = one turn, three user messages, all consumed', async () => {
  const log = { id: 'c1', updatedAt: 5, aiName: 'Local', messages: [{ id: 'u0', role: 'user', content: 'old' }, { id: 'a0', role: 'assistant', content: 'r' }] };
  const saves: Array<Record<string, unknown>> = [];
  const posted: Array<Record<string, unknown>> = [];
  let minted = 0;
  let disk = 5;
  const deps: RunTurnDeps = {
    loadLog: async () => log,
    saveLog: async (_c: string, logData: Record<string, unknown>) => { disk += 1; saves.push(logData); return { ok: true, writtenUpdatedAt: disk }; },
    chatPost: async (req: Request) => {
      posted.push(await req.json() as Record<string, unknown>);
      return { ok: true, status: 200, body: bodyOf([frame({ type: 'text', content: 'both seen' })]) } as unknown as Response;
    },
    globalSettings: {}, enableReadConversation: false,
    folderDefaults: { aiName: 'Local', folderName: 'Default', systemPrompt: '', specificModel: 'gemma-4-26b', modelParams: {} },
    newId: () => `m-${++minted}`, nowMs: () => 9000, clientId: 'runner:test', origin: 'http://localhost:3000', injectTurnId: 'turn_t',
  } as unknown as RunTurnDeps;

  const items = [user('q1', '[つよ]\nやほ1', [{ id: 'img1', name: 'a.jpg' }]), user('q2', '[つよ]\nやほ2', [{ id: 'img2', name: 'b.jpg' }]), wake('q3')];
  const res = await runTurnForQueue('Default', 'c1', items, deps);
  assert.equal(res.ok, true);
  assert.deepEqual(res.consumedIds, ['q1', 'q2', 'q3'], 'nothing is left in the stock');

  const msgs = saves[saves.length - 1].messages as Array<Record<string, any>>;
  const added = msgs.slice(2);
  assert.deepEqual(added.map((m) => m.role), ['user', 'user', 'user', 'assistant'], 'one answer to all of them');
  assert.deepEqual(added[0].attachments, [{ id: 'img1', name: 'a.jpg' }]);
  assert.deepEqual(added[1].attachments, [{ id: 'img2', name: 'b.jpg' }]);
  assert.equal(added[2].nexus?.full, 'FULL WAKE', 'the wake is the last, newest user message');
  assert.ok(added[0].timestamp < added[1].timestamp && added[1].timestamp < added[2].timestamp, 'order survives a sort');

  // The wire: ONE folded user turn carrying both images and the full wake text.
  const wire = posted[0].messages as Array<Record<string, any>>;
  assert.deepEqual(wire.map((m) => m.role), ['user', 'assistant', 'user']);
  const last = wire[2];
  assert.equal(last.content, '[つよ]\nやほ1\n\n[つよ]\nやほ2\n\nFULL WAKE');
  assert.deepEqual(last.attachments.map((a: any) => a.id), ['img1', 'img2']);
});

test('foldUserRuns leaves an alternating history untouched', () => {
  const h = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }];
  assert.deepEqual(foldUserRuns(h), h);
});

test('wire fold keeps the newest message id, so newest-turn rules still point at it', () => {
  const out = buildSlimHistory([
    { id: 'x', role: 'user', content: 'one' },
    { id: 'y', role: 'user', content: 'two' },
  ], { hiddenAttachmentsAccessible: false, attachmentPathsVisible: false, toolHistoryEnabled: false, saveThinkingToLog: false, turnAiName: 'Local' });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'y');
});

test('a description for an earlier message of a folded run lands on that message', () => {
  const msgs = [
    { id: 'u1', attachments: [{ id: 'img1', name: 'image.jpg' }] },
    { id: 'u2', attachments: [{ id: 'img2', name: 'image.jpg' }] },
  ];
  // The wire named the folded turn's id (u2) for img1.
  const { next } = applyDescriptions(msgs, [{ messageId: 'u2', attachmentId: 'img1', description: 'cat' } as any]);
  assert.equal((next[0].attachments as any[])[0].description, 'cat');
  assert.equal((next[1].attachments as any[])[0].description, undefined, 'the same filename does not steal it');
});
