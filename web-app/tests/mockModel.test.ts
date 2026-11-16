import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMockScenario, planMockRound, planZombieRound, zombieTranslate, mockChunks, isMockModelId, mockNameFromId, MOCK_DEFAULTS, lastToolResultText, fillLastResult, mockRoundsDoneFor } from '../src/lib/mockModel';

test('zombie: read-only calls run for real (translated), writes become stand-ins, then the answer', () => {
  const s = parseMockScenario({
    thoughtLast: 'last', answer: 'done',
    steps: [
      { thought: 'a', tool: { name: 'Read', args: { file_path: 'notes/x.md' } }, waitSec: 2 },
      { thought: 'b', tool: { name: 'Edit', args: { file_path: 'notes/x.md', old_string: 'p', new_string: 'q' } } },
      { thought: 'c', tool: { name: 'Edit', args: { file_path: 'y' } } },
      { thought: 'd', tool: { name: 'mcp__nexus__read_conversation', args: { name: 'Cairn_2' } } },
    ],
  });
  const tools = ['Read', 'Write', 'Edit', 'Glob', 'Bash', 'read_conversation'];
  const r0 = planZombieRound(s, 0, tools, false) as any;
  assert.deepEqual(r0.tool, { name: 'Read', args: { path: 'notes/x.md' } });
  assert.equal(r0.selfWaitSec, 2);
  assert.equal(r0.thought, 'a');
  const r1 = planZombieRound(s, 1, tools, false) as any;
  const r2 = planZombieRound(s, 2, tools, false) as any;
  assert.equal(r1.tool.name, 'Bash'); // the Edit did NOT run
  assert.match(r1.tool.args.command, /^echo /);
  assert.notEqual(r1.tool.args.command, r2.tool.args.command); // repeat guard safe
  assert.equal((planZombieRound(s, 3, tools, false) as any).tool.name, 'read_conversation');
  const f = planZombieRound(s, 4, tools, false);
  assert.equal(f.kind, 'final');
});

test('zombie: "live": true lets a write run; no stand-in tool at all → answer, not a silent end', () => {
  const s = parseMockScenario({ steps: [{ thought: 'w', live: true, tool: { name: 'Write', args: { path: 'a', content: 'b' } } }] });
  assert.equal((planZombieRound(s, 0, ['Write'], false) as any).tool.name, 'Write');
  const s2 = parseMockScenario({ steps: [{ thought: 'w', tool: { name: 'Write', args: {} } }] });
  assert.equal(planZombieRound(s2, 0, ['Read'], false).kind, 'final');
  assert.equal(zombieTranslate('mcp__claude_in_chrome__navigate', {}).name, 'navigate');
});

test('a broken or empty scenario plays the defaults instead of failing', () => {
  assert.deepEqual(parseMockScenario(null), MOCK_DEFAULTS);
  const s = parseMockScenario({ toolRounds: 'ten', chunkChars: -5, thoughtBetween: [1, ''] });
  assert.equal(s.toolRounds, MOCK_DEFAULTS.toolRounds);
  assert.equal(s.chunkChars, 1);
  assert.deepEqual(s.thoughtBetween, MOCK_DEFAULTS.thoughtBetween);
});

test('plays exactly toolRounds Bash rounds, then answers', () => {
  const s = parseMockScenario({ toolRounds: 3 });
  const tools = ['Read', 'Bash'];
  for (let i = 0; i < 3; i++) {
    const p = planMockRound(s, i, tools, false);
    assert.equal(p.kind, 'tool');
    if (p.kind === 'tool') assert.equal(p.tool?.name, 'Bash');
  }
  assert.equal(planMockRound(s, 3, tools, false).kind, 'final');
});

test('every Bash command is unique, so the repeat guard never trips', () => {
  const s = parseMockScenario({ toolRounds: 10, toolCommand: 'sleep 10' });
  const cmds = new Set<string>();
  for (let i = 0; i < 10; i++) {
    const p = planMockRound(s, i, ['Bash'], false);
    if (p.kind === 'tool' && p.tool?.name === 'Bash') cmds.add(String(p.tool.args.command));
  }
  assert.equal(cmds.size, 10);
});

test('no Bash → Glob plus a self-wait; no tools or noTools → straight answer', () => {
  const s = parseMockScenario({ toolRounds: 2, fallbackWaitSec: 7 });
  const g = planMockRound(s, 0, ['Glob'], false);
  assert.equal(g.kind, 'tool');
  if (g.kind === 'tool') { assert.equal(g.tool?.name, 'Glob'); assert.equal(g.selfWaitSec, 7); }
  assert.equal(planMockRound(s, 0, [], false).kind, 'final');
  assert.equal(planMockRound(s, 0, ['Bash'], true).kind, 'final');
});

test('ids and chunking', () => {
  assert.ok(isMockModelId('mock:a'));
  assert.ok(!isMockModelId('gemma-4'));
  assert.equal(mockNameFromId('mock:魂のない機械'), '魂のない機械');
  assert.deepEqual(mockChunks('あい😀うえ', 2), ['あい', '😀う', 'え']);
});

test('toolTimeoutSec reaches the Bash call (capped at 600); 0 leaves Bash its default', () => {
  const long = parseMockScenario({ toolRounds: 1, toolCommand: 'x', toolTimeoutSec: 9999 });
  assert.equal(long.toolTimeoutSec, 600);
  const p = planMockRound(long, 0, ['Bash'], false) as any;
  assert.equal(p.tool.args.timeout_ms, 600000);
  const d = planMockRound(parseMockScenario({ toolRounds: 1 }), 0, ['Bash'], false) as any;
  assert.equal('timeout_ms' in d.tool.args, false);
});

test('{lastResult} is filled from the last tool message only, never from what a person wrote', () => {
  const msgs = [
    { role: 'user', content: 'hello' },
    { role: 'tool', content: 'first' },
    { role: 'assistant', content: '' },
    { role: 'tool', content: 'PUSH finished (exit 0)' },
    { role: 'user', content: 'interjection' },
  ];
  assert.equal(lastToolResultText(msgs), 'PUSH finished (exit 0)');
  assert.equal(fillLastResult('done: {lastResult}', lastToolResultText(msgs)), 'done: PUSH finished (exit 0)');
  assert.equal(fillLastResult('{lastResult}', lastToolResultText([{ role: 'user', content: 'x' }])), '(no tool result)');
  assert.equal(fillLastResult('a $& b {lastResult}', '$1'), 'a $& b $1');
});

test('stopWhen ends the script early only after a round has run and its result matches', () => {
  const s = parseMockScenario({ toolRounds: 12, stopWhen: 'DONE-' });
  assert.equal(mockRoundsDoneFor(s, 0, 'DONE-OK'), 0); // never before the first round
  assert.equal(mockRoundsDoneFor(s, 1, 'RUNNING'), 1);
  assert.equal(planMockRound(s, mockRoundsDoneFor(s, 1, 'DONE-OK (exit 0)'), ['Bash'], false).kind, 'final');
  assert.equal(mockRoundsDoneFor(parseMockScenario({ toolRounds: 3 }), 1, 'DONE-OK'), 1); // '' = never
});
