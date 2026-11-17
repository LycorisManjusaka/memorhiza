import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoStopAtFullEnabled, autoTurnsHeld, autoTurnsHeldForLog, isWakeItem,
  logContextElapsedPercent, passIsUnattended,
} from '../src/lib/autoHold';
import { WAKE_PURPOSE } from '../src/lib/wakeSchedule';
import { SURGERY_PURPOSE } from '../src/lib/soulSurgery';

// つよ, 2026-11-17: "コンテキストが100%だと自動ターンを止める" — default ON,
// stock stays where it is, a person's message and ζ still run.

const long = 'あいうえおかきくけこ'.repeat(400);
const fullLog = (extra: Record<string, unknown> = {}) => ({
  aiName: 'Claude',
  messages: [
    { id: 'u1', role: 'user', content: long },
    { id: 'a1', role: 'assistant', content: long },
  ],
  ...extra,
});

test('absent on disk means ON; only an explicit false switches it off', () => {
  assert.equal(autoStopAtFullEnabled(undefined), true);
  assert.equal(autoStopAtFullEnabled(null), true);
  assert.equal(autoStopAtFullEnabled(true), true);
  assert.equal(autoStopAtFullEnabled('false'), true);   // a typo is not a request
  assert.equal(autoStopAtFullEnabled(false), false);
});

test('held from exactly 100%, not before', () => {
  assert.equal(autoTurnsHeld(undefined, 99), false);
  assert.equal(autoTurnsHeld(undefined, 100), true);
  assert.equal(autoTurnsHeld(undefined, 39700), true);
  assert.equal(autoTurnsHeld(false, 39700), false);
});

test('a stored log over the being\'s cap is held; the same log under a roomy cap is not', () => {
  const log = fullLog();
  assert.ok(logContextElapsedPercent(log, 'Claude', 1000) >= 100);
  assert.equal(autoTurnsHeldForLog(log, { maxConversationLog: 1000 }), true);
  assert.equal(autoTurnsHeldForLog(log, { maxConversationLog: 10_000_000 }), false);
  // The switch on the CONVERSATION wins over the reading.
  assert.equal(autoTurnsHeldForLog(fullLog({ autoStopAtFull: false }), { maxConversationLog: 1000 }), false);
  // No log → nothing to hold (the clock reports "no conversation" itself).
  assert.equal(autoTurnsHeldForLog(null, { maxConversationLog: 1000 }), false);
});

test('copied messages do not count: a freshly slept conversation reads 0% and is not held', () => {
  const log = fullLog({ firstOriginalIsNext: true });
  assert.equal(logContextElapsedPercent(log, 'Claude', 1000), 0);
  assert.equal(autoTurnsHeldForLog(log, { maxConversationLog: 1000 }), false);
});

test('a wake is automatic; ζ shares kind "system" and is NOT', () => {
  assert.equal(isWakeItem({ kind: 'system', payload: { purpose: WAKE_PURPOSE } }), true);
  assert.equal(isWakeItem({ kind: 'system', payload: { purpose: SURGERY_PURPOSE } }), false);
  assert.equal(isWakeItem({ kind: 'user_message', payload: { purpose: WAKE_PURPOSE } }), false);
  assert.equal(isWakeItem({ kind: 'system' }), false);
});

test('only auto and wake passes are unattended — a plain tick has a hand behind it', () => {
  assert.equal(passIsUnattended({ auto: false, wake: false }), false);
  assert.equal(passIsUnattended({ auto: true, wake: false }), true);
  assert.equal(passIsUnattended({ auto: false, wake: true }), true);
});
