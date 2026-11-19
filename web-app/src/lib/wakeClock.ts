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
//      store, so it cannot name two. Absent = the first installation whose
//      clock ticks claims it (create-only), unless runner.json names another
//      one — see claimClockHostIfUnset. A person can still name it from the screen.
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
import { installationId, normaliseInstallPath, runnerHostStatus } from '@/lib/runnerHost';
import { enqueue, pending, queuedConversations } from '@/lib/turnQueue';
import { listFolders, listLogs, loadLog, loadUserSettings } from '@/lib/fsStorage';
import { livingConversation } from '@/lib/livingConversation';
import { readAllAgentFiles, extractAgentSystemPrompt } from '@/lib/systemPromptStorage';
import { beingIsBlockedHere } from '@/lib/blockedBeings';
import { conversationToolsEnabled } from '@/lib/agentCapabilities';
import { unreadFor } from '@/lib/letters';
import { autoTurnsHeldForLog } from '@/lib/autoHold';
import {
  parseWakeSettings, dueAdminSlots, dueSelfSlots, pruneBookings, validateBooking, parseWakeupDirective,
  wakeShortText, buildCapabilityList, buildSelfWakeLine, describeRejection, fillWakeTemplate,
  FALLBACK_WAKE_TEMPLATE, WAKE_PURPOSE, wakeLangFromSettings, localDateKey, localHHMM, rescheduleBooking, mailWakeDecision,
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

/**
 * Take the clock IF AND ONLY IF nobody holds it (つよ, 2026-11-16: the same
 * default the runner has). A new user with one NEXUS should not have to find
 * "run the clock here" before their first wake works.
 *
 * Create-only (`wx`), like claimRunnerHostIfUnset: it never steals a clock
 * another installation holds, and two claiming in the same instant get one
 * winner. A file that exists but cannot be read also refuses the write — that
 * is a person's choice gone wrong, not an empty seat.
 *
 * One more rule than the runner's: if runner.json names ANOTHER installation,
 * do not claim. On a shared store (3000 + 3001) the one that boots first would
 * otherwise take the clock, and the being it wakes would be answered by a
 * runner somewhere else. The runner's home claims it instead.
 */
export async function claimClockHostIfUnset(selfId: string, dataDir = DATA_DIR): Promise<'claimed' | 'taken' | 'deferred' | 'failed'> {
  const runner = await runnerHostStatus(selfId, dataDir);
  if (runner === 'not-host' || runner === 'unreadable') return 'deferred';
  const rec = { host: normaliseInstallPath(selfId), setAt: new Date().toISOString(), note: 'claimed automatically (no clock was set)' };
  try {
    await fs.mkdir(wakeDir(dataDir), { recursive: true });
    await fs.writeFile(path.join(wakeDir(dataDir), CLOCK_FILE), JSON.stringify(rec, null, 2), { flag: 'wx' });
    return 'claimed';
  } catch (e: any) {
    return e?.code === 'EEXIST' ? 'taken' : 'failed';
  }
}

/** Runs the clock here, claiming the empty seat first if there is one. */
export async function runsClockOrClaims(selfId: string, dataDir = DATA_DIR): Promise<boolean> {
  if (await thisInstallationRunsClock(selfId, dataDir)) return true;
  if ((await claimClockHostIfUnset(selfId, dataDir)) !== 'claimed') return false;
  // Re-read: the file on disk is the only authority (see runnerHost.ts).
  return thisInstallationRunsClock(selfId, dataDir);
}

// ── Per-being state ─────────────────────────────────────────────────────────

export interface WakeEvent {
  at: number;
  kind: 'fired' | 'booked' | 'rejected' | 'no-conversation' | 'no-letters' | 'context-full' | 'error' | 'admin-removed' | 'admin-moved';
  hhmm?: string;
  source?: 'admin' | 'self' | 'mail';
  convoId?: string;
  reason?: WakeRejectReason | string;
  detail?: string;
}

export interface WakeState {
  bookings: SelfBooking[];
  /** A rejection not yet told to the being. Cleared when the next wake says it. */
  rejection?: { hhmm: string; reason: WakeRejectReason; detail?: string; at: number };
  history: WakeEvent[];
  /** When the last mail wake fired (spaces mail wakes by the minimum gap). */
  lastMailWakeAt?: number;
}

function statePath(being: string, dataDir = DATA_DIR) { return path.join(wakeDir(dataDir), `${safeName(being)}.json`); }

export async function readWakeState(being: string, dataDir = DATA_DIR): Promise<WakeState> {
  try {
    const p = JSON.parse(await fs.readFile(statePath(being, dataDir), 'utf-8'));
    return {
      bookings: Array.isArray(p.bookings) ? p.bookings.filter((b: any) => typeof b?.at === 'number' && typeof b?.hhmm === 'string') : [],
      rejection: p.rejection && typeof p.rejection.hhmm === 'string' ? p.rejection : undefined,
      history: Array.isArray(p.history) ? p.history : [],
      ...(typeof p.lastMailWakeAt === 'number' ? { lastMailWakeAt: p.lastMailWakeAt } : {}),
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

/**
 * The conversation a wake opens: the being's LIVING conversation, decided by
 * title (see livingConversation.ts) — the same row the sidebar shows on top.
 *
 * Until 2026-11-15 this took the first active log in `listLogs()` order, which
 * is modification time: a past log that had merely been saved (its log cap
 * edited, a summary rebuilt) would have been woken instead of the current one.
 * A test-bed being has no generations, so it keeps that older answer.
 */
export async function latestActiveConversation(being: string): Promise<string | null> {
  type Row = { id: string; folderName: string; title?: string; active?: boolean; corrupted?: boolean };
  const mine = (await listLogs() as Row[]).filter(l => l.folderName === being);
  let testBed = false;
  let pinned: string | undefined;
  try {
    const folders = await listFolders() as Array<{ name: string; settings?: { testBed?: unknown; wake?: unknown } }>;
    const f = folders.find(x => x.name === being);
    testBed = f?.settings?.testBed === true;
    pinned = parseWakeSettings(f?.settings?.wake).convoId;
  } catch {}
  if (testBed) {
    // Only the pinned conversation, and only while it still exists and is active.
    // No pin → no wake: "the one touched last" wandered between unrelated beings.
    const hit = pinned ? mine.find(l => l.id === pinned && l.active !== false && !l.corrupted) : undefined;
    return hit?.id ?? null;
  }
  return livingConversation(mine, being)?.id ?? null;
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
    beingRouteEnabled: b('beingRouteEnabled'),
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
    if (slot.source === 'mail' && log.lettersEnabled !== true) {
      // Woken "because a letter came" with no way to read it would only confuse.
      s.history.push({ at: now, kind: 'no-letters', hhmm: slot.hhmm, source: 'mail', convoId });
      await writeWakeState(being, s);
      return null;
    }
    // Context at 100% → no wake (つよ, 2026-11-17). Nothing is queued, the slot
    // is spent like one missed while NEXUS was stopped, and the history says why.
    let beingSettings: Record<string, unknown> | undefined;
    try {
      beingSettings = (await listFolders() as Array<{ name: string; settings?: Record<string, unknown> }>).find(x => x.name === being)?.settings;
    } catch {}
    if (autoTurnsHeldForLog(log, beingSettings)) {
      s.history.push({ at: now, kind: 'context-full', hhmm: slot.hhmm, source: slot.source, convoId });
      await writeWakeState(being, s);
      return null;
    }
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
    if (slot.source === 'mail') s.lastMailWakeAt = now;
    s.history.push({ at: now, kind: 'fired', hhmm: slot.hhmm, source: slot.source, convoId });
    await writeWakeState(being, s);
    return convoId;
  });
}

// ── Running the queued wake ─────────────────────────────────────────────────

const inFlight = new Set<string>();

async function kick(being: string, convoId: string, auto = false, wake = false) {
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
      body: JSON.stringify(auto ? { being, convoId, auto: true } : wake ? { being, convoId, wake: true } : { being, convoId }),
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

/**
 * Conversations holding an UN-ADDRESSED waiting `user_message` — in practice a
 * `[->name]` block from another being (2026-11-16). Such an item has no screen
 * behind it, so the store-level host runs it; when the WRITER's turn ran on
 * the other install, nothing on this one was told. The clock is the one loop
 * here that runs with no tab, so it sweeps them. Kicked as an `auto` pass:
 * the being's own "stocked messages" checkbox still decides whether to wake.
 */
async function waitingRoutedConversations(being: string): Promise<string[]> {
  // The queue folders, not listLogs: this runs for EVERY being every cycle,
  // and only a conversation with something queued can be an answer.
  const out: string[] = [];
  for (const q of await queuedConversations(being)) {
    if (q.leased || q.count === 0) continue;
    let items;
    try { items = await pending(being, q.convoId); } catch { continue; }
    if (items.some(it => it.kind === 'user_message' && !(it.host || '').trim())) out.push(q.convoId);
  }
  return out;
}

// ── Mail ────────────────────────────────────────────────────────────────────
//
// Polled every cycle rather than hooked into writeLetter: a letter from 3003
// arrives through the bridge junction with no event in THIS process, and the
// unread list on disk is the only place both kinds of letter meet.
//
// What has been seen lives in process memory on purpose. A fresh process (or
// mail wake just switched on) starts from "nothing seen" and the rule then
// remembers what is unread without firing: letters that came while NEXUS was
// stopped do not wake anyone, the same as missed timed slots.

type MailGlobal = { __nexusMailSeen?: Map<string, string[]> };
function mailSeen(): Map<string, string[]> {
  const g = globalThis as MailGlobal;
  return (g.__nexusMailSeen ??= new Map());
}

async function mailSlot(being: string, w: WakeSettings, s: WakeState, now: number): Promise<DueSlot | null> {
  const memo = mailSeen();
  if (!w.mail) { memo.delete(being); return null; }
  const unread = (await unreadFor(being)).map(l => l.id);
  const d = mailWakeDecision(unread, memo.get(being) ?? null, s.lastMailWakeAt, w.self.minGapMin, now);
  if (!d.fire) { memo.set(being, d.seen); return null; }
  // Remembered only once the wake is actually queued (see clockCycle).
  return { key: `${localDateKey(new Date(now))}_mail_${now}`, at: now, source: 'mail', hhmm: localHHMM(new Date(now)), seenAfter: d.seen } as DueSlot & { seenAfter: string[] };
}

// ── The loop ────────────────────────────────────────────────────────────────

export async function clockCycle(now = Date.now(), notBefore = 0): Promise<void> {
  const selfId = await installationId();
  if (!(await runsClockOrClaims(selfId))) return;
  const userSettings = (await loadUserSettings()) || {};
  const lang = wakeLangFromSettings(userSettings as Record<string, unknown>);
  const folders = await listFolders() as Array<{ name: string; settings?: Record<string, unknown> }>;
  for (const f of folders) {
    if (beingIsBlockedHere(f.name)) continue;
    // Before the "no wake settings" skip below: a `[->name]` message is for
    // every being, wake settings or not.
    try {
      for (const convoId of await waitingRoutedConversations(f.name)) void kick(f.name, convoId, true);
    } catch {}
    const w = parseWakeSettings(f.settings?.wake);
    const s = await readWakeState(f.name);
    if (!w.enabled && !w.self.enabled && !w.mail && s.bookings.length === 0) { mailSeen().delete(f.name); continue; }
    const slots: DueSlot[] = [...dueAdminSlots(w, now, notBefore), ...(w.self.enabled ? dueSelfSlots(s.bookings, now, notBefore) : [])];
    try {
      const m = await mailSlot(f.name, w, s, now);
      if (m) slots.push(m);
    } catch (e) {
      console.warn(`[wake] mail check for ${f.name} failed:`, e);
    }
    for (const slot of slots) {
      try {
        const convoId = await fireSlot(f.name, w, slot, selfId, lang, now);
        const seenAfter = (slot as DueSlot & { seenAfter?: string[] }).seenAfter;
        // A mail slot counts the letters as seen even when it could not fire
        // (no conversation, letters off) — otherwise it would retry every 30 s.
        if (seenAfter) mailSeen().set(f.name, seenAfter);
        if (convoId) void kick(f.name, convoId, false, true);
      } catch (e) {
        console.warn(`[wake] firing ${f.name} ${slot.key} failed:`, e);
      }
    }
    // Busy at the slot → the item waited. Try again now.
    try {
      for (const convoId of await waitingWakeConversations(f.name, selfId)) void kick(f.name, convoId, false, true);
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
  // Every load of this module republishes its clockCycle. The timer below is
  // created once per process and outlives hot reloads; if it held the cycle
  // from its own closure it would keep running the OLD rules until a restart
  // (seen 2026-11-15: a fix to the test-bed target did not reach the clock).
  (g as { __nexusWakeCycle?: typeof clockCycle }).__nexusWakeCycle = clockCycle;
  if (g.__nexusWakeClock) return;
  const startedAt = Date.now();
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    const cycle = (g as { __nexusWakeCycle?: typeof clockCycle }).__nexusWakeCycle || clockCycle;
    cycle(Date.now(), startedAt).catch(e => console.warn('[wake] cycle failed:', e)).finally(() => { running = false; });
  }, TICK_MS);
  (timer as { unref?: () => void }).unref?.();
  g.__nexusWakeClock = { timer, startedAt };
}

export function wakeClockStartedAt(): number | null {
  return (globalThis as ClockGlobal).__nexusWakeClock?.startedAt ?? null;
}

/** An administrator deletes one self-booking. False = it was already gone. */
export async function removeBooking(being: string, at: number, now = Date.now(), dataDir = DATA_DIR): Promise<boolean> {
  return withLock(being, async () => {
    const s = await readWakeState(being, dataDir);
    const hit = s.bookings.find(b => b.at === at);
    if (!hit) return false;
    s.bookings = s.bookings.filter(b => b.at !== at);
    s.history.push({ at: now, kind: 'admin-removed', hhmm: hit.hhmm, source: 'self' });
    await writeWakeState(being, s, dataDir);
    return true;
  });
}

/** An administrator moves one self-booking (limits not applied — see rescheduleBooking). */
export async function moveBooking(being: string, at: number, hhmm: string, now = Date.now(), dataDir = DATA_DIR): Promise<SelfBooking | null> {
  return withLock(being, async () => {
    const s = await readWakeState(being, dataDir);
    const r = rescheduleBooking(s.bookings, at, hhmm, now);
    if (!r) return null;
    const oldHhmm = s.bookings.find(b => b.at === at)?.hhmm;
    s.bookings = r.bookings;
    s.history.push({ at: now, kind: 'admin-moved', hhmm: r.booking.hhmm, source: 'self', detail: oldHhmm });
    await writeWakeState(being, s, dataDir);
    return r.booking;
  });
}

export async function clearBookings(being: string, dataDir = DATA_DIR): Promise<void> {
  await withLock(being, async () => {
    const s = await readWakeState(being, dataDir);
    s.bookings = [];
    s.rejection = undefined;
    await writeWakeState(being, s, dataDir);
  });
}
