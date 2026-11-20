// トカゲくん 2026-11-20: the header shows ONE next wake (the sooner of the
// schedule and the being's own booking), and Preferences → Runner shows a
// turn that is running now, with its tool count read from the live relay.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { parseWakeSettings, nextWake } from '@/lib/wakeSchedule';
import { beginTurn, publishTurnText, endTurn, liveTurnToolCount, __resetTurnBus } from '@/lib/turnBus';

const NOW = new Date(2026, 10, 20, 10, 0, 0).getTime();
const at = (h: number, m = 0, dayOffset = 0) => new Date(2026, 10, 20 + dayOffset, h, m, 0).getTime();
const allDays = [true, true, true, true, true, true, true];

describe('nextWake', () => {
  it('picks the sooner of schedule and self-booking', () => {
    const w = parseWakeSettings({ enabled: true, times: ['22:00'], days: allDays, self: { enabled: true } });
    const r = nextWake(w, [{ at: at(14), hhmm: '14:00', bookedAt: NOW }], NOW);
    assert.equal(r.next?.kind, 'self');
    assert.equal(r.next?.at, at(14));
    assert.equal(r.admin?.at, at(22));
  });

  it('a booking does not count while self-wake is off', () => {
    const w = parseWakeSettings({ enabled: true, times: ['22:00'], days: allDays, self: { enabled: false } });
    const r = nextWake(w, [{ at: at(14), hhmm: '14:00', bookedAt: NOW }], NOW);
    assert.equal(r.next?.kind, 'admin');
    assert.equal(r.self, null);
  });

  it('past bookings are skipped; nothing coming means null', () => {
    const w = parseWakeSettings({ enabled: false, self: { enabled: true } });
    const r = nextWake(w, [{ at: at(9), hhmm: '09:00', bookedAt: NOW }], NOW);
    assert.equal(r.next, null);
  });
});

describe('liveTurnToolCount', () => {
  beforeEach(() => __resetTurnBus());
  const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

  it('counts real tool calls, not events, across split chunks', () => {
    beginTurn('c1', 't1', NOW);
    publishTurnText('c1', frame({ type: 'text', content: 'hi' }));
    const tc = frame({ type: 'tool_call', call: { name: 'Read', input: {} } });
    publishTurnText('c1', tc.slice(0, 10));
    publishTurnText('c1', tc.slice(10));
    publishTurnText('c1', frame({ type: 'tool_call', call: { name: 'Bash', input: {} } }));
    publishTurnText('c1', frame({ type: 'tool_call', call: { name: 'partner interjection', kind: 'event' } }));
    assert.deepEqual(liveTurnToolCount('c1'), { tools: 2, truncated: false });
  });

  it('null when no live relay here (absent is not zero)', () => {
    assert.equal(liveTurnToolCount('nope'), null);
    beginTurn('c2', 't2', NOW);
    endTurn('c2', undefined, NOW + 1);
    assert.equal(liveTurnToolCount('c2'), null);
  });
});
