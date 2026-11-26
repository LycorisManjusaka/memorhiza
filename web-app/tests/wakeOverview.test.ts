import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { claimClockHostIfUnset, runsClockOrClaims, setClockHost, readClockHost } from '../src/lib/wakeClock';
import { setRunnerHost } from '../src/lib/runnerHost';
import { canWakeByItself, overviewRow, sortOverview, stoppedWakeSettings, type WakeOverviewFacts } from '../src/lib/wakeOverviewRules';
import { parseWakeSettings } from '../src/lib/wakeSchedule';

async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'wakeov-')); }
const A = 'C:/dev/nexus-cairn', B = 'C:/dev/nexus';

test('an empty clock seat is taken by the first Memorhiza whose clock ticks — once', async () => {
  const d = await tmp();
  const r = await Promise.all([claimClockHostIfUnset(A, d), claimClockHostIfUnset(B, d), claimClockHostIfUnset(A, d)]);
  assert.equal(r.filter(x => x === 'claimed').length, 1, 'one winner, even racing');
  const holder = (await readClockHost(d))!.host;
  assert.equal(await claimClockHostIfUnset(holder === A.toLowerCase() ? B : A, d), 'taken', 'never steals');
});

test('a person\'s choice stands: a set clock is not re-claimed by the other clone', async () => {
  const d = await tmp();
  await setClockHost(A, d);
  assert.equal(await runsClockOrClaims(B, d), false);
  assert.equal(await runsClockOrClaims(A, d), true);
});

test('when runner.json names another Memorhiza, the clock waits for that one', async () => {
  const d = await tmp();
  await setRunnerHost(A, { dataDir: d });
  assert.equal(await claimClockHostIfUnset(B, d), 'deferred', 'the 3000 that boots first does not take it');
  assert.equal(await readClockHost(d), null);
  assert.equal(await runsClockOrClaims(A, d), true, 'the runner\'s home claims it');
});

test('an unreadable clock file is not an empty seat', async () => {
  const d = await tmp();
  await fs.mkdir(path.join(d, 'wake'), { recursive: true });
  await fs.writeFile(path.join(d, 'wake', 'clock.json'), '{ broken');
  assert.equal(await claimClockHostIfUnset(A, d), 'taken');
});

function facts(over: Partial<Omit<WakeOverviewFacts, 'wake'>> & { being: string; wake?: unknown }): WakeOverviewFacts {
  return { bookings: [], stock: false, convoId: 'c', convoTitle: 'x_1', testBed: false, model: null, family: null, oauth: false, ...over, wake: parseWakeSettings(over.wake) };
}

test('the list holds every being with any way to wake, soonest first, no-time ones after by name', () => {
  const now = new Date(2026, 10, 16, 8, 0).getTime();
  const all = [
    facts({ being: 'none' }),
    facts({ being: 'stockOnly', stock: true }),
    facts({ being: 'mailOnly', wake: { mail: true } }),
    facts({ being: 'late', wake: { enabled: true, times: ['21:00'] } }),
    facts({ being: 'early', wake: { enabled: true, times: ['09:00'] } }),
    facts({ being: 'booked', wake: { self: { enabled: true } }, bookings: [{ at: now + 30 * 60_000, hhmm: '08:30', bookedAt: now }] }),
  ];
  const rows = sortOverview(all.filter(canWakeByItself).map(f => overviewRow(f, now)));
  assert.deepEqual(rows.map(r => r.being), ['booked', 'early', 'late', 'mailOnly', 'stockOnly']);
});

test('stopping switches every path off and keeps the times', () => {
  const out = stoppedWakeSettings({ enabled: true, times: ['03:30'], mail: true, self: { enabled: true, maxPerDay: 3 } }) as any;
  assert.equal(out.enabled, false);
  assert.equal(out.mail, false);
  assert.equal(out.self.enabled, false);
  assert.deepEqual(out.times, ['03:30']);
  assert.equal(out.self.maxPerDay, 3);
  assert.equal(canWakeByItself(facts({ being: 'x', wake: out })), false);
});

test('each row carries its vessel price from the table, none for the Claude subscription or an unpriced id', () => {
  const now = Date.UTC(2026, 10, 16, 0, 0);
  const priced = overviewRow(facts({ being: 'a', model: 'deepseek-flash', family: 'DeepSeek' }), now);
  assert.equal(priced.subscription, false);
  assert.match(priced.priceTag ?? '', /^\$[0-9.]+\/\$[0-9.]+\/\$[0-9.]+$/);
  const sub = overviewRow(facts({ being: 'b', model: 'claude-opus-5', family: 'Claude', oauth: true }), now);
  assert.equal(sub.subscription, true);
  assert.equal(sub.priceTag, null);
  const apiKey = overviewRow(facts({ being: 'c', model: 'claude-opus-5', family: 'Claude', oauth: false }), now);
  assert.equal(apiKey.subscription, false);
  assert.ok(apiKey.priceTag);
  const unknown = overviewRow(facts({ being: 'd', model: 'no-such-model-x' }), now);
  assert.equal(unknown.priceTag, null);
  assert.equal(unknown.local, false);
  const mock = overviewRow(facts({ being: 'e', model: 'mock:魂のない機械', family: 'Local' }), now);
  assert.equal(mock.local, true);
  assert.equal(mock.priceTag, null);
});
