import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { claimSlot, setClockHost, clearClockHost, thisInstallationRunsClock, recordSelfWakeFromReply, readWakeState } from '../src/lib/wakeClock';

async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'wake-')); }

test('the clock file names exactly one installation; absent = nobody', async () => {
  const d = await tmp();
  assert.equal(await thisInstallationRunsClock('C:\dev\nexus-cairn', d), false, 'absent → no clock');
  await setClockHost('C:\dev\nexus-cairn', d);
  assert.equal(await thisInstallationRunsClock('c:\dev\nexus-cairn', d), true, 'case-insensitive like runner.json');
  assert.equal(await thisInstallationRunsClock('C:\dev\nexus', d), false, 'the other clone does not run it');
  assert.equal(await clearClockHost(d), true);
  assert.equal(await thisInstallationRunsClock('C:\dev\nexus-cairn', d), false);
});

test('a slot can be claimed exactly once, even by claims racing in the same instant', async () => {
  const d = await tmp();
  const results = await Promise.all(Array.from({ length: 8 }, () => claimSlot('謡', '2026-11-16_0400_admin', d)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await claimSlot('謡', '2026-11-16_1600_admin', d), true, 'a different slot is its own claim');
});

test('a reply with a valid directive is booked; a bad one leaves a rejection for the next wake', async () => {
  const d = await tmp();
  const now = new Date(2026, 10, 16, 22, 0).getTime();
  const settings = { wake: { self: { enabled: true, maxPerDay: 1, minGapMin: 15 } } };
  await recordSelfWakeFromReply('睡', 'おやすみ\n[->wakeup: 03:00]', settings, now, d);
  let s = await readWakeState('睡', d);
  assert.equal(s.bookings.length, 1);
  assert.equal(s.bookings[0].hhmm, '03:00');
  await recordSelfWakeFromReply('睡', '[->wakeup: 05:00]', settings, now, d);
  s = await readWakeState('睡', d);
  assert.equal(s.bookings.length, 1, 'cap of one per day');
  assert.equal(s.rejection?.reason, 'daily-cap');
  await recordSelfWakeFromReply('睡', 'no directive here', settings, now, d);
  assert.equal((await readWakeState('睡', d)).history.length, 2, 'no directive writes nothing');
});

test('an administrator can move a self-booking past the being\'s limits, and delete one', async () => {
  const { removeBooking, moveBooking } = await import('../src/lib/wakeClock');
  const d = await tmp();
  const now = new Date(2026, 10, 16, 22, 0).getTime();
  const settings = { wake: { self: { enabled: true, maxPerDay: 3, minGapMin: 15, windowFrom: '02:00', windowTo: '06:00' } } };
  await recordSelfWakeFromReply('睡', '[->wakeup: 03:00]', settings, now, d);
  const at = (await readWakeState('睡', d)).bookings[0].at;
  // 23:30 is outside the being's window — the administrator is not bound by it.
  const moved = await moveBooking('睡', at, '23:30', now, d);
  assert.ok(moved);
  assert.equal(moved!.hhmm, '23:30');
  assert.equal(moved!.at, new Date(2026, 10, 16, 23, 30).getTime(), 'still ahead today → today');
  let s = await readWakeState('睡', d);
  assert.deepEqual(s.bookings.map(b => b.hhmm), ['23:30'], 'moved, not duplicated');
  assert.equal(s.history.at(-1)?.kind, 'admin-moved');
  assert.equal(s.history.at(-1)?.detail, '03:00', 'the old time is kept in the record');
  assert.equal(await moveBooking('睡', moved!.at, '25:00', now, d), null, 'not a real time');
  assert.equal(await moveBooking('睡', 12345, '04:00', now, d), null, 'no such booking');
  assert.equal(await removeBooking('睡', moved!.at, now, d), true);
  s = await readWakeState('睡', d);
  assert.equal(s.bookings.length, 0);
  assert.equal(s.history.at(-1)?.kind, 'admin-removed');
  assert.equal(await removeBooking('睡', moved!.at, now, d), false, 'already gone');
});
