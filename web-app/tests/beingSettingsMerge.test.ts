import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mergeBeingSettings, writeTouchesCustomCss } from '@/lib/beingSettingsMerge';

// The report this pins (2026-11-14, another install): a being's `aiVoice`
// was gone from settings.json though nobody had touched the voice. Every
// write used to replace the file with "the tab's remembered copy + one key".

const DISK = {
  aiVoice: { engine: 3, char_idx: 3, speed: 1.0 },
  voicePitch: 0,
  specificModel: 'model-new',
  convoOrder: ['a', 'b'],
  maxRecommendedContext: 123,
};

test('a patch sets only its own keys; everything else on disk survives', () => {
  const out = mergeBeingSettings(DISK, { patch: { convoOrder: ['b', 'a'] } });
  assert.deepEqual(out.convoOrder, ['b', 'a']);
  assert.deepEqual(out.aiVoice, DISK.aiVoice);
  assert.equal(out.specificModel, 'model-new');
});

test('the reported sequence: a tab that never saw aiVoice reorders the sidebar', () => {
  // The stale tab fetched before the voice was set, then wrote its whole copy.
  const staleTabCopy = { specificModel: 'model-old', convoOrder: ['a', 'b'] };
  const legacy = mergeBeingSettings(DISK, { settings: { ...staleTabCopy, convoOrder: ['b', 'a'] } });
  assert.deepEqual(legacy.aiVoice, DISK.aiVoice, 'a whole-object write from old code must not delete a key it never knew');
  // What the legacy shape still cannot prevent — said out loud, not hidden:
  assert.equal(legacy.specificModel, 'model-old', 'legacy whole writes still carry their stale values');
  // The current client sends a patch, and that closes the rollback too.
  const patched = mergeBeingSettings(DISK, { patch: { convoOrder: ['b', 'a'] } });
  assert.equal(patched.specificModel, 'model-new');
});

test('an EMPTY remembered copy (folders not loaded / failed read) erases nothing', () => {
  const out = mergeBeingSettings(DISK, { settings: { summaryIndexHint: 'x' } });
  assert.deepEqual(out.aiVoice, DISK.aiVoice);
  assert.equal(out.summaryIndexHint, 'x');
  assert.deepEqual(mergeBeingSettings(DISK, { settings: {} }), DISK);
});

test('deletion is explicit, never inferred from absence', () => {
  const out = mergeBeingSettings(DISK, { patch: { voicePitch: 2 }, remove: ['maxRecommendedContext'] });
  assert.equal('maxRecommendedContext' in out, false);
  assert.equal(out.voicePitch, 2);
  assert.equal('maxRecommendedContext' in mergeBeingSettings(DISK, { patch: { voicePitch: 2 } }), true);
});

test('patch wins over settings when both are sent; the disk object is not mutated', () => {
  const before = JSON.stringify(DISK);
  const out = mergeBeingSettings(DISK, { patch: { a: 1 }, settings: { b: 2 } });
  assert.equal(out.a, 1);
  assert.equal('b' in out, false);
  assert.equal(JSON.stringify(DISK), before);
  assert.deepEqual(mergeBeingSettings(null, { patch: { a: 1 } }), { a: 1 });
});

test('the theme file is only touched by a write that names customCss', () => {
  assert.equal(writeTouchesCustomCss({ patch: { convoOrder: [] } }), false);
  assert.equal(writeTouchesCustomCss({ patch: { customCss: '' } }), true);
  assert.equal(writeTouchesCustomCss({ settings: { customCss: 'x' } }), true);
});

test('no component sends a remembered whole settings object any more', () => {
  const dir = path.join(process.cwd(), 'src', 'components');
  for (const f of ['Sidebar.tsx', 'ChatArea.tsx', 'NexusApp.tsx']) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    // The shape that lost keys: spreading a tab-held `.settings` into the body.
    assert.equal(/settings:\s*\{\s*\.\.\./.test(src), false, `${f} spreads a remembered settings object into a write`);
    // Only request bodies: `{ ...f, settings: newSettings }` is the optimistic
    // local state update for a drag-reorder and writes nothing to disk.
    assert.equal(/name:[^}\n]*,\s*settings:\s*newSettings\b/.test(src), false, `${f} posts a whole settings object`);
  }
  const route = fs.readFileSync(path.join(process.cwd(), 'src', 'app', 'api', 'folders', 'route.ts'), 'utf8');
  assert.ok(route.includes('writeBeingSettings('), 'the route must merge over disk');
  assert.equal(/\bsaveFolder\(/.test(route), false, 'the route must not replace the file whole');
});
