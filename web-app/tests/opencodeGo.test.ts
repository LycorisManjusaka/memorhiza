import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  isOpenCodeModel, bareModelId, openCodeGoHeaders, parseGoUsage, monthWindowStart, windowPace,
  OPENCODE_PREFIX, OPENCODE_GO_GEMINI_MODELS,
} from '@/lib/opencodeGo';
import { viewWindow, weekPace, WEEK_MS } from '@/lib/claudeUsage';
import { isVisionCapable, isAudioCapable, isVideoCapable, resolveGeminiMinThinkingLevel } from '@/lib/modelVision';
import { familyFromModelId } from '@/lib/modelFamily';
import { modelBelongsToFamily } from '@/lib/beingVessel';
import { resolvePrice } from '@/lib/modelPricing';

const GO_ARGON = OPENCODE_PREFIX + 'gemini-4-argon';

test('the routing prefix is recognised and stripped; other ids are untouched', () => {
  assert.equal(isOpenCodeModel(GO_ARGON), true);
  assert.equal(isOpenCodeModel('gemini-4-argon'), false);
  assert.equal(isOpenCodeModel('digitalocean/glm-5.2'), false);
  assert.equal(isOpenCodeModel(undefined), false);
  assert.equal(bareModelId(GO_ARGON), 'gemini-4-argon');
  assert.equal(bareModelId('digitalocean/glm-5.2'), 'digitalocean/glm-5.2');
  assert.equal(bareModelId(null), null);
});

test('the prefixed id has the same eyes, ears, video and thinking floor as the bare one', () => {
  for (const id of OPENCODE_GO_GEMINI_MODELS) {
    const go = OPENCODE_PREFIX + id;
    assert.equal(isVisionCapable(go), isVisionCapable(id));
    assert.equal(isAudioCapable(go), isAudioCapable(id));
    assert.equal(isVideoCapable(go), isVideoCapable(id));
    assert.equal(resolveGeminiMinThinkingLevel(go), resolveGeminiMinThinkingLevel(id));
  }
  // Argon rejects 'minimal' — the prefixed id must not fall back to it.
  assert.equal(isVisionCapable(GO_ARGON), true);
  assert.equal(resolveGeminiMinThinkingLevel(GO_ARGON), 'low');
});

test('the prefixed id belongs to the Gemini family, not Local', () => {
  assert.equal(familyFromModelId(GO_ARGON), 'Gemini');
  assert.equal(modelBelongsToFamily(GO_ARGON, 'Gemini'), true);
});

test('the subscription route prices at the bare model list price (an equivalent, as Claude OAuth does)', () => {
  // Reversed 2026-11-25. The first version returned null here so that no list
  // price could be read as a bill — but the turn was then SAVED under the bare
  // id and billed as metered Google money anyway. The route now travels in the
  // saved id; "is it real money" is answered by isSubscriptionFamily in the
  // stats filter (tests/subscriptionFamily.test.ts), not by hiding the price.
  assert.notEqual(resolvePrice('gemini-4-argon'), null);
  assert.deepEqual(resolvePrice(GO_ARGON), resolvePrice('gemini-4-argon'));
});

