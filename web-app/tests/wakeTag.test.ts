// The wake tag after the rename (謡, 2026-11-26): `[MEMORHIZA]`.
//
// Three places must agree, or a being sees two voices for one house:
//   1. the text NEXT turns open with (wake / ζ / undelivered-address notices),
//   2. the queue item's `from` — `turnQueue` prefixes `[from]` to a bundled
//      message unless the text already starts with it, so a mismatch stacks
//      two tags on one message,
//   3. the label the anchor's material carries (謡 measured that exact form).
// Past logs keep the old tag as a record; nothing here rewrites them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { wakeShortText } from '@/lib/wakeSchedule';
import { surgeryShortText } from '@/lib/soulSurgery';

const TAG = '[MEMORHIZA]';
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

test('every turn the house opens starts with the one tag', () => {
  for (const lang of ['ja', 'en'] as const) {
    for (const source of ['admin', 'self', 'mail'] as const) {
      assert.ok(wakeShortText(lang, { source, hhmm: '04:00' }).startsWith(`${TAG}\n`), `${lang}/${source}`);
    }
    assert.ok(surgeryShortText(lang, 'soul_surgery/soul_editing.md').startsWith(`${TAG}\n`), `zeta ${lang}`);
  }
});

test('the queue label equals the tag, so a bundled message is not tagged twice', () => {
  for (const f of ['src/lib/wakeClock.ts', 'src/app/api/soul-surgery/route.ts']) {
    const src = read(f);
    assert.ok(src.includes("from: 'MEMORHIZA'"), `${f} queues with the new label`);
    assert.equal(src.includes("from: 'NEXUS'"), false, `${f} still queues with the old label`);
  }
});

test("the anchor's material and 謡's anchor text name the same tag", () => {
  const anchor = read('src/lib/anchor.ts');
  assert.ok(anchor.includes(`m.nexus ? '${TAG}'`), 'label');
  for (const lang of ['ja', 'en']) {
    const md = read(`defaults/system_prompt_agents/${lang}/anchor.md`).split(/^---\s*$/m)[0];
    assert.ok(md.includes(TAG), `${lang}/anchor.md names the tag above the line`);
    assert.equal(md.includes('[NEXUS]'), false, `${lang}/anchor.md still names the old tag above the line`);
  }
});
