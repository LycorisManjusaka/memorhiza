import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseAdminNotes, pickAdminNote, appendAdminNote, parseDaysOff, normaliseDayOff, ADMIN_NOTE_HEADING,
} from '@/lib/wakeAdminNotes';
import { readAdminNotes, writeAdminNotes, adminNoteAt } from '@/lib/wakeAdminNotesStore';

// The administrator's own case (2026-11-24): A on weekdays 09:00-20:59 that
// are not days off, B otherwise. NEXUS knows neither "weekday" nor "holiday";
// both are just what was typed into the two rows.
const WEEKDAYS = [false, true, true, true, true, true, false];
const cfg = (enabled = true) => parseAdminNotes({
  enabled,
  rules: [
    { text: 'A', days: WEEKDAYS, from: '09:00', to: '20:59', dayOff: 'exclude' },
    { text: 'B' },
  ],
  daysOff: ['2026-11-23'],   // a Monday
});
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime();

test('first fitting row wins; the row without conditions is "otherwise"', () => {
  assert.equal(pickAdminNote(cfg(), at(2026, 11, 24, 9, 0)), 'A');     // Tuesday, first minute
  assert.equal(pickAdminNote(cfg(), at(2026, 11, 24, 20, 59)), 'A');   // last minute is inside
  assert.equal(pickAdminNote(cfg(), at(2026, 11, 24, 21, 0)), 'B');
  assert.equal(pickAdminNote(cfg(), at(2026, 11, 24, 8, 59)), 'B');
  assert.equal(pickAdminNote(cfg(), at(2026, 11, 22, 12, 0)), 'B');    // Sunday
});

test('a day off turns a weekday into "otherwise"; "only" is its mirror', () => {
  assert.equal(pickAdminNote(cfg(), at(2026, 11, 23, 12, 0)), 'B');    // listed Monday
  const only = parseAdminNotes({ enabled: true, rules: [{ text: 'H', dayOff: 'only' }], daysOff: ['2026-11-23'] });
  assert.equal(pickAdminNote(only, at(2026, 11, 23, 12, 0)), 'H');
  assert.equal(pickAdminNote(only, at(2026, 11, 24, 12, 0)), '');
});

test('switched off, or nothing fits → nothing is added, and the wake text is unchanged', () => {
  assert.equal(pickAdminNote(cfg(false), at(2026, 11, 24, 12, 0)), '');
  assert.equal(pickAdminNote(parseAdminNotes(null), Date.now()), '');
  assert.equal(parseAdminNotes({ rules: [{ text: 'x' }] }).enabled, false);   // off unless explicitly on
  assert.equal(appendAdminNote('WAKE', '', 'ja'), 'WAKE');
});

test('a time range may wrap past midnight; half a range is no range', () => {
  const night = parseAdminNotes({ enabled: true, rules: [{ text: 'N', from: '21:00', to: '08:59' }] });
  assert.equal(pickAdminNote(night, at(2026, 11, 24, 23, 0)), 'N');
  assert.equal(pickAdminNote(night, at(2026, 11, 24, 3, 0)), 'N');
  assert.equal(pickAdminNote(night, at(2026, 11, 24, 12, 0)), '');
  const half = parseAdminNotes({ enabled: true, rules: [{ text: 'X', from: '09:00' }] });
  assert.equal(half.rules[0].from, '');
  assert.equal(pickAdminNote(half, at(2026, 11, 24, 3, 0)), 'X');
});

test('a blank row is skipped, not matched — it must not silence the rows under it', () => {
  const c = parseAdminNotes({ enabled: true, rules: [{ text: '   ' }, { text: 'B' }] });
  assert.equal(pickAdminNote(c, Date.now()), 'B');
});

test('the note sits under the wake text, with a heading that says who is speaking', () => {
  assert.equal(appendAdminNote('WAKE\n', ' please ', 'ja'), `WAKE\n\n${ADMIN_NOTE_HEADING.ja}\nplease`);
  assert.ok(appendAdminNote('WAKE', 'x', 'en').includes('administrator'));
});

