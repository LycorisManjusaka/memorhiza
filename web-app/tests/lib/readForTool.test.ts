import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readWorkspaceFileForTool } from '@/lib/fsStorage';

/**
 * 2026-11-21: ミニちゃん Read a 1,382,593-byte mp3 on the MiniMax tool loop. The
 * plain reader decoded it as UTF-8 and the ~1.38M chars of garbage became the
 * tool result; the next request died with "context window exceeds limit".
 * The tool-side reader must hand back text, and only text.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-readtool-'));

test('a text file comes back whole', async () => {
  const p = path.join(dir, 'note.md');
  fs.writeFileSync(p, '# 光を手放す\nhello\n', 'utf-8');
  const out = await readWorkspaceFileForTool('Probe', p, { fullAccess: true });
  assert.equal(out, '# 光を手放す\nhello\n');
});

test('an mp3 is not decoded into the result', async () => {
  const p = path.join(dir, 'song.mp3');
  // ID3v2 header (carries NUL bytes) followed by frame-ish noise.
  const head = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x21]);
  const body = Buffer.alloc(200_000);
  for (let i = 0; i < body.length; i++) body[i] = (i * 131 + 7) & 0xff;
  fs.writeFileSync(p, Buffer.concat([head, body]));
  const out = await readWorkspaceFileForTool('Probe', p, { fullAccess: true });
  assert.ok(out !== null);
  assert.ok(out!.length < 400, `result must be one short line, got ${out!.length} chars`);
  assert.match(out!, /not a text file/);
  assert.match(out!, /\.mp3/);
  assert.match(out!, /200010 bytes/);
});

test('a missing file is still null', async () => {
  const out = await readWorkspaceFileForTool('Probe', path.join(dir, 'nope.txt'), { fullAccess: true });
  assert.equal(out, null);
});
