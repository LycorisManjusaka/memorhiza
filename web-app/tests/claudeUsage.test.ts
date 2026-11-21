import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { windowsFromRateLimitInfo, mergeUsage, viewWindow, parseSnapshot, weekPace, WEEK_MS } from '@/lib/claudeUsage';

// Lizard-kun's case, 2026-11-15 15:43: week 31%, resets 11/20 17:00.
// Start = 11/13 17:00 → 46h43m elapsed of 168h ≈ 27.8% → 31% is ahead.
test('weekPace: elapsed share counts from resetsAt minus 7 days; above it is ahead', () => {
  const resetsAt = new Date(2026, 10, 20, 17, 0).getTime();
  const now = new Date(2026, 10, 15, 15, 43).getTime();
  const p = weekPace({ state: 'live', pct: 31, resetsAt }, now);
  assert.ok(p);
  assert.equal(p!.elapsedPct, 27.8);
  assert.equal(p!.ahead, true);
  assert.equal(weekPace({ state: 'live', pct: 27, resetsAt }, now)!.ahead, false);
  // Right after the window opens, 0% elapsed; at the reset, 100%.
  assert.equal(weekPace({ state: 'live', pct: 0, resetsAt }, resetsAt - WEEK_MS)!.elapsedPct, 0);
  assert.equal(weekPace({ state: 'live', pct: 0, resetsAt }, resetsAt)!.elapsedPct, 100);
});

// つよ, 2026-11-21: when ahead, the time the even-pace line reaches the usage.
test('weekPace: catchUpAt is when the pace line reaches the usage, only while ahead', () => {
  const resetsAt = new Date(2026, 10, 27, 17, 0).getTime();
  const start = resetsAt - WEEK_MS;
  const now = start + 0.156 * WEEK_MS;
  const p = weekPace({ state: 'live', pct: 17, resetsAt }, now)!;
  assert.equal(p.ahead, true);
  assert.equal(p.catchUpAt, start + 0.17 * WEEK_MS);
  assert.equal(weekPace({ state: 'live', pct: 10, resetsAt }, now)!.catchUpAt, null);
  assert.equal(weekPace({ state: 'live', pct: 100, resetsAt }, now)!.catchUpAt, resetsAt);
});

test('weekPace: no pace without a live window and a reset time', () => {
  assert.equal(weekPace({ state: 'unknown' }, 0), null);
  assert.equal(weekPace({ state: 'live', pct: 50, resetsAt: null }, 0), null);
  assert.equal(weekPace({ state: 'reset', resetsAt: 1 }, 2), null);
});
import { recordRateLimitInfo, readClaudeUsage } from '@/lib/claudeUsageStore';

// The rate_limit_info a live Haiku OAuth turn emitted on 2026-11-14 (the
// Claude.ai usage page read 50% / 8% at the time).
const MEASURED = {
  status: 'allowed', resetsAt: 1794633600, rateLimitType: 'five_hour',
  overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', isUsingOverage: false,
  unifiedWindows: {
    five_hour: { utilization: 0.55, resetsAt: 1794633600, status: 'allowed' },
    seven_day: { utilization: 0.07, resetsAt: 1795161600, status: 'allowed' },
  },
};

test('reads both windows from unifiedWindows, seconds → ms', () => {
  const w = windowsFromRateLimitInfo(MEASURED)!;
  assert.equal(w.fiveHour!.utilization, 0.55);
  assert.equal(w.fiveHour!.resetsAt, 1794633600 * 1000);
  assert.equal(w.sevenDay!.utilization, 0.07);
});

test('documented single-window form is the fallback', () => {
  const w = windowsFromRateLimitInfo({ rateLimitType: 'seven_day', utilization: 0.3, resetsAt: 1795161600 })!;
  assert.equal(w.sevenDay!.utilization, 0.3);
  assert.equal(w.fiveHour, undefined);
});

test('an event with no utilization yields nothing (no invented 0%)', () => {
  assert.equal(windowsFromRateLimitInfo({ status: 'allowed', rateLimitType: 'five_hour' }), null);
});

test('merge keeps the window an event did not mention', () => {
  const prev = mergeUsage(null, windowsFromRateLimitInfo(MEASURED)!, 1);
  const next = mergeUsage(prev, { fiveHour: { utilization: 0.6, resetsAt: null } }, 2);
  assert.equal(next.fiveHour!.utilization, 0.6);
  assert.equal(next.sevenDay!.utilization, 0.07);
  assert.equal(next.capturedAt, 2);
});

test('a window past its reset never shows the old percentage', () => {
  const w = { utilization: 0.55, resetsAt: 1000 };
  assert.deepEqual(viewWindow(w, 999), { state: 'live', pct: 55, resetsAt: 1000 });
  assert.equal(viewWindow(w, 1000).state, 'reset');
  assert.equal(viewWindow(undefined, 0).state, 'unknown');
});

test('store: record → read round trip, merged per window', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cu-')), 'claude_usage.json');
  assert.equal(readClaudeUsage(file), null);
  await recordRateLimitInfo(MEASURED, file, 10);
  await recordRateLimitInfo({ rateLimitType: 'five_hour', utilization: 0.61, resetsAt: 1794633600 }, file, 20);
  const s = readClaudeUsage(file)!;
  assert.equal(s.fiveHour!.utilization, 0.61);
  assert.equal(s.sevenDay!.utilization, 0.07);
  assert.equal(s.capturedAt, 20);
  assert.equal(parseSnapshot({ nope: 1 }), null);
});
