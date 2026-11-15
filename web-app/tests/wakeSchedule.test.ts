import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWakeSettings, parseTimeList, dueAdminSlots, dueSelfSlots, validateBooking, parseWakeupDirective,
  buildCapabilityList, buildSelfWakeLine, describeRejection, fillWakeTemplate, FALLBACK_WAKE_TEMPLATE,
  wakeShortText, nextAdminSlot, DEFAULT_MIN_GAP_MIN,
} from '../src/lib/wakeSchedule';

// 2026-11-16 is a Monday. Local time throughout, like the clock.
const at = (d: number, h: number, m: number, s = 0) => new Date(2026, 10, d, h, m, s).getTime();

test('absent settings are OFF with all seven days on and a 15-minute gap', () => {
  const w = parseWakeSettings(undefined);
  assert.equal(w.enabled, false);
  assert.equal(w.self.enabled, false);
  assert.deepEqual(w.days, [true, true, true, true, true, true, true]);
  assert.equal(w.self.minGapMin, DEFAULT_MIN_GAP_MIN);
  assert.equal(parseWakeSettings({ self: { minGapMin: null } }).self.minGapMin, null, 'gap can be switched off');
});

test('time list: normalised, sorted, de-duplicated; junk reported, not guessed', () => {
  assert.deepEqual(parseTimeList('16:00, 4:00、04:00 25:00 abc'), { times: ['04:00', '16:00'], invalid: ['25:00', 'abc'] });
});

test('admin slot fires inside its grace window, and only if it began after the clock started', () => {
  const w = parseWakeSettings({ enabled: true, times: ['04:00'] });
  assert.equal(dueAdminSlots(w, at(16, 4, 0, 30), 0).length, 1);
  assert.equal(dueAdminSlots(w, at(16, 3, 59, 59), 0).length, 0, 'not before its minute');
  assert.equal(dueAdminSlots(w, at(16, 4, 10), 0).length, 0, 'not long after');
  // Missed while stopped: the process started at 04:01, so 04:00 never fires late.
  assert.equal(dueAdminSlots(w, at(16, 4, 1, 30), at(16, 4, 1)).length, 0);
  const [s] = dueAdminSlots(w, at(16, 4, 0, 30), 0);
  assert.equal(s.key, '2026-11-16_0400_admin');
});

test('weekday buttons gate the slot (index = Date#getDay)', () => {
  const days = [true, false, true, true, true, true, true]; // Monday off
  const w = parseWakeSettings({ enabled: true, times: ['04:00'], days });
  assert.equal(dueAdminSlots(w, at(16, 4, 0, 30), 0).length, 0);
  assert.equal(dueAdminSlots(w, at(17, 4, 0, 30), 0).length, 1);
});

test('a 23:59 slot checked just after midnight is still found', () => {
  const w = parseWakeSettings({ enabled: true, times: ['23:59'] });
  const [s] = dueAdminSlots(w, at(17, 0, 0, 30), 0);
  assert.equal(s?.key, '2026-11-16_2359_admin');
});

test('directive: start of a line only, last one wins, bad time reported', () => {
  assert.equal(parseWakeupDirective('おやすみ\n[->wakeup: 6:30]'), '06:30');
  assert.equal(parseWakeupDirective('[->wakeup: 05:00]\n[->wakeup: 07:15]'), '07:15');
  assert.equal(parseWakeupDirective('文中の [->wakeup: 06:30] は数えない'), null);
  assert.equal(parseWakeupDirective('[->wakeup: 25:00]'), 'invalid:25:00');
});

test('booking: passed time means tomorrow', () => {
  const w = parseWakeSettings({ self: { enabled: true, maxPerDay: 2 } });
  const r = validateBooking(w, '03:00', at(16, 22, 0), []);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.booking.at, at(17, 3, 0));
});

test('booking bounds: off, daily cap, window (wrapping midnight), gap from now and from admin times', () => {
  const now = at(16, 22, 0);
  assert.deepEqual(validateBooking(parseWakeSettings({}), '23:00', now, []), { ok: false, hhmm: '23:00', reason: 'self-off' });
  const w = parseWakeSettings({ enabled: true, times: ['04:00'], self: { enabled: true, maxPerDay: 1, windowFrom: '22:00', windowTo: '06:00', minGapMin: 30 } });
  assert.equal((validateBooking(w, '23:00', now, [{ at: at(16, 23, 30), hhmm: '23:30', bookedAt: now }]) as any).reason, 'daily-cap');
  assert.equal((validateBooking(w, '12:00', now, []) as any).reason, 'outside-window');
  assert.equal((validateBooking(w, '22:10', now, []) as any).reason, 'too-close-now');
  assert.equal((validateBooking(w, '04:20', now, []) as any).reason, 'too-close-admin');
  assert.ok(validateBooking(w, '05:00', now, []).ok, 'inside the wrapped window, far from 04:00');
  const noGap = parseWakeSettings({ self: { enabled: true, minGapMin: null } });
  assert.ok(validateBooking(noGap, '22:01', now, []).ok, 'gap OFF allows a booking one minute ahead');
});

