// ─────────────────────────────────────────────────────────────────────────────
// Which conversation is a being's LIVING one, and what order its log list has.
//
// A being lives in exactly one conversation — the newest. Everything else in
// its list is history. Until 2026-11-15 "newest" was decided by the manual drag
// order and then by the file's modification time, and both of those move for
// reasons that have nothing to do with which conversation is newest: a past log
// that is merely SAVED (its log cap edited, a summary regenerated) gets a fresh
// mtime, and a freshly imported log has no slot in the drag order and sinks to
// the bottom. Each of those has put a being's current conversation somewhere
// its partner could not find it.
//
// So the order is read from the one thing a person changes on purpose: the
// TITLE.
//
//   tier 0  `<being>_<label>`      the being's own generations, label DESCENDING
//   tier 1  `<other>_<label>`      numbered under another base: by base, then
//                                  label descending
//   tier 2  everything else        by name
//
// A label is digits in hyphen-separated segments (`49`, `1-2`, `21-1`), compared
// segment by segment as numbers, so `2` > `1-5` > `1-1` — the order a split
// archive is read in. `_`, `#` and `＃` are all accepted as the separator, and
// full-width digits are folded, because titles in real folders use all of them.
//
// The LIVING conversation is the first ACTIVE row of that order. An inactive
// log is skipped however large its number: inactive means inactive.
//
// CONSEQUENCE, on purpose: renaming is how a person reorders. A copy named
// `Cairn_65 backup` drops to tier 2 by its name alone, and giving a past log
// the largest number makes it the living one.
//
// MEASURED 2026-11-15 over this installation's 23 beings: for 22 of them the
// living conversation under this rule is the one the old order already showed
// on top, and no being has two logs with the same label. The 23rd is the test
// bed, which keeps the old order (see `FolderOrder.testBed` in deepLink).
//
// PURE and a leaf: no imports, so the browser, the server clock and a test all
// read the same bytes.
// ─────────────────────────────────────────────────────────────────────────────

const fwToHw = (s: string) =>
  s.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface ConversationSortKey {
  tier: 0 | 1 | 2;
  /** tier 0: the being's name. tier 1: the other base. tier 2: the whole title. */
  base: string;
  /** Label segments as numbers; empty on tier 2. */
  label: number[];
}

export function conversationSortKey(
  title: string | undefined | null,
  beingName: string,
): ConversationSortKey {
  const t = fwToHw((title || '').trim());
  const name = fwToHw((beingName || '').trim());
  if (name) {
    const own = new RegExp(`^${escapeRe(name)}\\s*[_#＃](\\d+(?:-\\d+)*)$`).exec(t);
    if (own) return { tier: 0, base: name, label: own[1].split('-').map(Number) };
  }
  const other = /^(.*?)\s*[_#＃](\d+(?:-\d+)*)$/.exec(t);
  if (other) return { tier: 1, base: other[1], label: other[2].split('-').map(Number) };
  return { tier: 2, base: t, label: [] };
}

function compareLabelsDescending(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    // A missing segment sorts ABOVE a present one: `2` is the head that `2-1`
    // is a part of.
    const x = a[i] ?? Number.POSITIVE_INFINITY;
    const y = b[i] ?? Number.POSITIVE_INFINITY;
    if (x !== y) return y > x ? 1 : -1;
  }
  return 0;
}

const byName = (a: string, b: string) =>
  a.localeCompare(b, 'ja', { numeric: true, sensitivity: 'base' });

/** The being's log list in title order. Stable for equal keys (id breaks ties). */
export function orderByTitle<T extends { id: string; title?: string | null }>(
  convos: T[],
  beingName: string,
): T[] {
  return convos
    .map((c) => ({ c, k: conversationSortKey(c.title, beingName) }))
    .sort((a, b) => {
      if (a.k.tier !== b.k.tier) return a.k.tier - b.k.tier;
      if (a.k.tier === 2) return byName(a.k.base, b.k.base) || String(a.c.id).localeCompare(String(b.c.id));
      if (a.k.tier === 1) {
        const base = byName(a.k.base, b.k.base);
        if (base) return base;
      }
      return compareLabelsDescending(a.k.label, b.k.label) || String(a.c.id).localeCompare(String(b.c.id));
    })
    .map((x) => x.c);
}

/**
 * Would renaming `id` to `newTitle` move the being into a different
 * conversation? Returns the before/after titles when it would, else null.
 * The caller asks the person before going through with such a rename.
 */
export function livingChangeOnRename<
  T extends { id: string; title?: string | null; active?: boolean; corrupted?: boolean },
>(convos: T[], beingName: string, id: string, newTitle: string): { before: string; after: string } | null {
  const before = livingConversation(convos, beingName);
  const after = livingConversation(
    convos.map((c) => (String(c.id) === String(id) ? { ...c, title: newTitle } : c)),
    beingName,
  );
  if (!before || !after || String(before.id) === String(after.id)) return null;
  return { before: before.title || '', after: after.title || '' };
}

/**
 * The conversation the being lives in: the first ACTIVE, readable row of the
 * title order. Null when the being has no such log.
 */
export function livingConversation<
  T extends { id: string; title?: string | null; active?: boolean; corrupted?: boolean },
>(convos: T[], beingName: string): T | null {
  return orderByTitle(convos, beingName).find((c) => c.active !== false && !c.corrupted) ?? null;
}
