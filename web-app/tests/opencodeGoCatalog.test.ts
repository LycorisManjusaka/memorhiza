// OpenCode Go beyond Argon (2026-11-27): the catalog, the one lane every
// non-Gemini Go model is reached on, and the routing gates that keep a Go turn
// out of the three lanes that carry their own credentials.
//
// The measurements these pin live in workspace/opencode_probe/README.md
// (probe11/12/13: 19/19 answered 200 on chat-completions with a well-formed
// tool call; probe17: the mirrored-image vision pass/fail per id).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  OPENCODE_GO_CATALOG, OPENCODE_GO_FAMILIES, OPENCODE_GO_CHAT_URL, OPENCODE_GO_BASE,
  OPENCODE_GO_GEMINI_MODELS, OPENCODE_PREFIX,
  openCodeGoModel, openCodeGoModelsFor, openCodeGoUsesGeminiWire,
} from '@/lib/opencodeGo';
import { FAMILY_ROUTES, routeChoice, familyAvailable, familyOffersOpenCodeRoute } from '@/lib/providerAccess';
import { isVisionCapable } from '@/lib/modelVision';

const ROUTE = () => fs.readFileSync(path.join(process.cwd(), 'src/app/api/chat/route.ts'), 'utf8');
const PICKER = () => fs.readFileSync(path.join(process.cwd(), 'src/components/FamilyModelPicker.tsx'), 'utf8');

test('the catalog is well formed and every id is unique', () => {
  assert.equal(OPENCODE_GO_CATALOG.length, 20);
  const ids = OPENCODE_GO_CATALOG.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const m of OPENCODE_GO_CATALOG) {
    assert.equal(m.id, m.id.toLowerCase().trim(), m.id + ' must be the lowercase wire id');
    assert.ok(m.label.length > 0, m.id + ' needs a label');
    assert.ok(m.maxOutput > 0, m.id + ' needs the catalog output limit');
    assert.ok(m.family.length > 0);
  }
});

test('lookup reads through the routing prefix, and an unknown id is undefined', () => {
  assert.equal(openCodeGoModel('opencode/kimi-k3.1-pro')?.family, 'Kimi');
  // The bare id resolves too: pricing and the capability tables strip the tag
  // before they look anything up, so both spellings reach this table.
  assert.equal(openCodeGoModel('kimi-k3.1-pro')?.family, 'Kimi');
  assert.equal(openCodeGoModel('opencode/KIMI-K3.1-PRO')?.id, 'kimi-k3.1-pro');
  assert.equal(openCodeGoModel('gemini-4-hydrogen'), undefined);
  assert.equal(openCodeGoModel(''), undefined);
  assert.equal(openCodeGoModel(null), undefined);
});

test('models are grouped by family, case-insensitively, and an unserved family is empty', () => {
  assert.deepEqual(openCodeGoModelsFor('Qwen').map((m) => m.id),
    ['qwen3.7-plus', 'qwen3.8-flash', 'qwen3.8-max', 'qwen4-max']);
  assert.deepEqual(openCodeGoModelsFor('minimax').map((m) => m.id), ['minimax-m3', 'minimax-m3.1-flash']);
  assert.deepEqual(openCodeGoModelsFor('Cohere'), []);
  assert.deepEqual(openCodeGoModelsFor('Local'), []);
  assert.deepEqual(openCodeGoModelsFor(null), []);
  // One entry per family, in catalog order — Gemini first, because Argon is
  // the one model on the native Gemini wire.
  assert.equal(OPENCODE_GO_FAMILIES[0], 'Gemini');
  assert.equal(new Set(OPENCODE_GO_FAMILIES).size, OPENCODE_GO_FAMILIES.length);
  assert.equal(OPENCODE_GO_FAMILIES.length, 10);
});

test('only Argon takes its family native wire; everything else takes the one chat lane', () => {
  assert.equal(OPENCODE_GO_CHAT_URL, OPENCODE_GO_BASE + '/openai/v1/chat/completions');
  for (const m of OPENCODE_GO_CATALOG) {
    const expected = (OPENCODE_GO_GEMINI_MODELS as readonly string[]).includes(m.id);
    assert.equal(openCodeGoUsesGeminiWire(OPENCODE_PREFIX + m.id), expected, m.id);
  }
  assert.equal(openCodeGoUsesGeminiWire('opencode/kimi-k3'), false);
});

test('every family in the catalog is reachable through the opencode route — except Claude, on purpose', () => {
  for (const f of OPENCODE_GO_FAMILIES) {
    const routes = (FAMILY_ROUTES[f] ?? []).map((r) => r.id);
    if (f === 'Claude') {
      // Claude's two routes are an auth MODE held in state, not a model-id
      // prefix, so a third entry here would put two switches for the same
      // question on one screen. The chat route still accepts the id.
      assert.ok(!routes.includes('opencode'), 'Claude must not gain a picker route yet');
      continue;
    }
    assert.ok(routes.includes('opencode'), f + ' serves Go models but has no opencode route');
  }
  // And the key that route needs is the OpenCode one, not the family's own.
  const r = (FAMILY_ROUTES.Kimi ?? []).find((x) => x.id === 'opencode');
  assert.equal(r?.key, 'opencode');
});

test('an OpenCode key alone makes those families reachable, and offers the route', () => {
  const only = { opencode: true };
  for (const f of ['Qwen', 'DeepSeek', 'Kimi', 'Grok', 'Minimax', 'ChatGPT', 'MiMo', 'GLM', 'Gemini']) {
    assert.equal(familyAvailable(f, only), true, f);
    // One reachable route -> named, not offered as a choice (つよ's rule).
    assert.deepEqual(routeChoice(f, only, 'opencode'), { mode: 'fixed', route: 'opencode' });
  }
  assert.equal(familyAvailable('Cohere', only), false);
  // Two keys -> a real switch.
  assert.deepEqual(routeChoice('MiMo', { opencode: true, mimo: true }, 'opencode'),
    { mode: 'choose', routes: ['xiaomi', 'opencode'] });
});

