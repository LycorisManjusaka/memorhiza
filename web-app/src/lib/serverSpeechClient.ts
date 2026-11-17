/**
 * The tab's end of server-side read-aloud (lib/serverSpeech.ts).
 *
 * The tab does not play anything in server mode. It learns two things from the
 * server — which mode the house is in, and which phrase of which message is
 * sounding — and offers the same three buttons, which become requests.
 *
 * The MODE comes from the server, not from this browser's localStorage: it is
 * a property of the installation (there is one loudspeaker), and a phone that
 * never opened Preferences must still stay silent when the server is reading.
 *
 * The stream is open only while mode === 'server' and the tab is visible; see
 * the route for why (the per-host connection limit is shared across tabs).
 */
import { useSyncExternalStore } from 'react';

export interface ClientSpeechCurrent {
  messageId: string;
  convoId: string;
  isUser: boolean;
  index: number;
  total: number;
  text: string;
  paused: boolean;
  failed: number;
  lastError: string;
}
export interface ClientSpeechSnapshot { mode: 'tab' | 'server'; current: ClientSpeechCurrent | null; queued: number }

let snap: ClientSpeechSnapshot = { mode: 'tab', current: null, queued: 0 };
const listeners = new Set<() => void>();
let es: EventSource | null = null;
let started = false;

function setSnap(next: ClientSpeechSnapshot): void {
  snap = next;
  for (const fn of [...listeners]) { try { fn(); } catch { /* one bubble must not break the rest */ } }
  manageStream();
}

function manageStream(): void {
  if (typeof window === 'undefined') return;
  const want = snap.mode === 'server' && document.visibilityState === 'visible';
  if (want && !es) {
    const src = new EventSource('/api/tts/server?stream=1');
    es = src;
    src.onmessage = (ev) => {
      try { setSnap(JSON.parse(ev.data) as ClientSpeechSnapshot); } catch { /* a torn frame */ }
    };
    // EventSource reconnects by itself; nothing to do but keep the last state.
  } else if (!want && es) {
    es.close();
    es = null;
    // A hidden tab stops tracking; do not leave a phrase painted as sounding.
    if (snap.current) setSnap({ ...snap, current: null });
  }
}

/** Ask the server once (mode + what is sounding). Safe to call often. */
export async function refreshServerSpeech(): Promise<void> {
  try {
    const r = await fetch('/api/tts/server', { cache: 'no-store' });
    if (r.ok) setSnap((await r.json()) as ClientSpeechSnapshot);
  } catch { /* offline: keep the last known mode */ }
}

function start(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  void refreshServerSpeech();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshServerSpeech();
    else manageStream();
  });
}

export function subscribeServerSpeech(fn: () => void): () => void {
  start();
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function serverSpeechSnapshot(): ClientSpeechSnapshot { return snap; }
export function serverSpeechMode(): 'tab' | 'server' { return snap.mode; }

/**
 * What the server is doing with ONE message, as a string a bubble can compare:
 * '' when it is not the message sounding, else JSON of the fields it paints.
 * A string so `useSyncExternalStore` re-renders only the bubble concerned.
 */
export function serverSpeechKeyFor(messageId: string): string {
  const c = snap.current;
  if (snap.mode !== 'server' || !c || c.messageId !== messageId) return '';
  return JSON.stringify({ i: c.index, n: c.total, t: c.text, p: c.paused, u: c.isUser });
}

export async function serverSpeechAction(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch('/api/tts/server', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => null);
    if (r.ok && d && d.mode) setSnap(d as ClientSpeechSnapshot);
    return r.ok ? { ok: true } : { ok: false, error: String(d?.error || `HTTP ${r.status}`) };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

/** 'tab' | 'server', live. Server render and first paint say 'tab'. */
export function useServerSpeechMode(): 'tab' | 'server' {
  return useSyncExternalStore(subscribeServerSpeech, serverSpeechMode, () => 'tab' as const);
}

/** serverSpeechKeyFor(messageId), live — changes only for the message concerned. */
export function useServerSpeechKey(messageId: string): string {
  return useSyncExternalStore(subscribeServerSpeech, () => serverSpeechKeyFor(messageId), () => '');
}

/**
 * Change the house setting. PATCHes the file directly rather than riding the
 * localStorage mirror: the mirror only sends on a change in THIS browser's
 * copy, so a browser whose stale copy already said 'server' could never switch
 * the house back to it after another device chose 'tab'.
 */
export async function setServerSpeechMode(mode: 'tab' | 'server'): Promise<boolean> {
  try {
    const r = await fetch('/api/user', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ttsPlayback: mode }),
    });
    await refreshServerSpeech();
    return r.ok;
  } catch {
    return false;
  }
}
