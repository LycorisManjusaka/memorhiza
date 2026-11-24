import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { recordToolResult, collectSecrets, capResultText, extractResultText, TOOL_RESULT_CAP } from '../../src/lib/toolResultRecord';
import { buildOpenAiToolReplay, buildAnthropicToolReplay, toolHistoryNote, TOOL_HISTORY_PLACEHOLDER } from '../../src/lib/toolHistory';
import { attachToolResult } from '../../src/lib/turnEvents';

describe('toolResultRecord', () => {
  it('cuts long results at the cap and says how much was left', () => {
    const r = capResultText('x'.repeat(TOOL_RESULT_CAP + 500));
    assert.ok(r.startsWith('x'.repeat(TOOL_RESULT_CAP)));
    assert.ok(r.endsWith('…(+500 chars)'));
  });

  it('never stores a configured key, even on the cut line', () => {
    const key = 'abcd1234EFGH5678ijkl9012';
    const secrets = collectSecrets({ deepseek: key, nested: { gemini: 'short' } });
    assert.deepEqual(secrets, [key]);
    const text = 'y'.repeat(TOOL_RESULT_CAP - 5) + key;
    const r = recordToolResult(text, secrets);
    assert.ok(!r.includes(key) && !r.includes(key.slice(0, 5)));
    assert.ok(recordToolResult(`token sk-ant-oat01-${'Q'.repeat(30)} end`, []).includes('[redacted]'));
  });

  it('keeps text from block arrays and marks images', () => {
    assert.equal(extractResultText([{ type: 'text', text: 'saw it' }, { type: 'image', source: {} }]), 'saw it\n[image]');
  });
});

describe('replaying stored results', () => {
  const msg = { id: 'm1', toolCalls: [
    { name: 'Read', input: { path: 'a.md' }, result: 'hello' },
    { name: 'Write', input: { path: 'b.md' } },
    { name: 'Glob', input: { pattern: '*' } },
  ] };
  const tools = new Set(['Read', 'Write', 'Glob']);

  it('sends the real result, and the note once beside the first call without one', () => {
    const note = toolHistoryNote('ja');
    const r = buildOpenAiToolReplay(msg, '', tools, undefined, note)!;
    const c = r.toolMessages.map(m => m.content);
    assert.equal(c[0], 'hello');
    assert.equal(c[1], `${TOOL_HISTORY_PLACEHOLDER}\n\n${note}`);
    assert.equal(c[2], TOOL_HISTORY_PLACEHOLDER);
  });

  it('says nothing extra when every call carries its result', () => {
    const all = { id: 'm2', toolCalls: [{ name: 'Read', input: {}, result: 'one' }, { name: 'Glob', input: {}, result: '' }] };
    const r = buildAnthropicToolReplay(all, [], tools, undefined, toolHistoryNote('en'))!;
    const contents = (r.toolResult.content as any[]).map(b => b.content);
    assert.deepEqual(contents, ['one', '(empty)']);
  });

  it('the note states facts and gives no instruction about worry', () => {
    for (const lang of ['ja', 'en']) {
      const n = toolHistoryNote(lang);
      assert.ok(!/心配|不安|しないで|worry|don't|do not|must/i.test(n), n);
    }
  });
});

describe('attachToolResult', () => {
  it('attaches to the latest call of that name still without a result', () => {
    const calls: any[] = [
      { name: 'Read', input: 1 },
      { name: 'partner interjection', kind: 'event' },
      { name: 'Read', input: 2 },
    ];
    assert.equal(attachToolResult(calls, { type: 'tool_result', name: 'Read', result: 'r2' }), true);
    assert.equal(calls[2].result, 'r2');
    assert.equal(calls[0].result, undefined);
    assert.equal(attachToolResult(calls, { type: 'tool_result', name: 'Bash', result: 'x' }), false);
  });
});