test('a Go turn is kept out of the three lanes that carry their own credentials', () => {
  const route = ROUTE();
  // Claude's Agent/Anthropic SDK path, and the Kimi/MiMo Anthropic-Messages
  // adapter, both authenticate with that provider's own key at that provider's
  // own endpoint — a Go turn entering either would bill the wrong account (or
  // fail with no key at all). The OpenAI-compatible lane is the one it enters.
  assert.match(route, /if \(isClaude && !useOpenCodeGo\) \{/);
  assert.match(route, /else if \(\(isKimi \|\| isMimo\) && !useOpenCodeGo\) \{/);
  assert.match(route, /else if \(useOpenCodeGo \|\| isLocal \|\| isDashScope/);
  // /v1/responses is not used: all three of Go's "responses" models answered
  // 200 with a tool call on chat-completions (probe11/13).
  assert.match(route, /const useOpenAiResponses = !useOpenCodeGo && isOpenAI/);
});

test('the Go lane supplies the endpoint, the key and the session header before any family rule', () => {
  const route = ROUTE();
  // `useOpenCodeGo ?` must come FIRST in both chains: every family condition
  // below it names a provider whose endpoint and key are the wrong ones here.
  assert.match(route, /const chatCompletionsUrl = useOpenCodeGo\s*\n\s*\? OPENCODE_GO_CHAT_URL/);
  assert.match(route, /const authHeaders: Record<string, string> = useOpenCodeGo\s*\n\s*\? \{ Authorization: `Bearer \$\{keys\.opencode\}` \}/);
  // Without a session id Go answers 400 MissingSessionID (measured 2026-11-25).
  assert.match(route, /\.\.\.\(useOpenCodeGo \? openCodeGoHeaders\(convoId \|\| 'session'\) : \{\}\)/);
  // The id on the wire is Go's own spelling: neither Moonshot's
  // `moonshotai/Kimi-*` mapping nor the retired-DeepSeek normaliser applies.
  assert.match(route, /let localModel = useOpenCodeGo \? String\(specificModel\)/);
  assert.match(route, /if \(useDeepSeekDirect && !useOpenCodeGo\) localModel = deepseekWireModel/);
  // A missing key is named here rather than surfacing as the provider's 401.
  assert.match(route, /if \(!keys\.opencode\) \{/);
});

test('vision on the Go lane follows the mirrored-image measurement, not the id spelling', () => {
  // Passed 2/2 on the mirrored pair (probe17) under ids only Go uses.
  for (const id of ['kimi-k3', 'kimi-k3.1-pro', 'kimi-k2.7-code', 'deepseek-v4.1-flash', 'qwen3.7-plus', 'qwen3.8-flash']) {
    assert.equal(isVisionCapable(OPENCODE_PREFIX + id), true, id + ' passed the mirror and must not be bridged');
  }
  // Named LEFT for BOTH mirrors — answering from the prompt, not the picture.
  // Default-deny sends their images through the eyes bridge instead.
  for (const id of ['minimax-m3', 'minimax-m3.1-flash']) {
    assert.equal(isVisionCapable(OPENCODE_PREFIX + id), false, id + ' failed the mirror and must stay bridged');
  }
  // Still true: text-only stays text-only through the tag.
  assert.equal(isVisionCapable('opencode/deepseek-v4-pro'), false);
  assert.equal(isVisionCapable('opencode/glm-5.3'), false);
});

test('the route switch exists once, not once per family', () => {
  const picker = PICKER();
  // The whole point of this component: one <GoRoute> computed from the
  // catalog, not ten hand-written copies. Gemini's and GLM's own provider
  // switches were folded into it, so neither family may name a route again.
  assert.equal(picker.split('function GoRoute(').length - 1, 1);
  assert.equal(picker.split('function GoModelSelect(').length - 1, 1);
  // Rendered once each, from the top level — not inside a family block.
  // (`<GoRoute>` also appears in the two comments left where Gemini's and
  // GLM's own switches used to be, so the element itself is matched here.)
  assert.equal(picker.split('<GoRoute\n').length - 1, 1);
  assert.equal(picker.split('<GoModelSelect family=').length - 1, 1);
  assert.doesNotMatch(picker, /model\.gemini\.provider/);
  // A family whose routes are an auth MODE rather than a model-id prefix must
  // not be drawn by this switch: it can only rewrite the id, so picking one
  // would do nothing and snap back (2026-11-27: Claude's OAuth unselectable).
  assert.match(picker, /if \(!familyOffersOpenCodeRoute\(family\)\) return null;/);
  assert.equal(familyOffersOpenCodeRoute('Claude'), false);
  assert.equal(familyOffersOpenCodeRoute('Gemini'), true);
  assert.equal(familyOffersOpenCodeRoute('glm'), true); // case-insensitive, as norm() is
  assert.equal(familyOffersOpenCodeRoute('Local'), false);
  assert.doesNotMatch(picker, /model\.glm\.providerLabel/);
  // Leaving the Go route hands back the family default from the one table the
  // conversation loader and the sidebar already read.
  assert.match(picker, /defaultModelForFamily\(family\)/);
  // A saved id Go no longer serves stays selectable as itself: a <select> whose
  // value has no <option> shows its first child and lies (lib/retiredModels).
  assert.match(picker, /\{!known && <option value=\{model\}>\{model\}<\/option>\}/);
});
