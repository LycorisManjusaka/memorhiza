import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRecordHolds, type RunLiveness } from '../src/lib/soulUpdateHold.ts';
import { splitRecipientNames } from '../src/lib/letters.ts';

const live = (over: Partial<RunLiveness> = {}): RunLiveness => ({
  isGone: () => false,
  selfPid: 1000,
  liveHere: () => true,
  ...over,
});
const rec = (over: Record<string, unknown> = {}) => ({
  status: 'running', pid: 2000, label: '5', action: 'update', host: 'C:\\dev\\nexus-cairn', startedAt: 1, ...over,
});

test('a running record whose process is alive holds the being', () => {
  const r = runRecordHolds(rec(), live());
  assert.equal(r?.label, '5');
  assert.equal(r?.action, 'update');
});

test('a finished run holds nothing (the soul not yet written is NOT a hold)', () => {
  for (const status of ['done', 'stopped', 'error']) {
    assert.equal(runRecordHolds(rec({ status }), live()), null);
  }
});

test('a crashed process leaves "running" behind, and it holds nothing', () => {
  assert.equal(runRecordHolds(rec(), live({ isGone: () => true })), null);
});

test('records from before pid existed never hold (no guessing)', () => {
  assert.equal(runRecordHolds(rec({ pid: undefined }), live()), null);
  assert.equal(runRecordHolds(rec({ pid: 0 }), live()), null);
});

test('in this same process, the relay decides', () => {
  assert.ok(runRecordHolds(rec({ pid: 1000 }), live({ liveHere: () => true })));
  assert.equal(runRecordHolds(rec({ pid: 1000 }), live({ liveHere: () => false })), null);
});

test('admin recipients: commas of every width, newlines, duplicates once', () => {
  assert.deepEqual(splitRecipientNames('謡, 先輩、睡，謡\nミニちゃん'), ['謡', '先輩', '睡', 'ミニちゃん']);
  assert.deepEqual(splitRecipientNames(['謡', ' 先輩 ', '']), ['謡', '先輩']);
  assert.deepEqual(splitRecipientNames(undefined), []);
});
