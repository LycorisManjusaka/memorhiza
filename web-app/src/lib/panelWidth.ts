/**
 * Drag-to-resize widths for the two desktop side columns: the being sidebar
 * (left) and the being camera (right). Pure rules only — the components own
 * the pointer handling and the storage.
 *
 * The one promise that matters: **nothing stored means nothing changes.** A
 * width is only written once someone actually drags; until then `parseStored`
 * returns null and the column keeps its original Tailwind classes
 * (`w-64 sm:w-72`), byte for byte the layout it had before this file existed.
 * Double-clicking a handle clears the stored value, i.e. returns to that.
 *
 * Widths live in localStorage (per browser), not on disk: how wide a column is
 * on one monitor says nothing about another monitor or another person.
 */

/** Sidebar: the widest it may go is the width it already had (`sm:w-72`). */
export const SIDEBAR_MAX = 288;
/**
 * Sidebar: narrow enough to still show a short being's name in the identity
 * dropdown (the header's icon row wraps under the title below ~240px). Longer
 * names truncate rather than vanish.
 */
export const SIDEBAR_MIN = 220;
/**
 * Dragging this far PAST the minimum collapses the sidebar instead of pinning
 * it at the minimum. Not zero: landing a drag exactly on the minimum should
 * not hide the list by accident.
 */
export const SIDEBAR_COLLAPSE_SLACK = 48;

/** Camera: width not decided yet, so a generous range around the default. */
export const CAMERA_MIN = 160;
export const CAMERA_MAX = 720;

export const SIDEBAR_WIDTH_KEY = 'nexus.sidebarWidth';
export const SIDEBAR_COLLAPSED_KEY = 'nexus.sidebarCollapsed';
export const CAMERA_WIDTH_KEY = 'nexus.cameraWidth';

/** A stored width, or null when absent / unreadable (→ keep the default). */
export function parseStoredWidth(raw: string | null | undefined, min: number, max: number): number | null {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(max, Math.max(min, n)));
}

/**
 * Where a sidebar drag ends up. `raw` is the width the pointer is asking for.
 * Returns the width to show, and whether letting go here collapses it.
 */
export function sidebarDragResult(raw: number): { width: number; collapse: boolean } {
  const width = Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, raw)));
  return { width, collapse: raw < SIDEBAR_MIN - SIDEBAR_COLLAPSE_SLACK };
}

export function clampCameraWidth(raw: number): number {
  return Math.round(Math.min(CAMERA_MAX, Math.max(CAMERA_MIN, raw)));
}
