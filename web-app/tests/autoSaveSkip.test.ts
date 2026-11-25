import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingsSignature, shouldSkipAutoSave } from '@/lib/autoSaveSkip';

const base = { id: 'c1', aiName: 'Claude', specificModel: 'claude-fable-5-2', title: 't', messages: [] as unknown[] };

test('the reported sequence: a vessel changed during a turn is SAVED, not skipped', () => {
  // Disk (and the tab, at open) say Fable.
  const persisted = settingsSignature(base);
  // During the turn the person picks Sonnet; the effect returned on `loading`.
  const onScreen = settingsSignature({ ...base, specificModel: 'claude-sonnet-5' });
  // The turn's patch set the skip flag. The fire after `loading` clears:
  assert.equal(shouldSkipAutoSave(true, onScreen, persisted), false);
});

test('applying disk state is still skipped (the reason the flag exists)', () => {
  const sig = settingsSignature(base);
  assert.equal(shouldSkipAutoSave(true, sig, sig), true);
});

test('a freshly opened conversation keeps the one-shot skip', () => {
  assert.equal(shouldSkipAutoSave(true, settingsSignature(base), null), true);
});

test('no flag, no skip', () => {
  const sig = settingsSignature(base);
  assert.equal(shouldSkipAutoSave(false, sig, sig), false);
});

test('messages and the runner-owned fields do not count as a settings edit', () => {
  const a = settingsSignature(base);
  const b = settingsSignature({
    ...base,
    messages: [{ id: 'm1' }],
    firstOriginalMessageId: 'm1',
    firstOriginalIsNext: false,
    claudeAgentSessionId: 'x',
  });
  assert.equal(a, b);
});

test('key order does not change the signature', () => {
  assert.equal(
    settingsSignature({ aiName: 'Gemini', specificModel: 'g' }),
    settingsSignature({ specificModel: 'g', aiName: 'Gemini' }),
  );
});

// ── 2026-11-25: a stale tab must not be handed the licence to overwrite ────
import { diskSettingsMovedSince, diskSettingsOf } from '../src/lib/autoSaveSkip';

test('diskSettingsMovedSince: another writer changed the vessel -> moved', () => {
  const seen = { aiName: 'Gemini', specificModel: 'opencode/gemini-4-argon', title: 'x' };
  const disk = { aiName: 'Claude', specificModel: 'claude-fable-5-2', title: 'x', messages: [1, 2] };
  assert.equal(diskSettingsMovedSince(seen, disk), true);
});

test('diskSettingsMovedSince: disk still what this tab saw -> not moved, even with new messages', () => {
  const seen = { aiName: 'Claude', specificModel: 'claude-sonnet-5', familyModels: { Claude: 'claude-sonnet-5' } };
  const disk = { aiName: 'Claude', specificModel: 'claude-sonnet-5', familyModels: { Claude: 'claude-sonnet-5' }, messages: [1, 2, 3], updatedAt: 9 };
  assert.equal(diskSettingsMovedSince(seen, disk), false);
});

test('diskSettingsMovedSince: one-sided, runner-owned fields ignored, null = nothing seen yet', () => {
  // A key the file lacks is not a disagreement.
  assert.equal(diskSettingsMovedSince({ aiName: 'Claude', newField: true }, { aiName: 'Claude' }), false);
  // The marker pair and the agent session id belong to the turn machinery.
  assert.equal(diskSettingsMovedSince(
    { aiName: 'Claude', firstOriginalIsNext: true, claudeAgentSessionId: 'a' },
    { aiName: 'Claude', firstOriginalIsNext: false, firstOriginalMessageId: 'm', claudeAgentSessionId: 'b' },
  ), false);
  // undefined on one side and null on the other are the same absence.
  assert.equal(diskSettingsMovedSince({ seedValue: undefined }, { seedValue: null }), false);
  assert.equal(diskSettingsMovedSince(null, { aiName: 'Gemini' }), false);
  // The version stamp changes on every write and is never a setting.
  assert.equal(diskSettingsMovedSince({ aiName: 'Claude', updatedAt: 1 }, { aiName: 'Claude', updatedAt: 2 }), false);
  // Limited to the keys the tab itself writes: a file-only field that moved is not its business.
  assert.equal(diskSettingsMovedSince({ aiName: 'Claude', serverStamp: 1 }, { aiName: 'Claude', serverStamp: 2 }, ['aiName']), false);
  assert.equal(diskSettingsMovedSince({ aiName: 'Gemini', serverStamp: 1 }, { aiName: 'Claude', serverStamp: 1 }, ['aiName']), true);
});

