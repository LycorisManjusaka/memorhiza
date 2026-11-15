// The wake clock — the one thing in NEXUS that starts a turn with NOBODY's
// screen behind it. Rules live in wakeSchedule.ts; this file is the plumbing.
//
// ── WHICH NEXUS RUNS THE CLOCK (つよ, 2026-11-15: "いっちゃんやばいの") ─────
//
// 3000 and 3001 are two installations of the same code sharing ONE local_data
// by junction. A clock that ran wherever the code ran would wake every being
// twice. Two independent guards, either of which is enough on its own:
//
//   1. `wake/clock.json` names exactly ONE installation (by tree realpath,
//      the same identity runnerHost.ts uses). It is one file in the shared
//      store, so it cannot name two. Absent = no clock anywhere — the shipped
//      default, like runner.json. A person names it from the screen.
//   2. Every slot is claimed with a create-only file
//      (`wake/fired/<being>/<YYYY-MM-DD_HHMM_src>.json`, flag 'wx'). Even if
//      two installations somehow both believed they ran the clock, the OS
//      lets exactly one create the file, and only that one enqueues.
//
// ζ is untouched: it is a button, its item is addressed to the installation
// it was pressed on, and it never goes through this clock.
//
// The enqueued item is addressed (`host`) to this installation, so the runner
// here — not the other clone — answers it.

import fs from 'fs/promises';
import path from 'path';
import { DATA_DIR } from '@/lib/beingPaths';
import { atomicWriteFile } from '@/lib/atomicWrite';
import { installationId, normaliseInstallPath } from '@/lib/runnerHost';
import { enqueue, pending } from '@/lib/turnQueue';
import { listFolders, listLogs, loadLog, loadUserSettings } from '@/lib/fsStorage';
import { readAllAgentFiles, extractAgentSystemPrompt } from '@/lib/systemPromptStorage';
import { beingIsBlockedHere } from '@/lib/blockedBeings';
import { conversationToolsEnabled } from '@/lib/agentCapabilities';
import {
  parseWakeSettings, dueAdminSlots, dueSelfSlots, pruneBookings, validateBooking, parseWakeupDirective,
  wakeShortText, buildCapabilityList, buildSelfWakeLine, describeRejection, fillWakeTemplate,
  FALLBACK_WAKE_TEMPLATE, WAKE_PURPOSE, wakeLang, localDateKey,
  type SelfBooking, type WakeRejectReason, type DueSlot, type WakeLang, type WakeSettings,
} from '@/lib/wakeSchedule';

export const WAKE_DIR = 'wake';
export const CLOCK_FILE = 'clock.json';
const WAKE_TEMPLATE_FILE = 'wake.md';
const TICK_MS = 30_000;
const HISTORY_MAX = 30;

