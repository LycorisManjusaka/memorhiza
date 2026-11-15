// Two tabs on one conversation must not both send the same VRChat photo
// (MEASURED 2026-11-15: one interjection carried the same file twice).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimCapture } from '@/lib/vrchatCaptureClaims';

test('the second tab on the same conversation does not get the photo', () => {
  assert.equal(claimCapture('c1', 'C:/pics/a.png', 1000), true);
  assert.equal(claimCapture('c1', 'C:/pics/a.png', 1001), false);
});

test('the same path spelled differently is still the same photo', () => {
  assert.equal(claimCapture('c2', 'C:/pics/B.png', 1000), true);
  assert.equal(claimCapture('c2', 'c:\\pics\\b.png', 1001), false);
});

test('a different conversation still gets its own copy', () => {
  assert.equal(claimCapture('c3', 'C:/pics/c.png', 1000), true);
  assert.equal(claimCapture('c4', 'C:/pics/c.png', 1000), true);
});

test('a connection without a conversation id keeps the old behaviour', () => {
  assert.equal(claimCapture('', 'C:/pics/d.png', 1000), true);
  assert.equal(claimCapture('', 'C:/pics/d.png', 1001), true);
});
