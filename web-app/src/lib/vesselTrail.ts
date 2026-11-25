// ── Who changed the vessel on disk? ────────────────────────────────────────
//
// REPORTED 2026-11-25 (Навигатор for Пилот), twice in one evening: the
// settings said Fable, the turn ran on the OpenCode Go Argon — a vessel that
// had been replaced TWO changes earlier (Argon -> Sonnet -> Fable). The turn
// after it ran on Fable again. The runner reads the vessel from disk at every
// turn, so somebody wrote the old pair back between two turns and somebody
// wrote the new pair again afterwards.
//
// One road was closed the same day by reading the code (autoSaveSkip.ts,
// `diskSettingsMovedSince`): a second tab holding old settings. Their second
// report does not fit it well — the only other device's tab was closed. The
// runner was read too and writes back what it loaded, or what is on disk after
// a rebase; it holds no older copy. So the writer is NOT KNOWN, and the file
// that held the evidence had been overwritten by the time anyone looked.
//
// This module is the instrument for the next occurrence, not a fix. Every
// successful save that changes a conversation's (family, model) pair leaves
// one line: when, which conversation, from what to what, WHICH WRITER (the
// clientId every tab and the runner already send), and the version it built
// on. No message text, no settings beyond the pair.
//
// Memory decides "changed": the pair each conversation was last written with
// in this process. After a restart the first save has nothing to compare with
// and is not reported — the same "unknown is silent" rule as lastWriter.ts. A
// change made while the server was down is therefore invisible here; the
// trail says what this process saw written, nothing more.
// ───────────────────────────────────────────────────────────────────────────

export type VesselPair = { family: string; model: string };

/** The pair a log object would run on, as written — no defaults applied. */
export function vesselPairOf(log: Record<string, unknown> | null | undefined): VesselPair {
  return {
    family: typeof log?.aiName === 'string' ? log.aiName : '',
    model: typeof log?.specificModel === 'string' ? log.specificModel : '',
  };
}

export function sameVessel(a: VesselPair, b: VesselPair): boolean {
  return a.family === b.family && a.model === b.model;
}

export type VesselWrite = {
  at: number;
  convoId: string;
  being: string;
  clientId?: unknown;
  /** The version the writer said it built on, when it said so. */
  base?: number;
  /** The version this write put on disk. */
  written?: number;
};

/** One trail line. Tab-separated so it can be read with any tool. */
export function formatVesselChange(prev: VesselPair, next: VesselPair, w: VesselWrite): string {
  const show = (p: VesselPair) => `${p.family || '(none)'}/${p.model || '(none)'}`;
  const who = typeof w.clientId === 'string' && w.clientId ? w.clientId : 'unknown';
  return [
    new Date(w.at).toISOString(),
    w.being,
    w.convoId,
    `${show(prev)} -> ${show(next)}`,
    `by ${who}`,
    `base ${typeof w.base === 'number' ? w.base : '-'}`,
    `wrote ${typeof w.written === 'number' ? w.written : '-'}`,
  ].join('\t');
}

const MAX_CONVOS = 256;
const g = globalThis as unknown as { __nexusVesselTrail?: Map<string, VesselPair> };
// globalThis, like turnBus: the dev server hands each route its own module
// instance, and a per-instance map would report every save as "first seen".
const lastWritten: Map<string, VesselPair> = (g.__nexusVesselTrail ??= new Map());

/**
 * Record a successful write. Returns the line to append when the pair
 * changed since this process last wrote the conversation, otherwise null.
 */
export function noteVesselWrite(log: Record<string, unknown>, w: VesselWrite): string | null {
  const next = vesselPairOf(log);
  const prev = lastWritten.get(w.convoId);
  lastWritten.delete(w.convoId);
  lastWritten.set(w.convoId, next);
  if (lastWritten.size > MAX_CONVOS) {
    const oldest = lastWritten.keys().next().value;
    if (oldest !== undefined) lastWritten.delete(oldest);
  }
  if (!prev || sameVessel(prev, next)) return null;
  return formatVesselChange(prev, next, w);
}

/** Test seam. */
export function _resetVesselTrail(): void {
  lastWritten.clear();
}
