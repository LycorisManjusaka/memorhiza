import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { claim, enqueue, pending, release, readLease, holderIsGone } from '@/lib/turnQueue';
import { isQuietItem } from '@/lib/quietStock';
import { leaveQuietInLog, type QuietLeaveDeps } from '@/lib/quietLeave';

// The real queue on a temp dir, and a log held in memory with the same
// version guard fsStorage applies (refuse when the caller's base is not disk).
async function world(initial: Record<string, unknown> | null = { title: 'T', updatedAt: 100, messages: [{ id: 'm0', role: 'assistant', content: 'done' }] }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nxql-'));
  const opts = { beingsDir: root };
  let log = initial ? structuredClone(initial) : null;
  let saves = 0;
  let n = 0;
  const state = { soul: false, refuseNext: 0 };
  const deps: QuietLeaveDeps = {
    pending: (b, c) => pending(b, c, opts),
    claimQuiet: (b, c, h) => claim(b, c, h, { ...opts, accept: isQuietItem }),
    release: (b, c, t, ids) => release(b, c, t, ids, opts),
    loadLog: async () => (log ? structuredClone(log) : null),
    saveLog: async (_id, data, o) => {
      if (state.refuseNext > 0) {
        state.refuseNext--;
        // Another writer landed first: disk moves, the save is refused.
        (log as Record<string, unknown>).updatedAt = Number((log as Record<string, unknown>).updatedAt) + 1;
        (log as Record<string, unknown>).title = 'changed elsewhere';
        return { ok: false, conflict: {} };
      }
      if (o.expectedUpdatedAt !== (log as Record<string, unknown>).updatedAt) return { ok: false, conflict: {} };
      saves++;
      log = { ...structuredClone(data), updatedAt: Number((log as Record<string, unknown>).updatedAt) + 1 };
      return { ok: true, writtenUpdatedAt: Number(log.updatedAt) };
    },
    soulUpdateRunning: async () => (state.soul ? { label: 'x' } : null),
    turnRunning: async (b, c) => { const l = await readLease(b, c, opts); return !!l && !holderIsGone(l.pid); },
    newId: () => `new${++n}`,
    nowMs: () => Date.now() + 1000,
    clientId: 'quiet:test',
  };
  const add = (text: string, quiet: boolean) =>
    enqueue('B', 'c1', { kind: 'user_message', from: 'u', payload: { text, attachments: [] }, quiet }, opts);
  return {
    deps, add, state, opts,
    log: () => log as Record<string, unknown>,
    saves: () => saves,
    waiting: () => pending('B', 'c1', opts),
    done: () => fs.rm(root, { recursive: true, force: true }),
  };
}

test('a quiet message is written into the log and leaves the stock; nothing else is touched', async () => {
  const w = await world();
  const { item } = await w.add('confirmed, thank you', true);
  const r = await leaveQuietInLog('B', 'c1', w.deps);
  assert.equal(r.written, 1);
  const msgs = w.log().messages as Array<Record<string, unknown>>;
  assert.equal(msgs.length, 2);
  assert.deepEqual(
    { role: msgs[1].role, content: msgs[1].content, timestamp: msgs[1].timestamp },
    { role: 'user', content: 'confirmed, thank you', timestamp: item.at },
    'a user message carrying the time it was WRITTEN',
  );
  assert.equal(msgs[0].id, 'm0', 'what was there stays in front');
  assert.equal(w.log().title, 'T', 'the other fields travel untouched');
  assert.equal((await w.waiting()).length, 0, 'nothing is left waiting for a trigger');
  // The lease went back: the queue can be claimed again.
  await w.add('next', false);
  assert.equal((await claim('B', 'c1', 'x', w.opts)).ok, true);
  await w.done();
});

