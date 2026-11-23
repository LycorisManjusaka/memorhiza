import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { settingsStampMoved } from '@/lib/beingSettingsStamp';

// 2026-11-24: two tabs on 睡_49 held different conversation-log caps (80k and
// 120k) and fought — the log alternated 96 <-> 75 messages every ~5 s. A tab
// must notice that the being's settings were rewritten and re-read them.

test('settings stamp: a moved stamp means re-read', () => {
  assert.equal(settingsStampMoved(1000, 2000), true);
  // Backwards is still a different file (restored backup, clock step).
  assert.equal(settingsStampMoved(2000, 1000), true);
});

test('settings stamp: the first observation only records; an unchanged stamp is quiet', () => {
  assert.equal(settingsStampMoved(null, 2000), false);
  assert.equal(settingsStampMoved(2000, 2000), false);
});

test('settings stamp: no stamp reported never triggers a re-read', () => {
  for (const now of [0, undefined, null, NaN, '2000', -5]) {
    assert.equal(settingsStampMoved(1000, now), false, String(now));
  }
});

test('settings stamp: the poll reports it and the tab acts on it', () => {
  const route = readFileSync('src/app/api/turn-queue/route.ts', 'utf8');
  assert.match(route, /settingsStamp = Math\.round\(\(await fsp\.stat\(beingSettingsFile\(being\)\)\)\.mtimeMs\)/);
  const tab = readFileSync('src/components/ChatArea.tsx', 'utf8');
  assert.match(tab, /settingsStampMoved\(settingsStampRef\.current\.stamp, d\?\.settingsStamp\)\) followDepsRef\.current\.fetchFolders\?\.\(\)/);
});
