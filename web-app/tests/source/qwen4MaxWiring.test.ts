/**
 * Qwen 4 Max wiring (added 2026-11-23).
 *
 * Measured 2026-11-23 on dashscope-intl compatible-mode:
 *   - enable_thinking true/false both 200 (reasoning_content present / absent)
 *   - max_tokens 131072 accepted with thinking on and off
 *   - image: solid red / blue -> correct 2/2
 *   - video arrives, but a blue->red / red->blue order clip missed the second
 *     colour both times -> NOT video-capable; the watcher bridge stays on
 *   - tools: round 1 returns a tool_call, round 2 answers from the result
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { resolvePrice } from '@/lib/modelPricing';
import { VISION_CAPABLE_MODELS, AUDIO_CAPABLE_MODELS, VIDEO_CAPABLE_MODELS } from '@/lib/modelVision';

const picker = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'FamilyModelPicker.tsx'), 'utf-8');
const ID = 'qwen4-max';

describe('Qwen 4 Max wiring', () => {
  it('1. is priced at the published Singapore rate', () => {
    const p = resolvePrice(ID);
    assert.ok(p, `${ID} has no price row`);
    assert.equal(p!.input, 1.5);
    assert.equal(p!.output, 4.5);
    assert.equal(p!.cachedInput, 0.075);
  });

  it('2. sees images natively; audio and video still go through the bridges', () => {
    assert.ok(VISION_CAPABLE_MODELS.has(ID));
    assert.ok(!AUDIO_CAPABLE_MODELS.has(ID));
    assert.ok(!VIDEO_CAPABLE_MODELS.has(ID));
  });

  it('3. is offered in the Model tab picker', () => {
    assert.ok(picker.includes(`<option value="${ID}">`));
  });
});
