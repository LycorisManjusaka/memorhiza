// The anchor's thinking and output, streamed to the tabs WHILE it runs.
//
// つよ, 2026-11-19: a REWRITE turn left the busy line saying "錨が<器>で
// 確かめています" for minutes (judge + writer, the writer 17-123 s on its
// own), with nothing to show it was alive — "壊れてないかな". The being's own
// reply streams; the anchor's now does too.
//
// Relay-only, like `turn_plan` and `anchor_reset`: nothing here is saved. The
// saved `anchorReport` (judge) and `anchorRewrite` record land with the turn's
// single save, and that is what a reload shows.
//
// DELTAS, not snapshots: the relay keeps a replay buffer (lib/turnBus.ts), so a
// tab that opens mid-run gets every delta and rebuilds the same text. A
// snapshot per tick would put the whole text into the buffer again each time.

export type AnchorLiveStage = 'judge' | 'rewrite';

export interface AnchorLiveFrame {
  type: 'anchor_live';
  assistantId: string;
  stage: AnchorLiveStage;
  model: string;
  /** First frame of a call: the tab drops what it had for this stage. */
  start?: true;
  thought?: string;
  text?: string;
}

export interface AnchorLiveDelta { thought?: string; text?: string }

/** One stage's view on a tab. */
export interface AnchorLiveStageView { model: string; thought: string; text: string }

export interface AnchorLiveView {
  assistantId: string;
  judge?: AnchorLiveStageView;
  rewrite?: AnchorLiveStageView;
}

/**
 * Coalesces the drain's tiny deltas into a frame at most every `intervalMs`.
 * No timer: the drain pushes often, and `end()` flushes the tail.
 */
export function createAnchorLiveEmitter(a: {
  assistantId: string;
  stage: AnchorLiveStage;
  model: string;
  emit: (frame: AnchorLiveFrame) => void;
  now: () => number;
  intervalMs?: number;
}): { push: (d: AnchorLiveDelta) => void; end: () => void } {
  const interval = a.intervalMs ?? 250;
  let thought = '';
  let text = '';
  let last = a.now();
  const base = { type: 'anchor_live' as const, assistantId: a.assistantId, stage: a.stage, model: a.model };
  a.emit({ ...base, start: true });
  const flush = () => {
    if (!thought && !text) return;
    a.emit({ ...base, ...(thought ? { thought } : {}), ...(text ? { text } : {}) });
    thought = '';
    text = '';
    last = a.now();
  };
  return {
    push(d) {
      if (d.thought) thought += d.thought;
      if (d.text) text += d.text;
      if (a.now() - last >= interval) flush();
    },
    end: flush,
  };
}

/** A relay payload → a frame, or null when it is not a usable one. */
export function normaliseAnchorLive(d: Record<string, unknown>): AnchorLiveFrame | null {
  if (d.type !== 'anchor_live') return null;
  if (typeof d.assistantId !== 'string' || !d.assistantId) return null;
  if (d.stage !== 'judge' && d.stage !== 'rewrite') return null;
  return {
    type: 'anchor_live',
    assistantId: d.assistantId,
    stage: d.stage,
    model: typeof d.model === 'string' ? d.model : '',
    ...(d.start === true ? { start: true as const } : {}),
    ...(typeof d.thought === 'string' && d.thought ? { thought: d.thought } : {}),
    ...(typeof d.text === 'string' && d.text ? { text: d.text } : {}),
  };
}

/** Fold one frame into the tab's view. Pure. */
export function applyAnchorLive(view: AnchorLiveView | null, f: AnchorLiveFrame): AnchorLiveView {
  // A different reply: start over (a new turn's anchor).
  const v: AnchorLiveView = view && view.assistantId === f.assistantId ? { ...view } : { assistantId: f.assistantId };
  const prev = f.start ? undefined : v[f.stage];
  const cur: AnchorLiveStageView = prev ? { ...prev } : { model: f.model, thought: '', text: '' };
  if (f.start) {
    cur.model = f.model;
    // A fresh judge call (the one re-ask after an unreadable verdict) also
    // makes any writer view stale.
    if (f.stage === 'judge') delete v.rewrite;
  }
  if (f.thought) cur.thought += f.thought;
  if (f.text) cur.text += f.text;
  v[f.stage] = cur;
  return v;
}