test('several quiet messages go in together, in the order they were written', async () => {
  const w = await world();
  await w.add('one', true);
  await w.add('two', true);
  const r = await leaveQuietInLog('B', 'c1', w.deps);
  assert.equal(r.written, 2);
  const msgs = w.log().messages as Array<Record<string, unknown>>;
  assert.match(String(msgs[1].content), /one$/);
  assert.match(String(msgs[2].content), /two$/);
  assert.ok(Number(msgs[2].timestamp) > Number(msgs[1].timestamp));
  assert.equal(w.saves(), 1, 'one save, not one per message');
  await w.done();
});

test('a turn holds the lease → nothing is written, the item waits as it was', async () => {
  const w = await world();
  await w.add('running', false);
  const held = await claim('B', 'c1', 'runner', w.opts);
  assert.equal(held.ok, true);
  await w.add('left during the turn', true);
  const r = await leaveQuietInLog('B', 'c1', w.deps);
  assert.deepEqual({ written: r.written, reason: r.reason }, { written: 0, reason: 'busy' });
  assert.equal((w.log().messages as unknown[]).length, 1, 'the log belongs to the turn');
  // The turn ends having consumed its own item; the quiet one goes in now.
  if (held.ok) await release('B', 'c1', held.claim.token, held.claim.items.map((i) => i.id), w.opts);
  const after = await leaveQuietInLog('B', 'c1', w.deps);
  assert.equal(after.written, 1);
  await w.done();
});

test('something that is not quiet waits too → the quiet one does not jump ahead of it', async () => {
  const w = await world();
  await w.add('stocked first', false);
  await w.add('quiet second', true);
  const r = await leaveQuietInLog('B', 'c1', w.deps);
  assert.deepEqual({ written: r.written, reason: r.reason }, { written: 0, reason: 'mixed' });
  assert.equal((await w.waiting()).length, 2);
  assert.equal(w.saves(), 0);
  await w.done();
});

test('a stocked message alone is never consumed by this path', async () => {
  const w = await world();
  await w.add('stocked', false);
  const r = await leaveQuietInLog('B', 'c1', w.deps);
  assert.deepEqual({ written: r.written, reason: r.reason }, { written: 0, reason: 'none' });
  assert.equal((await w.waiting()).length, 1);
  await w.done();
});

test('a soul update is running → the log is left alone and the item stays for the move', async () => {
  const w = await world();
  w.state.soul = true;
  await w.add('later', true);
  const r = await leaveQuietInLog('B', 'c1', w.deps);
  assert.deepEqual({ written: r.written, reason: r.reason }, { written: 0, reason: 'soul-update' });
  assert.equal((await w.waiting()).length, 1);
  await w.done();
});

test('a refused save is retried once onto what is on disk now; a second refusal keeps the item', async () => {
  const w = await world();
  await w.add('hello', true);
  w.state.refuseNext = 1;
  const r = await leaveQuietInLog('B', 'c1', w.deps);
  assert.equal(r.written, 1);
  assert.equal(w.log().title, 'changed elsewhere', 'the other writer\'s change is kept, not overwritten');
  assert.equal((w.log().messages as unknown[]).length, 2);

  await w.add('again', true);
  w.state.refuseNext = 2;
  const r2 = await leaveQuietInLog('B', 'c1', w.deps);
  assert.deepEqual({ written: r2.written, reason: r2.reason }, { written: 0, reason: 'conflict' });
  assert.equal((await w.waiting()).length, 1, 'not consumed: nothing is lost by a refusal');
  assert.equal((await claim('B', 'c1', 'x', w.opts)).ok, true, 'and the lease went back');
  await w.done();
});

test('no log on disk → nothing written, nothing consumed', async () => {
  const w = await world(null);
  await w.add('hello', true);
  const r = await leaveQuietInLog('B', 'c1', w.deps);
  assert.deepEqual({ written: r.written, reason: r.reason }, { written: 0, reason: 'no-log' });
  assert.equal((await w.waiting()).length, 1);
  await w.done();
});
