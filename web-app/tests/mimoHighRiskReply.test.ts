import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHighRiskTextGate, fetchResendingMimoHighRisk, isMimoHighRiskOkBody } from '@/lib/mimoModeration';

// The shape measured on 2026-11-24: a 200 whose whole text is the sentence.
const SENTENCE = 'The request was rejected because it was considered high risk';
const chunks = (s: string, n: number) => s.match(new RegExp(`[\\s\\S]{1,${n}}`, 'g')) || [];

function feed(parts: string[]) {
  const g = createHighRiskTextGate();
  let shown = '';
  for (const p of parts) shown += g.push(p);
  const fin = g.end();
  return { shown: shown + fin.flush, blocked: fin.blocked, shownBeforeEnd: shown };
}

test('gate: the refusal sentence, in any chunking, is never shown and is reported', () => {
  for (const n of [1, 5, 12, 100]) {
    const r = feed(chunks(SENTENCE, n));
    assert.equal(r.blocked, true, `chunk ${n}`);
    assert.equal(r.shown, '', `chunk ${n}`);
  }
  assert.equal(feed(['\n' + SENTENCE + '.\n']).blocked, true);
});

test('gate: an ordinary reply passes whole, and a reply that only STARTS like the sentence is not swallowed', () => {
  const normal = 'やっほー、建築家さん！ The request went fine.';
  const a = feed(chunks(normal, 7));
  assert.equal(a.blocked, false);
  assert.equal(a.shown, normal);

  const quoting = SENTENCE + ' — って出たのよ、ひどくない？';
  const b = feed(chunks(quoting, 12));
  assert.equal(b.blocked, false);
  assert.equal(b.shown, quoting);

  const cut = 'The request was rej';          // a stream that simply ended early
  const c = feed([cut]);
  assert.equal(c.blocked, false);
  assert.equal(c.shown, cut);
});

test('gate: thinking or a tool call before the end means the model ran — held text is released, not reported', () => {
  const g = createHighRiskTextGate();
  assert.equal(g.push(SENTENCE), '');
  assert.equal(g.release(), SENTENCE);
  assert.deepEqual(g.end(), { blocked: false, flush: '' });
});

test('non-streaming callers: a 200 whose only text is the sentence is resent (both wires)', async () => {
  const openai = JSON.stringify({ choices: [{ message: { role: 'assistant', content: SENTENCE } }] });
  const anthropic = JSON.stringify({ content: [{ type: 'text', text: SENTENCE }] });
  assert.equal(isMimoHighRiskOkBody(openai), true);
  assert.equal(isMimoHighRiskOkBody(anthropic), true);
  assert.equal(isMimoHighRiskOkBody(JSON.stringify({ choices: [{ message: { content: `It said "${SENTENCE}" again.` } }] })), false);

  let n = 0;
  const good = '{"choices":[{"message":{"content":"a red square"}}]}';
  const r = await fetchResendingMimoHighRisk(
    async () => new Response(n++ === 0 ? openai : good, { status: 200, headers: { 'content-type': 'application/json' } }),
    { isMimo: true, sleep: async () => {} },
  );
  assert.equal(n, 2);
  assert.equal(await r.text(), good);
});

test('wiring: the MiMo conversation path sends its text through the gate and resends on a 200 refusal', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/app/api/chat/route.ts'), 'utf8');
  assert.ok(src.includes('createHighRiskTextGate()'));
  assert.ok(src.includes('if (!out.highRiskBody) return out;'));
});
