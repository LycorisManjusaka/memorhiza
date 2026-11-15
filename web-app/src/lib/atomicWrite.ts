import fs from 'fs/promises';
import path from 'path';

// ───────────────────────────────────────────────────────────────────────────
// Atomic file write — the single source.
//
// Three storage modules (fsStorage, summaryStorage, changelogStorage) each
// carried a private copy of this function until 2026-10-27. The copies in
// summaryStorage and changelogStorage were byte-identical to each other;
// fsStorage's differed only by one inline comment. Only fsStorage's copy
// carried the explanation below, so a fix landing in one copy — an fsync, a
// retry for the antivirus EPERM window on Windows, a different temp-file
// location — would have left the other two on the old behaviour SILENTLY.
//
// It lives in its own module rather than being exported from fsStorage
// because fsStorage imports summaryStorage (`summaryKey`): exporting from
// there and importing it back would be a cycle.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Write `data` to `filePath` so that a crash or a concurrent writer can never
 * leave a half-written file behind.
 *
 * Writes to a unique temp file in the SAME directory (so the rename is a
 * same-volume operation), then renames onto the target. `fs.rename` on the
 * same filesystem is atomic on Windows (MoveFileEx replace semantics) and on
 * POSIX (atomic by spec). If the write is interrupted or the process dies
 * mid-way, the destination either retains its old contents or contains the
 * full new contents — never a half-overwritten frankenfile.
 *
 * On failure the temp file is removed and the original error is re-thrown, so
 * callers see the real reason and no `.tmp-*` files leak.
 */
export async function atomicWriteFile(filePath: string, data: string) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = path.join(dir, `.${base}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    await fs.writeFile(tmp, data);
    await renameWithRetry(tmp, filePath);
  } catch (e) {
    // Clean up tmp on failure so we don't leak .tmp-* files
    try { await fs.unlink(tmp); } catch {}
    throw e;
  }
}

// On Windows, replacing a file fails with EPERM / EACCES / EBUSY while ANY
// other process holds it open without delete-sharing — a parallel reader,
// the antivirus scanner, the search indexer. That window is short, but it
// grows with the file: a 10 MB conversation log is open for longer on every
// read. Observed 2026-11-15: a finished turn's final save died on exactly
// this, the turn's reply was lost and the queue item came back. The rename
// stays atomic; we only wait the window out instead of giving up on the
// first collision. ~6 s total before the real error is re-thrown.
const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RETRY_DELAYS_MS = [25, 50, 100, 200, 300, 500, 750, 1000, 1500, 1500];

export async function renameWithRetry(
  from: string,
  to: string,
  rename: (a: string, b: string) => Promise<void> = fs.rename,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
) {
  for (let i = 0; ; i++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (!code || !RETRYABLE.has(code) || i >= RETRY_DELAYS_MS.length) throw e;
      await sleep(RETRY_DELAYS_MS[i]);
    }
  }
}
