import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMimoHighRisk, MIMO_HIGH_RISK_MAX_RETRIES } from '@/lib/mimoModeration';

const REPORTED = '{"error":{"code":"421","message":"Moderation Block","param":"The request was rejected because it was considered high risk","type":"content_filter"}}';

test('the publicly reported 421 body is a high-risk block', () => {
  assert.equal(isMimoHighRisk(421, REPORTED), true);
});

test('the sentence alone counts, whatever the status (the status is unmeasured here)', () => {
  assert.equal(isMimoHighRisk(400, 'The request was rejected because it was considered high risk'), true);
  assert.equal(isMimoHighRisk(421, '{"message":"Moderation Block"}'), true);
});

test('ordinary errors are not mistaken for it', () => {
  assert.equal(isMimoHighRisk(429, '{"error":"rate limit"}'), false);
  assert.equal(isMimoHighRisk(400, '{"error":"invalid params, context window exceeds limit"}'), false);
  assert.equal(isMimoHighRisk(421, 'Misdirected Request'), false);
});

test('three resends, as ふわふわ set it', () => {
  assert.equal(MIMO_HIGH_RISK_MAX_RETRIES, 3);
});