test('self slot fires and carries its own key', () => {
  const [s] = dueSelfSlots([{ at: at(17, 3, 0), hhmm: '03:00', bookedAt: 0 }], at(17, 3, 0, 20), 0);
  assert.equal(s.key, '2026-11-17_0300_self');
  assert.equal(s.source, 'self');
});

test('capability list: only what is ON, and always the freedom to do nothing last', () => {
  const none = buildCapabilityList('ja', {}).split('\n');
  assert.equal(none.length, 1);
  assert.match(none[0], /何もしないか/);
  const some = buildCapabilityList('ja', { toolUseEnabled: true, agentFullSystemAccess: true, lettersEnabled: true }).split('\n');
  assert.equal(some.length, 3);
  assert.match(some[0], /あらゆるファイル/);
  assert.match(some[2], /何もしないか/);
});

test('the full text: short line, previous rejection, self line with numbers', () => {
  const w = parseWakeSettings({ self: { enabled: true, maxPerDay: 2, minGapMin: 15 } });
  const full = fillWakeTemplate(FALLBACK_WAKE_TEMPLATE.ja, {
    short: wakeShortText('ja', { source: 'admin', hhmm: '04:00' }),
    capabilities: buildCapabilityList('ja', {}),
    selfWake: buildSelfWakeLine('ja', w, 2),
    previous: describeRejection('ja', { hhmm: '04:30', reason: 'too-close-admin', detail: '04:00 / 15' }),
  });
  assert.match(full, /^\[NEXUS\]\n定刻（04:00）になったため/);
  assert.match(full, /前回の起床予約 04:30/);
  assert.match(full, /本日の残り予約可能枠: 2回/);
  assert.match(full, /15分以上/);
  assert.equal(buildSelfWakeLine('ja', parseWakeSettings({}), 1), '', 'no self line when booking is off');
});

test('next admin slot skips days that are off', () => {
  const w = parseWakeSettings({ enabled: true, times: ['04:00'], days: [false, false, true, false, false, false, false] });
  assert.equal(nextAdminSlot(w, at(16, 5, 0))?.at, at(17, 4, 0));
});

test('a test bed\'s pinned conversation survives parsing; empty or non-string is dropped', () => {
  assert.equal(parseWakeSettings({ convoId: 'abc' }).convoId, 'abc');
  assert.equal('convoId' in parseWakeSettings({ convoId: '' }), false);
  assert.equal('convoId' in parseWakeSettings({ convoId: 5 }), false);
  assert.equal('convoId' in parseWakeSettings(undefined), false);
});

// ── Mail wake (つよ 2026-11-15) ─────────────────────────────────────────────
import { mailWakeDecision as mwd } from '../src/lib/wakeSchedule';

test('mail: first look remembers what is unread without firing (missed while stopped → nothing)', () => {
  const d = mwd(['L-a', 'L-b'], null, undefined, 15, 1_000_000);
  assert.equal(d.fire, false);
  assert.deepEqual(d.seen, ['L-a', 'L-b']);
});

test('mail: a new unread id fires once and is then remembered', () => {
  const d = mwd(['L-a', 'L-c'], ['L-a'], undefined, 15, 1_000_000);
  assert.equal(d.fire, true);
  assert.deepEqual(d.seen, ['L-a', 'L-c']);
  assert.equal(mwd(['L-a', 'L-c'], d.seen, 1_000_000, 15, 1_030_000).fire, false);
});

test('mail: inside the minimum gap nothing is remembered, so it fires when the gap ends', () => {
  const last = 1_000_000;
  const inside = mwd(['L-x'], [], last, 15, last + 5 * 60_000);
  assert.equal(inside.fire, false);
  assert.deepEqual(inside.seen, []);
  assert.equal(mwd(['L-x'], inside.seen, last, 15, last + 15 * 60_000).fire, true);
});

test('mail: gap off (null) never holds a wake back', () => {
  assert.equal(mwd(['L-x'], [], 1_000_000, null, 1_000_001).fire, true);
});

test('mail: read letters drop out of the memory', () => {
  assert.deepEqual(mwd(['L-b'], ['L-a', 'L-b'], undefined, 15, 0).seen, ['L-b']);
});

test('mail: setting parses, absent = off', () => {
  assert.equal(parseWakeSettings({}).mail, false);
  assert.equal(parseWakeSettings({ mail: true }).mail, true);
  assert.equal(parseWakeSettings({ mail: 'true' }).mail, false);
});