test('diskSettingsOf: the file as it is, without the message array', () => {
  const log = { aiName: 'Claude', messages: [{ id: 'a' }], updatedAt: 5 };
  const s = diskSettingsOf(log);
  assert.equal('messages' in s, false);
  assert.equal(s.aiName, 'Claude');
  assert.equal(log.messages.length, 1);
});

// ── 2026-11-25: settings travel between tabs (トカゲくん) ───────────────────
import { decideSettingsSync } from '../src/lib/autoSaveSkip';
import { readFileSync } from 'node:fs';

const tabAtOpen = { id: 'c1', aiName: 'Gemini', specificModel: 'opencode/gemini-4-argon', title: 't' };
const otherTabWrote = { id: 'c1', aiName: 'Claude', specificModel: 'claude-fable-5-2', title: 't', messages: [1] };

test('decideSettingsSync: the reported case — an idle tab takes the vessel another tab chose', () => {
  const sig = settingsSignature(tabAtOpen);
  assert.equal(decideSettingsSync({
    diskMoved: diskSettingsMovedSince(tabAtOpen, otherTabWrote),
    screenSig: sig, syncedSig: sig, panelOpen: false,
  }), 'adopt');
});

test('decideSettingsSync: a tab with its settings open does nothing', () => {
  const sig = settingsSignature(tabAtOpen);
  assert.equal(decideSettingsSync({ diskMoved: true, screenSig: sig, syncedSig: sig, panelOpen: true }), 'defer');
});

test('decideSettingsSync: an edit of this tab that never reached disk is not overwritten', () => {
  const synced = settingsSignature(tabAtOpen);
  const edited = settingsSignature({ ...tabAtOpen, title: 'renamed here' });
  assert.equal(decideSettingsSync({ diskMoved: true, screenSig: edited, syncedSig: synced, panelOpen: false }), 'conflict');
  // The edit outranks the panel: closing the panel must not turn it into an adoption.
  assert.equal(decideSettingsSync({ diskMoved: true, screenSig: edited, syncedSig: synced, panelOpen: true }), 'conflict');
});

test('decideSettingsSync: no agreed moment on record is "cannot tell", never adopt', () => {
  const sig = settingsSignature(tabAtOpen);
  assert.equal(decideSettingsSync({ diskMoved: true, screenSig: sig, syncedSig: null, panelOpen: false }), 'conflict');
});

test('decideSettingsSync: disk unchanged -> nothing, whatever the screen holds', () => {
  const sig = settingsSignature(tabAtOpen);
  assert.equal(decideSettingsSync({ diskMoved: false, screenSig: 'x', syncedSig: sig, panelOpen: true }), 'none');
  assert.equal(decideSettingsSync({ diskMoved: false, screenSig: sig, syncedSig: null, panelOpen: false }), 'none');
});

// The wiring lives in a .tsx the loader cannot import, so it is pinned as text.
const chatSrc = readFileSync('src/components/ChatArea.tsx', 'utf8');

test('ChatArea: opening and syncing put settings on screen through ONE function', () => {
  // Called by the load, and by the reload through its ref. A second field
  // list for the sync is how one setting would stop following across tabs.
  assert.equal((chatSrc.match(/\bapplyLogSettings\(data\);/g) || []).length, 1);
  assert.equal((chatSrc.match(/applyLogSettingsRef\.current\(data\);/g) || []).length, 1);
  // The setter that names the vessel family appears exactly once on the
  // loaded-log side — inside that function.
  assert.equal((chatSrc.match(/setLocalAiName\(data\.aiName \|\| aiName\);/g) || []).length, 1);
});

test('ChatArea: a refused save does not count as agreeing with disk', () => {
  // syncedSettingsSigRef may be assigned from a signature in three places
  // only: the post-load skip, the accepted save, the adoption read-back.
  const writes = chatSrc.match(/syncedSettingsSigRef\.current = (?!null)[A-Za-z]+;/g) || [];
  assert.deepEqual(writes.sort(), [
    'syncedSettingsSigRef.current = adoptedSig;',
    'syncedSettingsSigRef.current = settingsSig;',
    'syncedSettingsSigRef.current = settingsSig;',
  ]);
  // …and the accepted-save one sits behind the server's reported version.
  assert.match(chatSrc, /typeof j\?\.updatedAt === 'number'\) \{\s+baseUpdatedAtRef\.current = j\.updatedAt;\s+\/\/ Accepted[^\n]*\s+syncedSettingsSigRef\.current = settingsSig;/);
});