function wakeDir(dataDir = DATA_DIR) { return path.join(dataDir, WAKE_DIR); }
function safeName(being: string) { return being.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_'); }

// ── Clock host ──────────────────────────────────────────────────────────────

export interface ClockHostRecord { host: string; setAt?: string }

export async function readClockHost(dataDir = DATA_DIR): Promise<ClockHostRecord | null> {
  try {
    const raw = await fs.readFile(path.join(wakeDir(dataDir), CLOCK_FILE), 'utf-8');
    const p = JSON.parse(raw);
    return p && typeof p.host === 'string' && p.host.trim() ? { host: p.host, setAt: p.setAt } : null;
  } catch { return null; }
}

export async function setClockHost(hostId: string, dataDir = DATA_DIR): Promise<ClockHostRecord> {
  const rec = { host: normaliseInstallPath(hostId), setAt: new Date().toISOString() };
  await fs.mkdir(wakeDir(dataDir), { recursive: true });
  await atomicWriteFile(path.join(wakeDir(dataDir), CLOCK_FILE), JSON.stringify(rec, null, 2));
  return rec;
}

export async function clearClockHost(dataDir = DATA_DIR): Promise<boolean> {
  try { await fs.unlink(path.join(wakeDir(dataDir), CLOCK_FILE)); return true; }
  catch (e: any) { if (e?.code === 'ENOENT') return false; throw e; }
}

export async function thisInstallationRunsClock(selfId: string, dataDir = DATA_DIR): Promise<boolean> {
  const rec = await readClockHost(dataDir);
  return !!rec && normaliseInstallPath(rec.host) === normaliseInstallPath(selfId);
}

// ── Per-being state ─────────────────────────────────────────────────────────

export interface WakeEvent {
  at: number;
  kind: 'fired' | 'booked' | 'rejected' | 'no-conversation' | 'error';
  hhmm?: string;
  source?: 'admin' | 'self';
  convoId?: string;
  reason?: WakeRejectReason | string;
  detail?: string;
}

export interface WakeState {
  bookings: SelfBooking[];
  /** A rejection not yet told to the being. Cleared when the next wake says it. */
  rejection?: { hhmm: string; reason: WakeRejectReason; detail?: string; at: number };
  history: WakeEvent[];
}

function statePath(being: string, dataDir = DATA_DIR) { return path.join(wakeDir(dataDir), `${safeName(being)}.json`); }

export async function readWakeState(being: string, dataDir = DATA_DIR): Promise<WakeState> {
  try {
    const p = JSON.parse(await fs.readFile(statePath(being, dataDir), 'utf-8'));
    return {
      bookings: Array.isArray(p.bookings) ? p.bookings.filter((b: any) => typeof b?.at === 'number' && typeof b?.hhmm === 'string') : [],
      rejection: p.rejection && typeof p.rejection.hhmm === 'string' ? p.rejection : undefined,
      history: Array.isArray(p.history) ? p.history : [],
    };
  } catch { return { bookings: [], history: [] }; }
}

async function writeWakeState(being: string, s: WakeState, dataDir = DATA_DIR) {
  await fs.mkdir(wakeDir(dataDir), { recursive: true });
  const trimmed = { ...s, history: s.history.slice(-HISTORY_MAX) };
  await atomicWriteFile(statePath(being, dataDir), JSON.stringify(trimmed, null, 2));
}

/** One writer per being at a time inside this process. */
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(being: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(being) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(being, next.catch(() => {}));
  return next;
}

// ── Self-booking: called by the runner after every finished turn ────────────

/**
 * Read the being's last reply for `[->wakeup: HH:MM]` and book or reject it.
 * Never throws — a booking problem must not fail a finished turn.
 */
export async function recordSelfWakeFromReply(being: string, replyText: string, beingSettings: Record<string, unknown>, now = Date.now(), dataDir = DATA_DIR): Promise<void> {
  try {
    const directive = parseWakeupDirective(replyText);
    if (!directive) return;
    const w = parseWakeSettings(beingSettings?.wake);
    await withLock(being, async () => {
      const s = await readWakeState(being, dataDir);
      s.bookings = pruneBookings(s.bookings, now);
      const r = validateBooking(w, directive, now, s.bookings);
      if (r.ok) {
        s.bookings.push(r.booking);
        s.history.push({ at: now, kind: 'booked', hhmm: r.booking.hhmm, source: 'self' });
      } else {
        s.rejection = { hhmm: r.hhmm, reason: r.reason, detail: r.detail, at: now };
        s.history.push({ at: now, kind: 'rejected', hhmm: r.hhmm, reason: r.reason, detail: r.detail });
      }
      await writeWakeState(being, s, dataDir);
    });
  } catch (e) {
    console.warn(`[wake] self-booking for ${being} failed:`, e);
  }
}

// ── Firing ──────────────────────────────────────────────────────────────────

export async function claimSlot(being: string, key: string, dataDir = DATA_DIR): Promise<boolean> {
  const dir = path.join(wakeDir(dataDir), 'fired', safeName(being));
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(path.join(dir, `${key}.json`), JSON.stringify({ at: new Date().toISOString(), by: await installationId() }), { flag: 'wx' });
    return true;
  } catch (e: any) {
    if (e?.code === 'EEXIST') return false;
    throw e;
  }
}

