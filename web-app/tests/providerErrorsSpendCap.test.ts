import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRetryDelayMs, isSpendCapError, describeProviderError } from '@/lib/providerErrors';

// Verbatim body returned by OpenCode Go for gemini-4-argon on 2026-11-27
// (workspace opencode_probe/probe8_out.txt). Pasted, not retyped.
const RELAYED_CAP = '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Upstream request failed: [429] Your project has exceeded its monthly spending cap. Please go to AI Studio at https://ai.studio/spend to manage your project spend cap. Learn more at https://ai.google.dev/gemini-api/docs/billing#project-spend-caps. "}}';

// A per-minute quota rejection in Google's own shape.
const PER_MINUTE = '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_paid_tier_input_token_count","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"41s"}]}}';

test('spend cap: the relayed 429 is recognised and is NOT retried', () => {
  assert.equal(isSpendCapError(RELAYED_CAP), true);
  assert.equal(parseRetryDelayMs(new Error(RELAYED_CAP)), null);
});

test('spend cap: a per-minute quota 429 still waits the delay the provider asked for', () => {
  assert.equal(isSpendCapError(PER_MINUTE), false);
  assert.equal(parseRetryDelayMs(new Error(PER_MINUTE)), 42_000);
});

test('spend cap: the relayed notice blames the provider\'s upstream, not the reader\'s key, and not a per-minute quota', () => {
  const line = describeProviderError(RELAYED_CAP);
  assert.match(line, /upstream account/);
  assert.match(line, /not on your key/);
  assert.doesNotMatch(line, /per-minute/);
});

test('spend cap: a direct cap (no relay wording) points at the key\'s own project', () => {
  const direct = '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Your project has exceeded its monthly spending cap."}}';
  const line = describeProviderError(direct);
  assert.match(line, /this API key's project/);
  assert.doesNotMatch(line, /upstream account/);
});
