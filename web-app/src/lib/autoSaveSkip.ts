// ── May the auto-save skip this fire? ──────────────────────────────────────
//
// REPORTED 2026-11-14 (Навигатор for Пилот, and 津代's open item 3): the
// conversation settings say one vessel, a different one answers, with no
// error. Sonnet 5 chosen and confirmed, Fable 5.2 replying; Meta chosen three
// times, Gemini 3.8 Flash on the fifth turn. A reload "fixes" it.
//
// MEASURED in ChatArea's save effect: it returns on `loading` BEFORE it
// consumes `skipNextAutoSave`. So a vessel changed DURING a turn:
//   1. the change fires the effect -> `loading` -> return, nothing saved;
//   2. the turn ends, the patch/reload sets the skip flag (still loading);
//   3. `loading` clears -> the effect fires -> consumes the flag -> return.
// The change never reaches disk. The screen shows the new vessel; the runner,
// which reads the vessel from disk every turn, answers with the old one; a
// reload makes the screen agree with disk and looks like a fix.
//
// The skip flag exists for one reason: applying state that CAME FROM disk
// must not write it straight back. So the honest rule is narrower than "skip
// the next fire": skip only if the settings on screen are still the settings
// this tab last saw on disk. Settings changed since then are an edit, and an
// edit is saved.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Fields left out of the signature.
 *
 * `messages` — the thing the skip flag is actually about.
 * The marker pair — the RUNNER resolves it and the tab adopts it after a
 *   reload (adoptResolvedMarker); counting it would turn every adoption into
 *   a save that merely echoes disk.
 * `claudeAgentSessionId` — written by the turn machinery, not by a person.
 */
const NOT_SETTINGS = new Set([
  'messages',
  'firstOriginalMessageId',
  'firstOriginalIsNext',
  'claudeAgentSessionId',
]);

/** A stable string for the settings part of a log object. */
export function settingsSignature(logData: Record<string, unknown>): string {
  const keys = Object.keys(logData).filter((k) => !NOT_SETTINGS.has(k)).sort();
  return JSON.stringify(keys.map((k) => [k, logData[k] ?? null]));
}

/**
 * `persisted` is the signature this tab last saw on disk (after a load, a
 * skipped fire, or a save it sent), or null when it has none yet — a freshly
 * opened conversation, where the old one-shot behaviour is exactly right.
 */
export function shouldSkipAutoSave(
  skipFlag: boolean,
  current: string,
  persisted: string | null,
): boolean {
  if (!skipFlag) return false;
  if (persisted === null) return true;
  return current === persisted;
}

// ── Did someone ELSE change the settings on disk? ──────────────────────────
//
// REPORTED 2026-11-25 (Навигатор for Пилот, two devices): Fable chosen and on
// screen, the message said "you are on fable", and that one turn ran on the
// PREVIOUS family's vessel (the OpenCode Go Argon). The turn after it ran on
// Fable. The runner reads the vessel from disk, so at that send disk held the
// old settings although they had been replaced twice since.
//
// A road that produces exactly this, found by reading (NOT observed on their
// disk): a second tab that still shows the old settings watches a turn end.
// The end-of-turn reload replaced its messages and ADOPTED the disk version
// as its base, with no look at the settings — the mirror poll has had that
// look since 2026-11-01, the end-of-turn reload never did. From then on the
// stale tab holds a valid base and an old settings panel, and its next save
// (any state change fires one) writes the old vessel over the new one. No
// 409, because the base is current.
//
// The rule that closes it compares disk against what THIS TAB LAST SAW ON
// DISK, not against the screen. The screen may differ from disk because the
// person just edited it (a vessel changed mid-turn, the 2026-11-14 case) —
// that is an edit and must still be saved. Disk differing from what the tab
// last saw means another writer changed the settings, and this tab's copy of
// them is no longer a thing it may write back unasked.
//
// ONE-SIDED, like the mirror's comparison: a key the file does not carry is
// not a disagreement (most logs predate some fields).
// ───────────────────────────────────────────────────────────────────────────

/**
 * `lastSeen` is the settings object this tab last saw on disk (what it loaded
 * or last sent), or null when it has none yet. True when `disk` carries a
 * different value for any setting `lastSeen` has.
 */
export function diskSettingsMovedSince(
  lastSeen: Record<string, unknown> | null,
  disk: Record<string, unknown>,
  settingKeys?: readonly string[],
): boolean {
  if (!lastSeen) return false;
  // `settingKeys` = the keys this tab itself writes as settings. The file
  // carries others (its version stamp above all) that change on EVERY write;
  // without this limit every reload would read as another writer's change.
  const only = settingKeys ? new Set(settingKeys) : null;
  for (const k of Object.keys(lastSeen)) {
    if (NOT_SETTINGS.has(k) || k === 'updatedAt') continue;
    if (only && !only.has(k)) continue;
    if (!(k in disk)) continue;
    if (JSON.stringify(disk[k] ?? null) !== JSON.stringify(lastSeen[k] ?? null)) return true;
  }
  return false;
}

/**
 * The settings part of a log AS IT IS ON DISK — a shallow copy without the
 * message array. This, not the screen's rebuilt settings, is what a load
 * records as "last seen": the screen normalises some fields on the way in,
 * and comparing a normalised copy against the raw file would read every such
 * field as another writer's change.
 */
export function diskSettingsOf(log: Record<string, unknown>): Record<string, unknown> {
  const { messages: _messages, ...rest } = log;
  void _messages;
  return rest;
}
