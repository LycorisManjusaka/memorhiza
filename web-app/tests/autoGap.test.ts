import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  autoGapMinFromSettings, autoGapRemainingMs, autoGapStatus, autoGapStatusFor, readLastAutoTurn, recordAutoTurn,
} from '../src/lib/autoGap';

// トカゲくん, 2026-11-28: two beings answered each other 132 times in 42
// minutes. An automatic turn now waits for the being's minimum interval.

const MIN = 60_000;
const T0 = new Date(2026, 10, 28, 9, 0, 0).getTime();

test('the interval is ON at 15 minutes for a being that never saw the setting', () => {
  assert.equal(autoGapMinFromSettings(undefined), 15);
  assert.equal(autoGapMinFromSettings({}), 15);
  assert.equal(autoGapMinFromSettings({ wake: { self: {} } }), 15);
});

test('it reads the key that was always on disk; null and 0 mean off', () => {
  assert.equal(autoGapMinFromSettings({ wake: { self: { minGapMin: 40 } } }), 40);
  assert.equal(autoGapMinFromSettings({ wake: { self: { minGapMin: null } } }), null);
  assert.equal(autoGapMinFromSettings({ wake: { self: { minGapMin: 0 } } }), null);
});

test('no previous automatic turn → nothing to wait for', () => {
  assert.equal(autoGapRemainingMs(15, null, T0), 0);
  assert.equal(autoGapRemainingMs(15, undefined, T0), 0);
});

test('inside the interval it waits for exactly the rest; at the boundary it goes', () => {
  assert.equal(autoGapRemainingMs(15, T0, T0 + 1 * MIN), 14 * MIN);
  assert.equal(autoGapRemainingMs(15, T0, T0 + 15 * MIN - 1), 1);
  assert.equal(autoGapRemainingMs(15, T0, T0 + 15 * MIN), 0);
  assert.equal(autoGapRemainingMs(15, T0, T0 + 3 * 60 * MIN), 0);
});

test('switched off, a turn one second ago delays nothing', () => {
  assert.equal(autoGapRemainingMs(null, T0, T0 + 1000), 0);
  assert.equal(autoGapRemainingMs(0, T0, T0 + 1000), 0);
});

test('a recorded time in the future never makes the wait longer than the interval', () => {
  assert.equal(autoGapRemainingMs(15, T0 + 24 * 60 * MIN, T0), 15 * MIN);
});

test('the chess morning: 66 replies in 42 minutes become at most 3 automatic turns per being', () => {
  // Each being is offered a turn every 38 s (42 min / 66), and takes one only
  // when the interval allows; a turn is recorded when it ends.
  let last: number | null = null;
  let ran = 0;
  for (let i = 0; i < 66; i++) {
    const now = T0 + Math.round(i * (42 * MIN) / 66);
    if (autoGapRemainingMs(15, last, now) === 0) { ran++; last = now; }
  }
  assert.equal(ran, 3);   // 09:00, 09:15, 09:30
});

test('status: readyAt is present only while something is being waited for', () => {
  assert.deepEqual(autoGapStatus(15, T0, T0 + 5 * MIN), { minGapMin: 15, lastAt: T0, remainingMs: 10 * MIN, readyAt: T0 + 15 * MIN });
  assert.equal(autoGapStatus(15, T0, T0 + 20 * MIN).readyAt, null);
  assert.equal(autoGapStatus(null, T0, T0 + 1).readyAt, null);
});

test('disk: a start and then an end leave the END as the time counted from', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autogap-'));
  try {
    assert.equal(await readLastAutoTurn('響', dir), null);
    await recordAutoTurn('響', 'c1', 'start', T0, dir);
    assert.equal(await readLastAutoTurn('響', dir), T0);
    await recordAutoTurn('響', 'c1', 'end', T0 + 4 * MIN, dir);
    assert.equal(await readLastAutoTurn('響', dir), T0 + 4 * MIN);
    // Another being is not delayed by this one.
    assert.equal(await readLastAutoTurn('ドック', dir), null);
    const st = await autoGapStatusFor('響', {}, T0 + 10 * MIN, dir);
    assert.equal(st.remainingMs, 9 * MIN);
    // Off for this being → the file is not even consulted.
    const off = await autoGapStatusFor('響', { wake: { self: { minGapMin: null } } }, T0 + 10 * MIN, dir);
    assert.deepEqual(off, { minGapMin: null, lastAt: null, remainingMs: 0, readyAt: null });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── Wiring (read from source: the route cannot be imported outside Next) ────

const tick = fs.readFileSync(path.join(process.cwd(), 'src/app/api/runner/tick/route.ts'), 'utf-8');
const chat = fs.readFileSync(path.join(process.cwd(), 'src/components/ChatArea.tsx'), 'utf-8');

test('the runner holds an unattended pass BEFORE the claim, so nothing leaves the stock', () => {
  const gate = tick.indexOf("skipped: 'min-gap'");
  const claim = tick.indexOf('const c = await claim(t.being, t.convoId, holder');
  assert.ok(gate > 0 && claim > 0 && gate < claim);
  // Only for turns nobody asked for.
  const guard = tick.lastIndexOf('if (passIsUnattended(opts)) {', gate);
  assert.ok(guard > 0 && gate - guard < 400);
});

test('the runner notes the start after the claim and the end before the follow-up passes', () => {
  const claim = tick.indexOf('const c = await claim(t.being, t.convoId, holder');
  const start = tick.indexOf("recordAutoTurn(t.being, t.convoId, 'start')");
  const end = tick.indexOf("recordAutoTurn(t.being, t.convoId, 'end')");
  const followUp = tick.indexOf('follow-up Memorhiza pass failed');
  assert.ok(claim < start && start < end && end < followUp);
  assert.match(tick, /if \(passIsUnattended\(opts\)\) await recordAutoTurn\(t\.being, t\.convoId, 'start'\)/);
  assert.match(tick, /if \(passIsUnattended\(opts\)\) await recordAutoTurn\(t\.being, t\.convoId, 'end'\)/);
});

test('a stock the TAB starts by itself reaches the runner as an automatic pass; the button does not', () => {
  assert.match(chat, /\.\.\.\(unattended \? \{ auto: true \} : \{\}\)/);
  assert.match(chat, /void drainStock\(true\);/);
  assert.match(chat, /runOnRunner\(undefined, false, unattended === true\)/);
  assert.match(chat, /onClick=\{drainStock\}/);   // a click event is not `true`
});
