// The manual anchor (2026-11-19): settleRewrite is the one place the automatic
// REWRITE and the manual "rewrite this reply" button build their record, and
// anchorSse is the stream the manual routes answer with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleRewrite } from '@/lib/anchorRewrite';
import { anchorSseResponse, readAnchorSse } from '@/lib/anchorSse';

const usage = { cachedInputTokens: 10, uncachedInputTokens: 90, totalInputTokens: 100, outputTokens: 7, cacheCreationTokens: 0, providerHint: 'deepseek' };

test('settleRewrite: applied → new text, original kept, usage and time on the record', () => {
  const before = '今日は做完了しました。';
  const w = { output: '[[OLD]]做完了[[NEW]]やり終え[[END]]', usage, ms: 1234 };
  const { record, after } = settleRewrite({ before, lang: '日本語', model: 'deepseek-flash', at: 5, w });
  assert.equal(after, '今日はやり終えしました。');
  assert.equal(record.ok, true);
  assert.equal(record.before, before);
  assert.equal(record.applied, 1);
  assert.deepEqual(record.usage, usage);
  assert.equal(record.ms, 1234);
});

test('settleRewrite: nothing matched → text kept, reason recorded, still billed', () => {
  const { record, after } = settleRewrite({
    before: 'abc', lang: '日本語', model: 'm', at: 1,
    w: { output: '[[OLD]]zzz[[NEW]]y[[END]]', usage, ms: 9 },
  });
  assert.equal(after, null);
  assert.equal(record.ok, false);
  assert.equal(record.before, undefined);
  assert.deepEqual(record.usage, usage);
});

test('settleRewrite: no writer prompt → no-prompt', () => {
  const { record, after } = settleRewrite({ before: 'x', lang: 'L', model: 'm', at: 1, w: null });
  assert.equal(after, null);
  assert.equal(record.reason, 'no-prompt');
});

test('anchorSse: live frames reach onFrame, the final frame is returned', async () => {
  const res = anchorSseResponse(async (send) => {
    send({ type: 'anchor_live', assistantId: 'a', stage: 'judge', model: 'm', start: true });
    send({ type: 'anchor_live', assistantId: 'a', stage: 'judge', model: 'm', text: 'REWRITE' });
    send({ type: 'anchor_report', report: { output: 'REWRITE' } });
  });
  const seen: unknown[] = [];
  const final = await readAnchorSse(res, 'anchor_report', (d) => seen.push(d));
  assert.equal((final as any).report.output, 'REWRITE');
  assert.equal(seen.filter((d: any) => d.type === 'anchor_live').length, 2);
});

test('anchorSse: a throw inside still ends with a final frame carrying the error', async () => {
  const res = anchorSseResponse(async () => { throw new Error('boom'); });
  const final = await readAnchorSse(res, 'anchor_report', () => {});
  assert.equal((final as any).error, 'boom');
});
