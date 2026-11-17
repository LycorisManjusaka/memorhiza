// An operator override folder must not hide bundled agent files it lacks
// (anchor.md / wake.md arrived after many overrides were copied).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'systemPromptStorage.ts'), 'utf-8');

test('readAllAgentFiles merges bundled files missing from the override', () => {
  const body = src.slice(src.indexOf('export async function readAllAgentFiles'));
  assert.match(body, /root !== BUNDLED_AGENTS_DIR/);
  assert.match(body, /if \(!have\.has\(b\.name\)\) merged\.push\(b\)/);
});

test('bundled defaults carry anchor.md and wake.md in both languages', () => {
  for (const lang of ['ja', 'en']) {
    for (const f of ['anchor.md', 'wake.md']) {
      assert.ok(fs.existsSync(path.join(process.cwd(), 'defaults', 'system_prompt_agents', lang, f)), `${lang}/${f}`);
    }
  }
});
