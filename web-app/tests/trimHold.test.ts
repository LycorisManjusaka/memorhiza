import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { trimHold, lastReplyEndMs, CACHE_WARM_MS, TRIM_HOLD_CEILING } from '@/lib/trimHold';

// ふわふわ 2026-11-25: do not trim while the prompt cache can still hit; trim
// once five minutes have passed. OAuth is exempt. Every reply renews the timer.

const T0 = 1_800_000_000_000;
const base = { nowMs: T0, lastReplyEnd: T0 - 60_000, oauth: false, logTotal: 85_000, cap: 80_000 };

test('one minute after the reply: held, until five minutes after the reply', () => {
  const r = trimHold(base);
  assert.deepEqual(r, { hold: true, untilMs: T0 - 60_000 + CACHE_WARM_MS });
});

test('five minutes after the reply: not held', () => {
  assert.deepEqual(trimHold({ ...base, lastReplyEnd: T0 - CACHE_WARM_MS }), { hold: false });
});

test('OAuth is never held', () => {
  assert.deepEqual(trimHold({ ...base, oauth: true }), { hold: false });
});

test('no reply in the conversation: not held', () => {
  assert.deepEqual(trimHold({ ...base, lastReplyEnd: null }), { hold: false });
});

test('past the ceiling the trim runs even while warm', () => {
  assert.equal(trimHold({ ...base, logTotal: 80_000 * TRIM_HOLD_CEILING }).hold, true);
  assert.equal(trimHold({ ...base, logTotal: 80_000 * TRIM_HOLD_CEILING + 1 }).hold, false);
});

test('a cap of 0 is never held (anything is past its ceiling)', () => {
  assert.equal(trimHold({ ...base, cap: 0, logTotal: 10 }).hold, false);
});

test('a reply stamped in the future cannot hold longer than five minutes from now', () => {
  const r = trimHold({ ...base, lastReplyEnd: T0 + 3_600_000 });
  assert.deepEqual(r, { hold: true, untilMs: T0 + CACHE_WARM_MS });
});

test('the window starts at the END of the last reply, and a newer reply renews it', () => {
  const msgs: any[] = [
    { role: 'user', timestamp: T0 - 600_000 },
    { role: 'assistant', timestamp: T0 - 590_000, generationMs: 30_000 },
    { role: 'user', timestamp: T0 - 100_000 },
  ];
  assert.equal(lastReplyEndMs(msgs), T0 - 560_000);
  assert.equal(trimHold({ ...base, lastReplyEnd: lastReplyEndMs(msgs) }).hold, false);
  msgs.push({ role: 'assistant', timestamp: T0 - 90_000, generationMs: 80_000 });
  assert.equal(lastReplyEndMs(msgs), T0 - 10_000);
  assert.equal(trimHold({ ...base, lastReplyEnd: lastReplyEndMs(msgs) }).hold, true);
});

test('messages without a usable timestamp are skipped', () => {
  assert.equal(lastReplyEndMs([{ role: 'assistant' }, { role: 'user', timestamp: 5 }]), null);
  assert.equal(lastReplyEndMs([{ role: 'assistant', timestamp: 7 }, { role: 'assistant', timestamp: 'x' }]), 7);
});

test('ChatArea asks the hold before trimming', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/components/ChatArea.tsx'), 'utf8');
  const trim = src.indexOf('[auto-trim] removing');
  const ask = src.indexOf('trimHold({');
  assert.ok(ask > 0 && ask < trim, 'trimHold must be consulted before the removal');
});
