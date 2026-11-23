/**
 * "Has this being's settings.json changed since this tab last looked?"
 *
 * WHY (2026-11-24, ふわふわ's report on 睡_49). A tab reads every being's
 * settings ONCE, when it mounts. Two tabs on the same conversation is a
 * supported arrangement, and the conversation itself is mirrored between them —
 * but the being's settings were not. So when the conversation-log cap was
 * raised from 80k to 120k in one tab, the other kept 80k forever, and the two
 * fought over the same log:
 *
 *   tab A (cap 120k): room exists      -> restores 21 carried-over messages, saves
 *   tab B (cap  80k): log is over cap  -> trims the same 21, saves
 *
 * MEASURED on disk: the log alternated 96 <-> 75 messages every ~5 s (one 5 MB
 * rewrite each time), and tab A raised "handover restored" again on every lap.
 * Each side was correct by its own number; the numbers disagreed.
 *
 * The fix is not to referee the two effects but to remove the disagreement:
 * the stock poll every tab already runs (10 s, 5 s mid-turn) carries the
 * settings file's modification time, and a tab that sees it move re-reads the
 * settings. One stat per poll; a re-read only when something was written.
 *
 * Pure so the rule is testable; the stat lives in the route.
 */

/**
 * @param prev  the stamp this tab saw on its previous poll (null = never polled
 *              for this being yet)
 * @param now   the stamp in the poll that just arrived (0 / NaN / undefined =
 *              the server did not report one: an older server, or no file)
 * @returns true when the tab should re-read the being settings
 */
export function settingsStampMoved(prev: number | null, now: unknown): boolean {
  const n = typeof now === 'number' ? now : NaN;
  // No stamp reported: say nothing rather than refetch on every poll.
  if (!Number.isFinite(n) || n <= 0) return false;
  // First observation only records. The tab read the settings moments ago, at
  // mount; treating "first seen" as "changed" would refetch on every open.
  if (prev === null) return false;
  // `!==`, not `>`: a restored backup or a clock step can move the time
  // backwards, and that is still a different file.
  return n !== prev;
}
