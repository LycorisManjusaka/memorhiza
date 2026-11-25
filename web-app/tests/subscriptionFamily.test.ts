import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { splitBySubscription, isSubscriptionFamily, familyFromModelId } from '@/lib/modelFamily';
import { resolvePrice, messageCost } from '@/lib/modelPricing';
import { billingToStatRecord } from '@/lib/spuBilling';

// 2026-11-25. The first OpenCode Go turn in this house was saved as bare
// `gemini-4-argon`, so statistics counted the monthly allowance as metered
// Google money ($0.56 for one turn). These pin the three links of the fix:
// the saved id keeps its route, the route names a subscription family, and the
// stats option drops every subscription family, not only Claude OAuth.

test('an opencode/ model id is its own subscription family', () => {
  const fam = splitBySubscription(familyFromModelId('opencode/gemini-4-argon'), null, 'opencode/gemini-4-argon');
  assert.equal(fam, 'Gemini (OpenCode Go)');
  assert.equal(isSubscriptionFamily(fam), true);
});

test('metered routes are not subscription families', () => {
  assert.equal(splitBySubscription('Gemini', null, 'gemini-4-argon'), 'Gemini');
  assert.equal(isSubscriptionFamily('Gemini'), false);
  assert.equal(isSubscriptionFamily(splitBySubscription('Claude', 'api-key', 'claude-opus-5')), false);
  assert.equal(isSubscriptionFamily('Unknown'), false);
  assert.equal(isSubscriptionFamily(undefined), false);
});

test('Claude OAuth is still split and still a subscription family', () => {
  const fam = splitBySubscription('Claude', 'oauth', 'claude-opus-5');
  assert.equal(fam, 'Claude (OAuth)');
  assert.equal(isSubscriptionFamily(fam), true);
});

test('the routing tag does not hide the list price (equivalent, like OAuth)', () => {
  assert.deepEqual(resolvePrice('opencode/gemini-4-argon'), resolvePrice('gemini-4-argon'));
  const cu = { totalInputTokens: 1000, cachedInputTokens: 0, outputTokens: 100 };
  const a = messageCost(cu, 'opencode/gemini-4-argon', 100, Date.UTC(2026, 10, 25));
  const b = messageCost(cu, 'gemini-4-argon', 100, Date.UTC(2026, 10, 25));
  assert.ok(a && b);
  assert.equal(a!.usd, b!.usd);
});

test('an SPU run on the Go route lands in the subscription family', () => {
  const rec = billingToStatRecord({
    model: 'opencode/gemini-4-argon', authMode: 'api-key', startedAt: Date.UTC(2026, 10, 25),
    usage: { totalInputTokens: 1000, cachedInputTokens: 0, outputTokens: 100 },
  } as any, 'X');
  assert.ok(rec);
  assert.equal(rec!.family, 'Gemini (OpenCode Go)');
});

test('the chat route saves the tagged id, and the stats window filters by subscription', () => {
  const route = fs.readFileSync(path.join(process.cwd(), 'src/app/api/chat/route.ts'), 'utf8');
  assert.match(route, /specificModel: useOpenCodeGo \? OPENCODE_PREFIX \+ specificModel : specificModel/);
  const stats = fs.readFileSync(path.join(process.cwd(), 'src/components/StatsModal.tsx'), 'utf8');
  assert.match(stats, /!isSubscriptionFamily\(r\.family\)/);
  assert.doesNotMatch(stats, /r\.family !== 'Claude \(OAuth\)'/);
});
