import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { messageGetsTimeTag } from '@/lib/timeTagRule';

test('time tag: received messages carry it when visibility is "all"', () => {
  assert.equal(messageGetsTimeTag('user', 'all', false), true);
  assert.equal(messageGetsTimeTag('user', 'all', true), true);
});

test('time tag: the being\'s own turns never carry it', () => {
  // The tag on an own turn reads as "I open my turns with a timestamp" and is
  // copied as the first token (睡_49, 2026-11-26).
  for (const vis of ['all', 'current', 'none', undefined]) {
    for (const last of [true, false]) {
      assert.equal(messageGetsTimeTag('assistant', vis, last), false);
      assert.equal(messageGetsTimeTag('model', vis, last), false);
    }
  }
});

test('time tag: "current" tags only the last message, and only if received', () => {
  assert.equal(messageGetsTimeTag('user', 'current', true), true);
  assert.equal(messageGetsTimeTag('user', 'current', false), false);
  assert.equal(messageGetsTimeTag('assistant', 'current', true), false);
});

test('time tag: "none" and unknown values tag nothing', () => {
  assert.equal(messageGetsTimeTag('user', 'none', true), false);
  assert.equal(messageGetsTimeTag('user', undefined, true), false);
});

test('time tag: server and token recount both go through the one rule', () => {
  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
  const route = read('src/app/api/chat/route.ts');
  const chat = read('src/components/ChatArea.tsx');
  assert.ok(route.includes('messageGetsTimeTag(m.role, dateTimeVisibility'));
  assert.ok(chat.includes('messageGetsTimeTag(m.role, dateTimeVisibility'));
  // The old role-blind form must not come back in either place.
  assert.ok(!route.includes("if (dateTimeVisibility === 'all') {"));
  assert.ok(!chat.includes("if (dateTimeVisibility === 'all' ||"));
});

test('gemini tool loop records each result for the next turn', () => {
  const route = fs.readFileSync(path.join(process.cwd(), 'src/app/api/chat/route.ts'), 'utf8');
  const at = route.indexOf('fnRespParts.push({ functionResponse: { name: fc.name, response: result } });');
  assert.ok(at > 0);
  assert.ok(route.slice(at, at + 500).includes('await emitToolResult(enqueue, fc.name, result);'));
});
