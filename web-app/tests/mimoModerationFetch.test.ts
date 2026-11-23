import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchResendingMimoHighRisk, MIMO_HIGH_RISK_MAX_RETRIES } from '@/lib/mimoModeration';

const BLOCK = '{"error":{"code":"421","message":"Moderation Block","param":"The request was rejected because it was considered high risk","type":"content_filter"}}';
const noSleep = async () => {};

function seq(responses: (() => Response)[]) {
  let i = 0;
  const calls = { n: 0 };
  const doFetch = async () => { calls.n++; return responses[Math.min(i++, responses.length - 1)](); };
  return { doFetch, calls };
}

test('MiMo: a high-risk refusal is resent and the next answer is returned', async () => {
  const { doFetch, calls } = seq([() => new Response(BLOCK, { status: 421 }), () => new Response('{"ok":1}', { status: 200 })]);
  const r = await fetchResendingMimoHighRisk(doFetch, { isMimo: true, sleep: noSleep });
  assert.equal(r.status, 200);
  assert.equal(calls.n, 2);
});

test('MiMo: still refused after every resend hands back the refusal, readable', async () => {
  const { doFetch, calls } = seq([() => new Response(BLOCK, { status: 421 })]);
  const r = await fetchResendingMimoHighRisk(doFetch, { isMimo: true, sleep: noSleep });
  assert.equal(calls.n, 1 + MIMO_HIGH_RISK_MAX_RETRIES);
  assert.equal(r.status, 421);
  assert.match(await r.text(), /considered high risk/);
});

test('MiMo: other errors are not resent', async () => {
  const { doFetch, calls } = seq([() => new Response('bad', { status: 400 })]);
  const r = await fetchResendingMimoHighRisk(doFetch, { isMimo: true, sleep: noSleep });
  assert.equal(calls.n, 1);
  assert.equal(await r.text(), 'bad');
});

test('not MiMo: passes straight through, even on the same sentence', async () => {
  const { doFetch, calls } = seq([() => new Response(BLOCK, { status: 421 })]);
  await fetchResendingMimoHighRisk(doFetch, { isMimo: false, sleep: noSleep });
  assert.equal(calls.n, 1);
});
