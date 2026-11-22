import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBackgroundNote, selfWakeBookable, parseWakeSettings } from '@/lib/wakeSchedule';

test('background note: no wakeup sentence unless the being can book', () => {
  for (const lang of ['ja', 'en'] as const) {
    assert.ok(!buildBackgroundNote(lang, false).includes('[->wakeup'));
    assert.ok(buildBackgroundNote(lang, true).includes('[->wakeup: HH:MM]'));
    assert.ok(buildBackgroundNote(lang, false).includes('run_in_background'));
  }
});

test('selfWakeBookable: needs self ON and a cap above 0', () => {
  assert.equal(selfWakeBookable(parseWakeSettings(undefined)), false);
  assert.equal(selfWakeBookable(parseWakeSettings({ self: { enabled: true, maxPerDay: 0 } })), false);
  assert.equal(selfWakeBookable(parseWakeSettings({ self: { enabled: false, maxPerDay: 3 } })), false);
  assert.equal(selfWakeBookable(parseWakeSettings({ self: { enabled: true, maxPerDay: 1 } })), true);
});