test('headers: a session id is always present and header-safe', () => {
  const h = openCodeGoHeaders('d8a00875-b642-4ce2-8ae9-684494eddf26');
  assert.equal(h['x-opencode-session'], 'nexus-d8a00875-b642-4ce2-8ae9-684494eddf26');
  assert.match(h['User-Agent'], /^nexus\//);
  // A Japanese being name as the fallback seed must not put raw non-ASCII in a header.
  assert.match(openCodeGoHeaders('先輩')['x-opencode-session'], /^[A-Za-z0-9._-]+$/);
  assert.equal(openCodeGoHeaders('')['x-opencode-session'], 'nexus-session');
});

test('usage: the measured answer shape is read; a missing window stays missing', () => {
  const now = Date.parse('2026-11-25T08:20:00Z');
  const snap = parseGoUsage({
    rolling: { status: 'ok', percent: 5, resetsAt: '2026-11-25T13:07:00Z' },
    weekly: { status: 'ok', percent: 2, resetsAt: '2026-11-30T00:00:00Z' },
    monthly: { status: 'ok', percent: 1, resetsAt: '2026-12-25T07:54:29Z' },
  }, now)!;
  assert.equal(snap.rolling!.utilization, 0.05);
  assert.equal(snap.monthly!.resetsAt, Date.parse('2026-12-25T07:54:29Z'));
  assert.equal(snap.capturedAt, now);
  assert.deepEqual(viewWindow(snap.weekly, now), { state: 'live', pct: 2, resetsAt: Date.parse('2026-11-30T00:00:00Z') });

  const partial = parseGoUsage({ rolling: { percent: 7, resetsAt: '2026-11-25T13:07:00Z' } }, now)!;
  assert.equal(partial.weekly, undefined);
  assert.equal(partial.monthly, undefined);
  assert.equal(viewWindow(partial.monthly, now).state, 'unknown');

  // The verbatim answer OpenCode gave on 2026-11-25 (wrapped in { usage }).
  const verbatim = JSON.parse('{"usage":{"rolling":{"status":"ok","percent":5,"resetsAt":"2026-11-25T13:07:28.000Z"},"weekly":{"status":"ok","percent":2,"resetsAt":"2026-11-30T00:00:00.000Z"},"monthly":{"status":"ok","percent":1,"resetsAt":"2026-12-25T07:54:29.000Z"}}}');
  const real = parseGoUsage(verbatim, now)!;
  assert.equal(real.rolling!.utilization, 0.05);
  assert.equal(real.weekly!.utilization, 0.02);
  assert.equal(real.monthly!.resetsAt, Date.parse('2026-12-25T07:54:29.000Z'));
  assert.equal(real.capturedAt, now);

  assert.equal(parseGoUsage({}, now), null);
  assert.equal(parseGoUsage({ usage: {} }, now), null);
  assert.equal(parseGoUsage({ error: 'HTTP 401' }, now), null);
  assert.equal(parseGoUsage({ rolling: { percent: 'x' } }, now), null);
});

test('usage: what /api/opencode-usage sends (raw windows + capturedAt) keeps the server ask time', () => {
  const asked = Date.parse('2026-11-25T08:20:00Z');
  const wire = { rolling: undefined, weekly: undefined, monthly: { status: 'ok', percent: 1, resetsAt: '2026-12-25T07:54:29Z' }, capturedAt: asked };
  const read = parseGoUsage(JSON.parse(JSON.stringify(wire)), asked + 60_000)!;
  assert.equal(read.capturedAt, asked);
  assert.equal(read.monthly!.utilization, 0.01);
  const route = fs.readFileSync(path.join(process.cwd(), 'src/app/api/opencode-usage/route.ts'), 'utf8');
  assert.match(route, /rolling: raw\.rolling, weekly: raw\.weekly, monthly: raw\.monthly, capturedAt:/);
});

test('month window starts one calendar month before the reset, clamped to a real day', () => {
  assert.equal(monthWindowStart(Date.parse('2026-12-25T07:54:29Z')), Date.parse('2026-11-25T07:54:29Z'));
  assert.equal(monthWindowStart(Date.parse('2027-01-25T07:54:29Z')), Date.parse('2026-12-25T07:54:29Z'));
  // Resets on Mar 31 → the window began on the last day of February.
  assert.equal(monthWindowStart(Date.parse('2027-03-31T10:00:00Z')), Date.parse('2027-02-28T10:00:00Z'));
});

test('month pace: above the elapsed share is ahead, with a catch-up time before the reset', () => {
  const resetsAt = Date.parse('2026-12-25T07:54:29Z');
  const start = monthWindowStart(resetsAt);
  const span = resetsAt - start;
  const now = start + span * 0.10; // 10% of the month gone
  const ahead = windowPace({ state: 'live', pct: 25, resetsAt }, now, start)!;
  assert.equal(ahead.elapsedPct, 10);
  assert.equal(ahead.ahead, true);
  assert.equal(ahead.catchUpAt, start + span * 0.25);
  const under = windowPace({ state: 'live', pct: 4, resetsAt }, now, start)!;
  assert.equal(under.ahead, false);
  assert.equal(under.catchUpAt, null);
  assert.equal(windowPace({ state: 'unknown' }, now, start), null);
  assert.equal(windowPace({ state: 'live', pct: 5, resetsAt: null }, now, start), null);
  assert.equal(windowPace({ state: 'live', pct: 5, resetsAt }, now, resetsAt), null); // zero span
});

test('windowPace over 7 days agrees with the existing weekPace', () => {
  const resetsAt = new Date(2026, 10, 20, 17, 0).getTime();
  const now = new Date(2026, 10, 15, 15, 43).getTime();
  const v = { state: 'live' as const, pct: 31, resetsAt };
  assert.deepEqual(windowPace(v, now, resetsAt - WEEK_MS), weekPace(v, now));
});

test('the gauge is gated on the OpenCode route, and the chat route requires the session header helper', () => {
  const chat = fs.readFileSync(path.join(process.cwd(), 'src/components/ChatArea.tsx'), 'utf8');
  assert.match(chat, /if \(isGoRoute\) return renderGoGauge\(mobile\);/);
  assert.match(chat, /const isGoRoute = [^\n]*isOpenCodeModel\(effSpecificModel\)/);
  const route = fs.readFileSync(path.join(process.cwd(), 'src/app/api/chat/route.ts'), 'utf8');
  assert.match(route, /headers: openCodeGoHeaders\(/);
  // The gate used to be "Gemini family only". Since 2026-11-27 Go serves ten
  // families, so what it checks instead is the catalog: the id must be one Go
  // serves, under the family this conversation is actually set to.
  assert.match(route, /const goEntry = openCodeGoModel\(specificModel\)/);
  assert.match(route, /if \(!goFamilyMatches\[goEntry\.family\]\)/);
  assert.doesNotMatch(route, /useOpenCodeGo && !isGemini/);
});