test('days off: real dates only, normalised, sorted, no duplicates', () => {
  assert.equal(normaliseDayOff('2027/1/3'), '2027-01-03');
  assert.equal(normaliseDayOff('2027-02-30'), '');
  const p = parseDaysOff('2027-01-11\n2027-1-1, 2027-01-01\nnew year');
  assert.deepEqual(p.days, ['2027-01-01', '2027-01-11']);
  assert.deepEqual(p.invalid, ['new', 'year']);
});

test('disk: a missing or broken file adds nothing; a saved one is read back clean', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-notes-'));
  try {
    assert.equal((await readAdminNotes(dir)).enabled, false);
    assert.equal(await adminNoteAt(Date.now(), dir), '');
    const saved = await writeAdminNotes({ enabled: true, rules: [{ text: 'B', junk: 1 }], daysOff: ['nope', '2027-01-01'] }, dir);
    assert.deepEqual(saved.daysOff, ['2027-01-01']);
    assert.equal(await adminNoteAt(Date.now(), dir), 'B');
    await fs.writeFile(path.join(dir, 'wake', 'admin_notes.json'), '{broken');
    assert.equal(await adminNoteAt(Date.now(), dir), '');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── The runner: the note is chosen when the turn STARTS ─────────────────────
import { runTurnForQueue, type RunTurnDeps } from '@/lib/runTurnForQueue';
import type { QueueItem } from '@/lib/turnQueue';
import { WAKE_PURPOSE } from '@/lib/wakeSchedule';

function rig() {
  const saved: any[] = [];
  const asked: number[] = [];
  let disk = 5; let minted = 0;
  const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const enc = new TextEncoder();
  const body = () => {
    let done = false;
    return { getReader: () => ({
      read: async () => done ? { done: true, value: undefined } : (done = true, { done: false, value: enc.encode(frame({ type: 'text', content: 'ok' })) }),
      cancel: async () => {}, releaseLock: () => {}, closed: Promise.resolve(undefined),
    }) };
  };
  const log = { id: 'c1', updatedAt: 5, aiName: 'Local', messages: [{ id: 'u0', role: 'user', content: 'q' }, { id: 'a0', role: 'assistant', content: 'r' }] };
  const deps = {
    loadLog: async () => log,
    saveLog: async (...a: any[]) => { saved.push(a); disk += 1; return { ok: true, writtenUpdatedAt: disk }; },
    chatPost: async () => ({ ok: true, status: 200, body: body() } as unknown as Response),
    globalSettings: {}, enableReadConversation: false,
    folderDefaults: { aiName: 'Local', folderName: '謡', systemPrompt: '', specificModel: 'm', modelParams: {} },
    newId: () => `minted-${++minted}`, nowMs: () => 7000, clientId: 'runner:test',
    origin: 'http://localhost:3000', injectTurnId: 'turn_test', onRawText: () => {},
    wakeAdminNote: async (now: number) => { asked.push(now); return 'NOTE'; },
  } as unknown as RunTurnDeps;
  const fullOf = () => JSON.stringify(saved).includes('NOTE');
  return { deps, saved, asked, fullOf };
}

test('runner: a wake turn gets the note of the moment it starts, under the wake text', async () => {
  const r = rig();
  const wake = { id: 'w1', at: 1000, kind: 'system', from: 'NEXUS', payload: { text: 'short', fullText: 'WAKE TEXT', purpose: WAKE_PURPOSE } } as unknown as QueueItem;
  const res = await runTurnForQueue('謡', 'c1', [wake], r.deps);
  assert.equal(res.ok, true);
  assert.deepEqual(r.asked, [7000], 'asked once, with the turn start time');
  const user = r.saved[0][1].messages.find((m: any) => m.nexus);
  assert.equal(user.content, 'short', 'the one-line history text is not touched');
  // No screen language in this rig → the notice language falls to English.
  assert.equal(user.nexus.full, appendAdminNote('WAKE TEXT', 'NOTE', 'en'));
  assert.equal(user.nexus.purpose, WAKE_PURPOSE);
});

test('runner: a turn somebody started themselves is never given the note', async () => {
  const r = rig();
  const msg = { id: 'm1', at: 1000, kind: 'user_message', from: 'つよ', payload: { text: 'hi' } } as unknown as QueueItem;
  await runTurnForQueue('謡', 'c1', [msg], r.deps);
  assert.deepEqual(r.asked, []);
  assert.equal(r.fullOf(), false);
});
