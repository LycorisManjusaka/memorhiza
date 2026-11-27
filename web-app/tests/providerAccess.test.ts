import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  keyPresence, familyAvailable, visibleFamilies, availableRoutes, routeChoice, FAMILY_ROUTES,
} from '@/lib/providerAccess';
import { BASE_MODEL_FAMILIES } from '@/lib/beingVessel';

const P = (o: Record<string, string>) => keyPresence(o);

test('keyPresence keeps booleans only; blank and non-string values are "no key"', () => {
  const p = keyPresence({ gemini: 'AIza-secret', glm: '   ', claude: '', n: 5 });
  assert.deepEqual(p, { gemini: true, glm: false, claude: false, n: false });
  assert.ok(!JSON.stringify(p).includes('secret'));
  assert.deepEqual(keyPresence(null), {});
});

test('unknown presence (null) hides nothing and offers every route', () => {
  assert.deepEqual(visibleFamilies(BASE_MODEL_FAMILIES, null), BASE_MODEL_FAMILIES);
  // GLM has three ways in since 2026-11-27 (OpenCode Go serves glm-5.3 and
  // glm-5.3-flash), and an unknown presence offers all of them.
  assert.deepEqual(routeChoice('GLM', null, 'zai'), { mode: 'choose', routes: ['zai', 'digitalocean', 'opencode'] });
});

test('a family with no key is not offered; Local needs none', () => {
  const p = P({ gemini: 'k', deepseek: 'k' });
  assert.deepEqual(visibleFamilies(BASE_MODEL_FAMILIES, p), ['Gemini', 'DeepSeek', 'Local']);
  assert.equal(familyAvailable('ChatGPT', p), false);
  assert.equal(familyAvailable('ChatGPT', P({ openai: 'k' })), true);
  assert.equal(familyAvailable('Local', {}), true);
});

test('every base family is known to the table, so none is shown by accident', () => {
  for (const f of BASE_MODEL_FAMILIES) {
    if (f === 'Local') continue;
    assert.equal(familyAvailable(f, {}), false, f);
  }
});

test('the saved family stays in the list, in place, when its key is gone', () => {
  const p = P({ gemini: 'k' });
  assert.deepEqual(visibleFamilies(BASE_MODEL_FAMILIES, p, 'Kimi'), ['Gemini', 'Kimi', 'Local']);
  // spelling drift (MiniMax / Minimax) still matches
  assert.deepEqual(visibleFamilies(BASE_MODEL_FAMILIES, p, 'minimax'), ['Gemini', 'Minimax', 'Local']);
});

test('multi-route families: either key makes the family reachable', () => {
  assert.equal(familyAvailable('GLM', P({ digitalocean: 'k' })), true);
  assert.equal(familyAvailable('Claude', P({ claudeOAuthToken: 'k' })), true);
  assert.equal(familyAvailable('Gemini', P({ opencode: 'k' })), true);
  assert.equal(familyAvailable('GLM', P({ gemini: 'k' })), false);
});

test('routeChoice: both keys -> a real choice; one key in use -> fixed, no switch', () => {
  assert.deepEqual(routeChoice('GLM', P({ glm: 'k', digitalocean: 'k' }), 'zai'),
    { mode: 'choose', routes: ['zai', 'digitalocean'] });
  assert.deepEqual(routeChoice('GLM', P({ glm: 'k' }), 'zai'), { mode: 'fixed', route: 'zai' });
  assert.deepEqual(routeChoice('Claude', P({ claudeOAuthToken: 'k' }), 'oauth'), { mode: 'fixed', route: 'oauth' });
  assert.deepEqual(routeChoice('Gemini', P({ opencode: 'k' }), 'opencode'), { mode: 'fixed', route: 'opencode' });
});

test('routeChoice: the route in use has no key -> the way out stays on screen', () => {
  // saved as API key, but only the OAuth token exists: both shown so it can be switched
  assert.deepEqual(routeChoice('Claude', P({ claudeOAuthToken: 'k' }), 'api-key'),
    { mode: 'choose', routes: ['api-key', 'oauth'] });
  // no key at all: nothing to switch to, name the one in use
  assert.deepEqual(routeChoice('Gemini', {}, 'google'), { mode: 'fixed', route: 'google' });
});

test('a seat restricted to some routes ignores the other key', () => {
  const only = { Claude: ['oauth'], Gemini: ['google'] };
  assert.equal(familyAvailable('Claude', P({ claude: 'k' }), { only }), false);
  assert.equal(familyAvailable('Gemini', P({ opencode: 'k' }), { only }), false);
  assert.deepEqual(availableRoutes('Gemini', P({ gemini: 'k', opencode: 'k' }), { only }), ['google']);
  assert.deepEqual(routeChoice('Gemini', P({ gemini: 'k', opencode: 'k' }), 'google', { only }),
    { mode: 'fixed', route: 'google' });
});

test('the key names in the table are fields the keys screen actually edits', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/components/SettingsModal.tsx'), 'utf8');
  const names = new Set<string>();
  for (const routes of Object.values(FAMILY_ROUTES)) for (const r of routes) names.add(r.key);
  for (const k of ['qwen', 'deepseek', 'kimi', 'grok', 'cohere', 'minimax', 'openai', 'mimo', 'bytedance', 'meta']) names.add(k);
  for (const k of names) {
    assert.ok(new RegExp(`keys\\.${k}\\b|['"]${k}['"]`).test(src), `SettingsModal never mentions key "${k}"`);
  }
});

test('all three family selects and the sense seat go through visibleFamilies', () => {
  const chat = fs.readFileSync(path.join(process.cwd(), 'src/components/ChatArea.tsx'), 'utf8');
  assert.equal((chat.match(/BASE_MODEL_FAMILIES\.map\(/g) || []).length, 0);
  assert.equal((chat.match(/visibleFamilies\(BASE_MODEL_FAMILIES, keyPresence,/g) || []).length, 3);
  const sense = fs.readFileSync(path.join(process.cwd(), 'src/components/SenseModelPicker.tsx'), 'utf8');
  assert.ok(sense.includes('visibleFamilies(senseFamilies(kind), presence, family'));
});
