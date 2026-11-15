import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renameWithRetry } from '../src/lib/atomicWrite';

const noSleep = async () => {};
const err = (code: string) => Object.assign(new Error(code), { code });

test('rename retries through a short EPERM window (a reader held the log open)', async () => {
  let calls = 0;
  await renameWithRetry('a', 'b', async () => {
    calls++;
    if (calls < 4) throw err('EPERM');
  }, noSleep);
  assert.equal(calls, 4);
});

test('rename gives up with the real error after the window', async () => {
  let calls = 0;
  await assert.rejects(
    renameWithRetry('a', 'b', async () => { calls++; throw err('EBUSY'); }, noSleep),
    /EBUSY/,
  );
  assert.equal(calls, 11);
});

test('non-locking errors are not retried', async () => {
  let calls = 0;
  await assert.rejects(
    renameWithRetry('a', 'b', async () => { calls++; throw err('ENOENT'); }, noSleep),
    /ENOENT/,
  );
  assert.equal(calls, 1);
});
