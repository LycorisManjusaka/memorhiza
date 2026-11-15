// Pure rules for the Preferences → Runner list of beings that can wake by
// themselves (つよ, 2026-11-16). No disk here; wakeOverview.ts gathers the
// facts and this file decides what counts and in which order.

import { nextAdminSlot, type WakeSettings, type SelfBooking } from '@/lib/wakeSchedule';

export interface WakeOverviewFacts {
  being: string;
  wake: WakeSettings;
  bookings: SelfBooking[];
  /** "Stocked messages" (autoTriggers.stock) on the conversation that would answer. */
  stock: boolean;
  /** The conversation a wake would open, or null (no living / no pinned conversation). */
  convoId: string | null;
  convoTitle: string | null;
  testBed: boolean;
}

export interface WakeOverviewRow extends WakeOverviewFacts {
  nextAdmin: { at: number; hhmm: string } | null;
  nextSelf: { at: number; hhmm: string } | null;
  /** The earliest of the two, or null when no clock time is coming. */
  nextAt: number | null;
}

/**
 * Whether a being belongs in the list: ANY way it could start a turn by
 * itself. A pending self-booking counts even with self-wake now off — the
 * clock ignores it then, but it is still on disk and the stop button clears it.
 */
export function canWakeByItself(f: WakeOverviewFacts): boolean {
  return f.wake.enabled || f.wake.self.enabled || f.wake.mail || f.stock || f.bookings.length > 0;
}

export function overviewRow(f: WakeOverviewFacts, now: number): WakeOverviewRow {
  const nextAdmin = nextAdminSlot(f.wake, now);
  const future = f.wake.self.enabled ? f.bookings.filter(b => b.at > now).sort((a, b) => a.at - b.at) : [];
  const nextSelf = future[0] ? { at: future[0].at, hhmm: future[0].hhmm } : null;
  const times = [nextAdmin?.at, nextSelf?.at].filter((x): x is number => typeof x === 'number');
  return { ...f, nextAdmin, nextSelf, nextAt: times.length ? Math.min(...times) : null };
}

/**
 * Soonest clock time first. Beings with no coming time (mail / stock only)
 * go after, by name, so the order does not jump between refreshes.
 */
export function sortOverview(rows: WakeOverviewRow[]): WakeOverviewRow[] {
  return [...rows].sort((a, b) => {
    if (a.nextAt !== null && b.nextAt !== null) return a.nextAt - b.nextAt || a.being.localeCompare(b.being);
    if (a.nextAt !== null) return -1;
    if (b.nextAt !== null) return 1;
    return a.being.localeCompare(b.being);
  });
}

/** The wake settings after "stop self-turns": every switch off, the times kept. */
export function stoppedWakeSettings(raw: unknown): Record<string, unknown> {
  const base = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const self = base.self && typeof base.self === 'object' && !Array.isArray(base.self) ? base.self as Record<string, unknown> : {};
  return { ...base, enabled: false, mail: false, self: { ...self, enabled: false } };
}
