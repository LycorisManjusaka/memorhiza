import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { claim, enqueue, holderIsGone, LEASE_NAME } from '@/lib/turnQueue';

test('holderIsGone: only a pid that does not exist counts', () => {
  assert.equal(holderIsGone(process.pid), false);
  assert.equal(holderIsGone(undefined), false);
  assert.equal(holderIsGone(0), false);
  assert.equal(holderIsGone(2147483000), true);
});

test('claim: a lease left by a dead process is freed; a live one is not (2026-11-17)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nxq-'));
  const opts = { beingsDir: root };
  await enqueue('B', 'c1', { kind: 'user_message', from: 'u', payload: { text: 'hi' } }, opts);
  const dir = path.join(root, 'B', 'queue', 'c1');
  const write = (pid: number) => fs.writeFile(path.join(dir, LEASE_NAME),
    JSON.stringify({ token: 't', holder: 'old', pid, startedAt: 1, lastSeen: 1, convoId: 'c1' }));
  await write(process.ppid || 1);
  const busy = await claim('B', 'c1', 'me', opts);
  assert.equal(busy.ok, false, 'a live holder keeps its lease');
  await write(2147483000);
  const r = await claim('B', 'c1', 'me', opts);
  assert.equal(r.ok, true, 'a dead holder does not');
  await fs.rm(root, { recursive: true, force: true });
});
