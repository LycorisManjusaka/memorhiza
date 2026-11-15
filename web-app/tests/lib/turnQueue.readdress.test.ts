/**
 * readdressPendingItem — "deliver to this NEXUS" (2026-11-16, つよ).
 *
 * 謡's `[->睡]` was addressed to 3000 while everyone lives on 3001; the panel
 * could delete it but not move it. What would look different without each:
 *   "the address changes"         — absent, the button does nothing.
 *   "text and attachments stay"   — absent, delivering a message loses it.
 *   "the file name stays"         — absent, the moved item jumps the queue.
 *   "an empty host is refused"    — absent, "here" silently becomes "the
 *       store-level host", which may be the other install again.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { enqueue, pending, queueDir, readdressPendingItem } from '../../src/lib/turnQueue';

let root = '';
let opts: { beingsDir: string };
const BEING = 'TestBeing';
const CONVO = 'convo-readdress';

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-readdress-'));
  opts = { beingsDir: root };
});
after(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('turnQueue — readdress a waiting item', () => {
  it('moves the address and keeps body, attachments and file name', async () => {
    const a = await enqueue(BEING, CONVO, {
      kind: 'user_message', from: '謡',
      payload: { text: '[謡]\nおやすみ', attachments: [{ id: 'att1' }] },
      host: 'c:\\dev\\nexus',
    }, opts);
    const before = (await fs.readdir(queueDir(BEING, CONVO, opts))).sort();

    assert.deepEqual(await readdressPendingItem(BEING, CONVO, a.item.id, 'c:\\dev\\nexus-cairn', opts), { ok: true });

    assert.deepEqual((await fs.readdir(queueDir(BEING, CONVO, opts))).sort(), before);
    const [it] = await pending(BEING, CONVO, opts);
    assert.equal(it.host, 'c:\\dev\\nexus-cairn');
    assert.deepEqual(it.payload, { text: '[謡]\nおやすみ', attachments: [{ id: 'att1' }] });
  });

  it('refuses an empty host and leaves the item as it was', async () => {
    const [it] = await pending(BEING, CONVO, opts);
    assert.deepEqual(await readdressPendingItem(BEING, CONVO, it.id, '  ', opts), { ok: false, reason: 'empty' });
    assert.equal((await pending(BEING, CONVO, opts))[0].host, 'c:\\dev\\nexus-cairn');
  });

  it('reports not-found for an unknown id', async () => {
    assert.deepEqual(await readdressPendingItem(BEING, CONVO, 'nope', 'x', opts), { ok: false, reason: 'not-found' });
  });
});
