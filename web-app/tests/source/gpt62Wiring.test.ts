/**
 * GPT-6.2 Sol / Astra wiring (added 2026-11-21).
 *
 * Measured 2026-11-21 against api.openai.com (real calls, both ids):
 *   - listed in /v1/models
 *   - reasoning_effort 'none' and 'minimal' -> 400; low|medium|high|xhigh -> 200
 *   - function tools on /v1/chat/completions -> 400 at 'low' AND when omitted
 *   - /v1/responses + tools -> 200 function_call, stateless round 2 -> 200
 *   - vision: red and blue 64x64 PNGs both named correctly
 *
 * The load-bearing gate is 2: without the no-'none' entry NEXUS would send
 * reasoning_effort 'none' for thinking-OFF and for every tool turn, and both
 * are a measured 400 — the models would be in the list and unusable with tools.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { resolvePrice } from '@/lib/modelPricing';
import { VISION_CAPABLE_MODELS } from '@/lib/modelVision';
import { openAiCannotUseTools, openAiOffEffort } from '@/lib/openaiEffort';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf-8');
const picker = read('components', 'FamilyModelPicker.tsx');

describe('GPT-6.2 wiring', () => {
  it('1. both are priced at the published Standard rows, long-context tier included', () => {
    const sol = resolvePrice('gpt-6.2-sol');
    const astra = resolvePrice('gpt-6.2-astra');
    assert.ok(sol && astra, 'a missing row drops these turns from the statistics');
    assert.deepEqual([sol!.input, sol!.cachedInput, sol!.output], [2, 0.1, 10]);
    assert.deepEqual([astra!.input, astra!.cachedInput, astra!.output], [8, 0.4, 40]);
    const raw = JSON.parse(read('lib', 'modelPricing.json'));
    assert.equal(raw['gpt-6.2-sol'].longContextThreshold, 272000);
    assert.equal(raw['gpt-6.2-astra'].longContextInput, 16);
    assert.equal(raw['gpt-6.2-astra'].longContextOutput, 60);
  });

  it("2. neither has 'none': thinking-OFF is 'low' and tool turns take the responses path", () => {
    for (const id of ['gpt-6.2-sol', 'gpt-6.2-astra']) {
      assert.equal(openAiOffEffort(id), 'low', id);
      assert.equal(openAiCannotUseTools(id), true, id);
    }
    // The neighbours that DO accept 'none' must not be swept in by the new ids.
    assert.equal(openAiCannotUseTools('gpt-6.1-terra'), false);
    assert.equal(openAiCannotUseTools('gpt-6-sol'), false);
    assert.equal(openAiOffEffort('gpt-6-luna'), 'none');
  });

  it('3. both see images natively and are offered in the picker', () => {
    for (const id of ['gpt-6.2-sol', 'gpt-6.2-astra']) {
      assert.ok(VISION_CAPABLE_MODELS.has(id), id);
      assert.ok(picker.includes(`<option value="${id}">`), `${id} is not in FamilyModelPicker`);
    }
  });
});
