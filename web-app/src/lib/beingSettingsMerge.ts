// How a write to beings/<name>/settings.json is combined with what is on disk.
//
// Until 2026-11-15 every write REPLACED the file with whatever the browser tab
// sent, and every tab sent "the whole settings object I remember, plus the one
// key I am changing". A tab's memory is only as fresh as its last fetch, so:
//
//   - a key the tab never saw (set from another tab or device after its last
//     fetch) was deleted by an unrelated write such as reordering the sidebar;
//   - a tab whose copy was empty — the folder list not loaded yet, or a read
//     that failed and was reported as `{}` — erased everything but its one key.
//
// Reported from another install as "the being's voice setting vanished from
// settings.json without anyone touching it" (aiVoice absent → the UI fell back
// to engine 0). The same shape had already rolled a being's default model back
// the day before. Neither could be reproduced on the development machine,
// which runs one tab per being.
//
// The rule now: the DISK is the base, always. A write names the keys it means
// to change and nothing else can be lost by it.
//
//   patch   — only these keys are set. What the current client sends.
//   settings (legacy) — a whole object from a tab still running older code.
//             It is laid OVER the disk instead of replacing it: its stale
//             values still win for the keys it carries (that cannot be told
//             apart from an intentional change), but it can no longer delete
//             a key merely by not knowing about it.
//   remove  — keys to delete on purpose. Deletion is never inferred from
//             absence.

export interface BeingSettingsWrite {
  patch?: Record<string, any> | null;
  settings?: Record<string, any> | null;
  remove?: string[] | null;
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Pure. Returns the object to write. `disk` is the settings object currently
 * in the file (`{}` for a being with no file yet).
 */
export function mergeBeingSettings(
  disk: Record<string, any> | null | undefined,
  write: BeingSettingsWrite,
): Record<string, any> {
  const base = isPlainObject(disk) ? disk : {};
  const incoming = isPlainObject(write.patch)
    ? write.patch
    : isPlainObject(write.settings) ? write.settings : {};
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(incoming)) {
    // `undefined` never survives JSON, but a caller inside the process could
    // pass one; it means "not saying anything about this key".
    if (v === undefined) continue;
    out[k] = v;
  }
  if (Array.isArray(write.remove)) {
    for (const k of write.remove) {
      if (typeof k === 'string') delete out[k];
    }
  }
  return out;
}

/** Whether this write says anything about the theme CSS (stored in its own file). */
export function writeTouchesCustomCss(write: BeingSettingsWrite): boolean {
  if (isPlainObject(write.patch)) return 'customCss' in write.patch;
  if (isPlainObject(write.settings)) return 'customCss' in write.settings;
  return false;
}
