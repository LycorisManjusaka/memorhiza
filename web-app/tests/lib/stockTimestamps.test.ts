/**
 * A STOCKED MESSAGE KEEPS THE TIME IT WAS WRITTEN (2026-11-24, トカゲくん).
 *
 * Before: every message delivered out of the stock was stamped with the moment
 * the turn started, so three messages written across an afternoon all claimed
 * the same second. The transcript said "he dumped all of it at once", which is
 * false, and the being reading it could not tell what had been answered when.
 *
 * The time was already on disk — `QueueItem.at` is the enqueue time and the
 * FIFO key — so the fix is to use it, with two guards: never in the future,
 * and strictly increasing across the batch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTurnForQueue, type RunTurnDeps } from '@/lib/runTurnForQueue';
import { composedTimestamps, type QueueItem } from '@/lib/turnQueue';

const T = 1_764_000_000_000;

test('each message keeps the time it was stocked', () => {
  const stamps = composedTimestamps([{ at: T }, { at: T + 60_000 }, { at: T + 90_000 }], T + 300_000);
  assert.deepEqual(stamps, [T, T + 60_000, T + 90_000]);
});

test('an item without a usable time falls back to the turn start', () => {
  const now = T + 5_000;
  assert.deepEqual(composedTimestamps([{}, { at: 0 }, { at: Number.NaN }, { at: -3 }], now), [now, now + 1, now + 2, now + 3]);
});

test('a time from the future is clamped, never stamped ahead of now', () => {
  const now = T + 1_000;
  const stamps = composedTimestamps([{ at: T }, { at: now + 86_400_000 }], now);
  assert.equal(stamps[0], T);
  assert.equal(stamps[1], now, 'a skewed clock cannot put a message in the future');
});

test('a tie becomes strictly increasing, so no two messages share an instant', () => {
  const now = T + 10_000;
  const stamps = composedTimestamps([{ at: T }, { at: T }, { at: T }], now);
  assert.equal(stamps[0], T);
  assert.ok(stamps[1] > stamps[0] && stamps[2] > stamps[1], 'two installations can enqueue in one millisecond');
});

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

test('runner: two messages stocked an hour apart keep their own times, the wake keeps the turn start', async () => {
  const log = { id: 'c1', updatedAt: 5, aiName: 'Local', messages: [{ id: 'u0', role: 'user', content: 'old' }] };
  const saves: Array<Record<string, unknown>> = [];
  let minted = 0;
  let disk = 5;
  const now = T + 3_600_000;
  const deps: RunTurnDeps = {
    loadLog: async () => log,
    saveLog: async (_c: string, logData: Record<string, unknown>) => { disk += 1; saves.push(logData); return { ok: true, writtenUpdatedAt: disk }; },
    chatPost: async () => ({ ok: true, status: 200, body: bodyOf([frame({ type: 'text', content: 'ok' })]) }) as unknown as Response,
    globalSettings: {}, enableReadConversation: false,
    folderDefaults: { aiName: 'Local', folderName: 'Default', systemPrompt: '', specificModel: 'gemma-4-26b', modelParams: {} },
    newId: () => `m-${++minted}`, nowMs: () => now, clientId: 'runner:test', origin: 'http://localhost:3000', injectTurnId: 'turn_t',
  } as unknown as RunTurnDeps;

  const items = [
    { id: 'q1', at: T, kind: 'user_message', from: 'つよ', payload: { text: 'first', attachments: [] } },
    { id: 'q2', at: T + 3_000_000, kind: 'user_message', from: 'つよ', payload: { text: 'second', attachments: [] } },
    { id: 'q3', at: now, kind: 'system', from: 'NEXUS', payload: { text: '[NEXUS]\n定刻', attachments: [], fullText: 'FULL', purpose: 'wake' } },
  ] as unknown as QueueItem[];

  const res = await runTurnForQueue('Default', 'c1', items, deps);
  assert.equal(res.ok, true);

  const added = (saves[saves.length - 1].messages as Array<Record<string, any>>).slice(1);
  assert.deepEqual(added.map((m) => m.role), ['user', 'user', 'user', 'assistant']);
  assert.equal(added[0].timestamp, T, 'the first message carries the time it was written');
  assert.equal(added[1].timestamp, T + 3_000_000, 'and so does the second — not the moment they were delivered');
  assert.equal(added[2].timestamp, now, 'the wake is stamped when the clock fired');
  assert.ok(added[0].timestamp < added[1].timestamp && added[1].timestamp < added[2].timestamp);
});
