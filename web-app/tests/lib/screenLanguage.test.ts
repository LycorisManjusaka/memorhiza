import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickMirroredGlobalSettings, mirrorChanged } from '../../src/lib/serverGlobalSettings';
import { noticeLanguage } from '../../src/lib/noticeLanguage';
import { wakeLangFromSettings } from '../../src/lib/wakeSchedule';

// トカゲくん, 2026-11-19: on the pilot's English install the anchor answered in
// English when pressed by hand but in Japanese on every autonomous turn. The
// wake read `user_settings.json.language`, which nothing writes, and fell back
// to 'ja'. The browser now mirrors the screen language as `screenLanguage`.

test('the screen language is mirrored under its own name, never as `language`', () => {
  const out = pickMirroredGlobalSettings({ language: 'en' }) as Record<string, unknown>;
  assert.equal(out.screenLanguage, 'en');
  assert.equal('language' in out, false);
  assert.equal(pickMirroredGlobalSettings({ language: 'ja-JP' }).screenLanguage, 'ja');
  assert.equal(pickMirroredGlobalSettings({}).screenLanguage, undefined);
});

test('the PATCH route re-pick keeps screenLanguage (browser sends the picked subset)', () => {
  const first = pickMirroredGlobalSettings({ language: 'en' });
  assert.equal(pickMirroredGlobalSettings(first).screenLanguage, 'en');
});

test('a screen-language change counts as a mirror change', () => {
  assert.equal(mirrorChanged({ screenLanguage: 'ja' }, { screenLanguage: 'en' }), true);
});

test('an autonomous batch (no uiLang) follows the mirrored screen language', () => {
  assert.equal(noticeLanguage([{}], { screenLanguage: 'en' }), 'en');
  assert.equal(noticeLanguage([{}], { screenLanguage: 'ja' }), 'ja');
  // A typed item still wins.
  assert.equal(noticeLanguage([{ uiLang: 'ja' }], { screenLanguage: 'en' }), 'ja');
});

test('the wake follows the mirrored screen language; absent stays Japanese', () => {
  assert.equal(wakeLangFromSettings({ screenLanguage: 'en' }), 'en');
  assert.equal(wakeLangFromSettings({ screenLanguage: 'ja' }), 'ja');
  assert.equal(wakeLangFromSettings({ language: 'en', screenLanguage: 'ja' }), 'en');
  assert.equal(wakeLangFromSettings({ userName: 'x' } as never), 'ja');
  assert.equal(wakeLangFromSettings(null), 'ja');
});