/** The being's newest ACTIVE conversation, by the same order the sidebar uses. */
export async function latestActiveConversation(being: string): Promise<string | null> {
  const logs = await listLogs();
  const hit = (logs as Array<{ id: string; folderName: string; active?: boolean; corrupted?: boolean }>)
    .find(l => l.folderName === being && l.active !== false && !l.corrupted);
  return hit?.id ?? null;
}

async function readTemplate(lang: WakeLang): Promise<string> {
  try {
    const agents = await readAllAgentFiles(lang);
    const t = extractAgentSystemPrompt(agents.find(a => a.name === WAKE_TEMPLATE_FILE)?.content || '');
    if (t.includes('{SHORT}')) return t;
  } catch {}
  return FALLBACK_WAKE_TEMPLATE[lang];
}

function capabilitiesFromLog(log: Record<string, unknown>) {
  const b = (k: string) => log[k] === true;
  return {
    toolUseEnabled: b('toolUseEnabled'),
    agentFullSystemAccess: b('agentFullSystemAccess'),
    agentDangerousTools: b('agentDangerousTools'),
    conversationTools: conversationToolsEnabled(log as any),
    lettersEnabled: b('lettersEnabled'),
    webSearch: b('enableWebSearch') || b('enableClaudeWebSearch'),
    browserEnabled: b('browserEnabled'),
    computerControlEnabled: b('computerControlEnabled'),
    appControlEnabled: b('appControlEnabled'),
    subagentEnabled: b('subagentEnabled'),
    modelHandoffEnabled: b('modelHandoffEnabled'),
  };
}

function remainingToday(w: WakeSettings, bookings: SelfBooking[], now: number): number {
  const key = localDateKey(new Date(now));
  return Math.max(0, w.self.maxPerDay - bookings.filter(b => localDateKey(new Date(b.at)) === key).length);
}

async function fireSlot(being: string, w: WakeSettings, slot: DueSlot, selfId: string, lang: WakeLang, now: number): Promise<string | null> {
  return withLock(being, async () => {
    if (!(await claimSlot(being, slot.key))) return null;   // another process already fired it
    const s = await readWakeState(being);
    if (slot.source === 'self') s.bookings = s.bookings.filter(b => b.at !== slot.at);
    s.bookings = pruneBookings(s.bookings, now);

    const convoId = await latestActiveConversation(being);
    if (!convoId) {
      s.history.push({ at: now, kind: 'no-conversation', hhmm: slot.hhmm, source: slot.source });
      await writeWakeState(being, s);
      return null;
    }
    const log = ((await loadLog(convoId)) || {}) as Record<string, unknown>;
    const short = wakeShortText(lang, slot);
    const full = fillWakeTemplate(await readTemplate(lang), {
      short,
      capabilities: buildCapabilityList(lang, capabilitiesFromLog(log)),
      selfWake: buildSelfWakeLine(lang, w, remainingToday(w, s.bookings, now)),
      previous: s.rejection ? describeRejection(lang, s.rejection) : '',
    });
    await enqueue(being, convoId, {
      kind: 'system',
      from: 'NEXUS',
      payload: { text: short, attachments: [], fullText: full, purpose: WAKE_PURPOSE },
      host: selfId,
      uiLang: lang,
    });
    s.rejection = undefined;
    s.history.push({ at: now, kind: 'fired', hhmm: slot.hhmm, source: slot.source, convoId });
    await writeWakeState(being, s);
    return convoId;
  });
}

// ── Running the queued wake ─────────────────────────────────────────────────

const inFlight = new Set<string>();

