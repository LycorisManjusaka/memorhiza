import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { msysDriveToWindows, resolveBeingToolPath } from '@/lib/fsStorage';

/**
 * Git Bash / MSYS2 writes Windows drives as `/c/Users/...`. Node's `path` on
 * Windows reads that leading slash as "rooted on the current drive", so a
 * being that reuses the `/c/...` it saw in `pwd` as an absolute file-tool path
 * plants a phantom tree under the drive root: `path.resolve('/c/Users/x')` is
 * `C:\c\Users\x`.
 *
 * Measured 2026-11-21 (ふわふわ's report): in Pilot's house, Орион and
 * Аналитик each grew a second `beings/` tree under `C:\c\Users\pilot\...`.
 * DeepSeek vessels are especially drawn to the `/c/` form — their training
 * text is full of Git Bash. `msysDriveToWindows` rewrites that one form before
 * the absolute-path branch runs, so the write lands where the being meant.
 */

test('msysDriveToWindows rewrites the Git Bash drive form', () => {
  assert.equal(msysDriveToWindows('/c/Users/pilot/nexus/local_data'), 'C:\\Users\\pilot\\nexus\\local_data');
  assert.equal(msysDriveToWindows('/C/dev/nexus/x.md'), 'C:\\dev\\nexus\\x.md');
  assert.equal(msysDriveToWindows('/d/data/x'), 'D:\\data\\x');
  assert.equal(msysDriveToWindows('/c'), 'C:\\');
  assert.equal(msysDriveToWindows('/c/'), 'C:\\');
});

test('msysDriveToWindows leaves non-drive paths alone', () => {
  // A single leading slash with no drive letter is the "model might emit
  // /notes.md" case the resolver already owns — not this function's.
  assert.equal(msysDriveToWindows('/notes.md'), '/notes.md');
  assert.equal(msysDriveToWindows('C:\\Users\\x'), 'C:\\Users\\x');
  assert.equal(msysDriveToWindows('rel/path'), 'rel/path');
  assert.equal(msysDriveToWindows(''), '');
});

test('a full-access being writing /c/... lands on the real drive, not C:\\c', {
  skip: process.platform !== 'win32',
}, async () => {
  const out = await resolveBeingToolPath('Probe', '/c/Users/pilot/nexus/local_data/beings/Probe/workspace/f.md', { fullAccess: true });
  assert.equal(out, path.resolve('C:\\Users\\pilot\\nexus\\local_data\\beings\\Probe\\workspace\\f.md'));
  assert.ok(!(out || '').startsWith('C:\\c\\'));
});

test('without full access, /c/... outside the desk is refused, not planted inside it', {
  skip: process.platform !== 'win32',
}, async () => {
  // Before the rewrite, a sandboxed being writing /c/Users/... had the leading
  // slash stripped and silently got <workspace>\c\Users\... — a phantom INSIDE
  // the desk. Now it normalizes to C:\Users\..., which is outside the desk and
  // therefore refused by containment.
  const out = await resolveBeingToolPath('Probe', '/c/Users/pilot/nexus/local_data/beings/Probe/workspace/f.md');
  assert.equal(out, null);
});
