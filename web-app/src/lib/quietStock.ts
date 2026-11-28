// "Leave it without waking them" — the third thing the send button can do
// (トカゲくん, 2026-11-28).
//
// His words: after a being finishes a piece of work he reads the result and
// writes "confirmed, X was good, thank you" at once — but there is no reason
// to start a turn for that; the being will wake anyway and can read it then.
// Until now he sent, pressed stop, and deleted the empty reply.
//
// HOW IT DIFFERS FROM THE STOCK. A stocked message starts a turn by itself
// wherever "stocked messages" is ticked on the Behaviour tab. A QUIET item
// never does, ticked or not. It waits in the same stock (so it is listed,
// editable and removable there, and keeps the time it was written), and is
// delivered with whatever starts the next turn: a person's send, "run it
// now", a wake, or an ordinary stocked message.
//
// The flag sits on the ITEM (`quiet: true`), not in its payload: the payload
// is rewritten by an edit and replaced by nothing else, and the item-level
// fields (`host`, `uiLang`, `returned`) are the ones every mover preserves.
//
// ⚠ CORRECTED THE SAME DAY (lib/quietLeave.ts). "Waits in the stock" was not
// what he asked for: he pressed it and found his message in the stock. A quiet
// item is now written straight into the conversation log (no model call), and
// it waits here ONLY while that is impossible — a turn has the log, something
// that is not quiet is ahead of it, or a soul update is running. Everything
// above still describes those waiting cases, and the rule below still governs
// them.
//
// ONE rule, asked from two places — the runner's `auto` pass and the tab's
// own auto-start effect — so the two cannot disagree: when everything waiting
// is quiet, nothing starts by itself.

export interface MaybeQuiet { kind?: unknown; quiet?: unknown }

export function isQuietItem(it: MaybeQuiet): boolean {
  return it.kind === 'user_message' && it.quiet === true;
}

/**
 * True when there IS something waiting and every bit of it is quiet.
 *
 * An empty list is false on purpose: "nothing waiting" is a different answer
 * with its own handling everywhere this is asked, and folding it in here would
 * make a caller that forgot the emptiness check skip a pass for no reason it
 * could report.
 */
export function onlyQuietWaiting(items: MaybeQuiet[]): boolean {
  return items.length > 0 && items.every(isQuietItem);
}
