import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { isQuietItem, onlyQuietWaiting } from '../../src/lib/quietStock';
import { enqueue, pending, editPendingItem } from '../../src/lib/turnQueue';
import { wakeShortText } from '../../src/lib/wakeSchedule';

// トカゲくん, 2026-11-28: "leave a message without waking the being" (a third
// send mode) and "start an automatic turn now" (a button).

let root = '';
let opts: { beingsDir: string };
before(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'memorhiza-quiet-')); opts = { beingsDir: root }; });
after(async () => { await fs.rm(root, { recursive: true, force: true }); });

const msg = (quiet?: boolean) => ({ kind: 'user_message', ...(quiet ? { quiet: true } : {}) });

test('only a plain message marked quiet is quiet', () => {
  assert.equal(isQuietItem(msg(true)), true);
  assert.equal(isQuietItem(msg()), false);
  assert.equal(isQuietItem({ kind: 'system', quiet: true }), false);
  assert.equal(isQuietItem({ kind: 'user_message', quiet: 'true' }), false);
});

test('all quiet → nothing starts by itself; one ordinary message among them → it does', () => {
  assert.equal(onlyQuietWaiting([msg(true), msg(true)]), true);
  assert.equal(onlyQuietWaiting([msg(true), msg()]), false);
});

test('a wake or a command beside a quiet message is not "only quiet"', () => {
  assert.equal(onlyQuietWaiting([msg(true), { kind: 'system' }]), false);
  assert.equal(onlyQuietWaiting([msg(true), { kind: 'rerun' }]), false);
});

test('an empty stock is not "only quiet" (it has its own answer everywhere)', () => {
  assert.equal(onlyQuietWaiting([]), false);
});

test('the flag is written on the item only when asked, and survives an edit', async () => {
  const a = await enqueue('B', 'c1', { from: 'x', payload: { text: 'thanks' }, quiet: true }, opts);
  const b = await enqueue('B', 'c1', { from: 'x', payload: { text: 'plain' } }, opts);
  assert.equal(a.item.quiet, true);
  assert.equal('quiet' in b.item, false);
  const r = await editPendingItem('B', 'c1', a.item.id, 'thanks, really', opts);
  assert.equal(r.ok, true);
  const after = await pending('B', 'c1', opts);
  assert.equal(after.find((i) => i.id === a.item.id)?.quiet, true);
  assert.equal(onlyQuietWaiting(after), false);
});

test('a command or a Memorhiza item cannot be made quiet', async () => {
  const s = await enqueue('B', 'c2', { kind: 'system', from: 'MEMORHIZA', payload: { text: 't' }, quiet: true }, opts);
  assert.equal('quiet' in s.item, false);
});

test('the button has its own first sentence — it does not claim a scheduled time came', () => {
  const ja = wakeShortText('ja', { source: 'manual', hhmm: '11:20' });
  const en = wakeShortText('en', { source: 'manual', hhmm: '11:20' });
  assert.ok(ja.startsWith('[MEMORHIZA]\n') && ja.includes('11:20') && !ja.includes('定刻'));
  assert.ok(en.startsWith('[MEMORHIZA]\n') && en.includes('11:20') && !en.includes('scheduled'));
  assert.ok(wakeShortText('ja', { source: 'admin', hhmm: '12:00' }).includes('定刻'));
});