async function kick(being: string, convoId: string) {
  const key = `${being}\u0000${convoId}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    // Same-process call, the same bargain spu-run makes. NOT `detach`: that
    // flag means "a tab is behind this" and lets the tick claim runner.json.
    const { POST } = await import('@/app/api/runner/tick/route');
    const origin = `http://127.0.0.1:${process.env.PORT || 3000}`;
    await POST(new Request(`${origin}/api/runner/tick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ being, convoId }),
    }));
  } catch (e) {
    console.warn(`[wake] tick for ${being}/${convoId} failed:`, e);
  } finally {
    inFlight.delete(key);
  }
}

/** Wake items still waiting (the being was busy). Re-kicked every cycle until they run. */
async function waitingWakeConversations(being: string, selfId: string): Promise<string[]> {
  const out: string[] = [];
  const logs = await listLogs();
  for (const l of logs as Array<{ id: string; folderName: string }>) {
    if (l.folderName !== being) continue;
    let items;
    try { items = await pending(being, l.id); } catch { continue; }
    if (items.some(it => it.kind === 'system'
      && (it.payload as { purpose?: unknown })?.purpose === WAKE_PURPOSE
      && normaliseInstallPath(it.host || '') === normaliseInstallPath(selfId))) out.push(l.id);
  }
  return out;
}

// ── The loop ────────────────────────────────────────────────────────────────

export async function clockCycle(now = Date.now(), notBefore = 0): Promise<void> {
  const selfId = await installationId();
  if (!(await thisInstallationRunsClock(selfId))) return;
  const userSettings = (await loadUserSettings()) || {};
  const lang = wakeLang((userSettings as Record<string, unknown>).language);
  const folders = await listFolders() as Array<{ name: string; settings?: Record<string, unknown> }>;
  for (const f of folders) {
    if (beingIsBlockedHere(f.name)) continue;
    const w = parseWakeSettings(f.settings?.wake);
    const s = await readWakeState(f.name);
    if (!w.enabled && !w.self.enabled && s.bookings.length === 0) continue;
    const slots = [...dueAdminSlots(w, now, notBefore), ...(w.self.enabled ? dueSelfSlots(s.bookings, now, notBefore) : [])];
    for (const slot of slots) {
      try {
        const convoId = await fireSlot(f.name, w, slot, selfId, lang, now);
        if (convoId) void kick(f.name, convoId);
      } catch (e) {
        console.warn(`[wake] firing ${f.name} ${slot.key} failed:`, e);
      }
    }
    // Busy at the slot → the item waited. Try again now.
    try {
      for (const convoId of await waitingWakeConversations(f.name, selfId)) void kick(f.name, convoId);
    } catch {}
  }
}

type ClockGlobal = { __nexusWakeClock?: { timer: ReturnType<typeof setInterval>; startedAt: number } };

/**
 * Start the clock once per server process. Called from instrumentation.ts at
 * boot and, as a fallback, from a route a tab polls (so an UPDATE.bat without
 * a restart still starts it). `startedAt` is the "missed while stopped →
 * nothing" line: no slot older than this process ever fires.
 */
export function ensureWakeClock(): void {
  const g = globalThis as ClockGlobal;
  if (g.__nexusWakeClock) return;
  const startedAt = Date.now();
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    clockCycle(Date.now(), startedAt).catch(e => console.warn('[wake] cycle failed:', e)).finally(() => { running = false; });
  }, TICK_MS);
  (timer as { unref?: () => void }).unref?.();
  g.__nexusWakeClock = { timer, startedAt };
}

export function wakeClockStartedAt(): number | null {
  return (globalThis as ClockGlobal).__nexusWakeClock?.startedAt ?? null;
}

export async function clearBookings(being: string, dataDir = DATA_DIR): Promise<void> {
  await withLock(being, async () => {
    const s = await readWakeState(being, dataDir);
    s.bookings = [];
    s.rejection = undefined;
    await writeWakeState(being, s, dataDir);
  });
}
