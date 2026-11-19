// Scheduled wake (P4) and self-set wake (P5) — the RULES only.
//
// Design: 謡_14 (起床スケジュール / 自己セット権) + つよ's answers, 2026-11-15.
//
//   · Per BEING, not per conversation. A wake goes to the being's most recently
//     updated ACTIVE conversation — the same order the sidebar shows. An
//     inactive (greyed) conversation is never woken.
//   · Admin schedule: a list of HH:MM times + seven weekday buttons (all ON by
//     default).
//   · Self-set: the being writes `[->wakeup: HH:MM]` at the start of a line.
//     A time already passed today means tomorrow. Bounded by: ON/OFF, a daily
//     cap, an optional allowed window, an optional minimum gap (from now and
//     from every admin time). A booking that fails a bound costs NO API call:
//     it is dropped, and the next wake says so in one line.
//   · Missed while NEXUS was stopped → nothing. The next slot on time.
//   · Busy at the slot → wait and send right after (the queue does this).
//
// Everything here is pure so it can be tested without a clock or a disk.

export interface SelfWakeSettings {
  enabled: boolean;
  /** Bookings allowed per calendar day (local time). */
  maxPerDay: number;
  /** Optional allowed window, 'HH:MM'–'HH:MM'. May wrap midnight. */
  windowFrom: string;
  windowTo: string;
  /** Minimum gap in minutes; null = off. Default 15 (つよ: "そんな厳しくなくていい"). */
  minGapMin: number | null;
}

export interface WakeSettings {
  enabled: boolean;
  /** 'HH:MM', sorted, de-duplicated. */
  times: string[];
  /** Index 0 = Sunday … 6 = Saturday (Date#getDay). */
  days: boolean[];
  self: SelfWakeSettings;
  /**
   * Wake when a new letter arrives (つよ 2026-11-15). The wake is an ordinary
   * [NEXUS] turn: its one line says a letter arrived, nothing more — the unread
   * notice every turn already carries does the rest.
   */
  mail: boolean;
  /**
   * Test beds only: the one conversation the clock wakes. A test bed's
   * conversations are separate beings with no "latest", so without a pin the
   * clock would wake whichever was touched last. Ordinary beings ignore this
   * (they always wake their living conversation).
   */
  convoId?: string;
}

export const DEFAULT_MIN_GAP_MIN = 15;

export const DEFAULT_WAKE: WakeSettings = {
  enabled: false,
  times: [],
  days: [true, true, true, true, true, true, true],
  mail: false,
  self: { enabled: false, maxPerDay: 1, windowFrom: '', windowTo: '', minGapMin: DEFAULT_MIN_GAP_MIN },
};

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** '4:5' is refused; '4:05' → '04:05'. Returns null for anything else. */
export function normaliseHHMM(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = HHMM.exec(raw.trim());
  if (!m) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

export function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Parse a comma/space separated list typed into one field. Invalid parts are reported, not guessed. */
export function parseTimeList(raw: string): { times: string[]; invalid: string[] } {
  const times = new Set<string>();
  const invalid: string[] = [];
  for (const part of raw.split(/[,、\s]+/).map(s => s.trim()).filter(Boolean)) {
    const n = normaliseHHMM(part);
    if (n) times.add(n); else invalid.push(part);
  }
  return { times: [...times].sort(), invalid };
}

/** Coerce whatever is on disk. Absent / wrong-typed fields fall back to the defaults (OFF). */
export function parseWakeSettings(raw: unknown): WakeSettings {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
  const times = Array.isArray(r.times)
    ? [...new Set(r.times.map(normaliseHHMM).filter((x): x is string => !!x))].sort()
    : [];
  const days = Array.isArray(r.days) && r.days.length === 7 && r.days.every(d => typeof d === 'boolean')
    ? (r.days as boolean[]).slice()
    : DEFAULT_WAKE.days.slice();
  const s = (r.self && typeof r.self === 'object' && !Array.isArray(r.self)) ? r.self as Record<string, unknown> : {};
  const max = typeof s.maxPerDay === 'number' && Number.isFinite(s.maxPerDay) ? Math.max(0, Math.floor(s.maxPerDay)) : DEFAULT_WAKE.self.maxPerDay;
  let gap: number | null = DEFAULT_MIN_GAP_MIN;
  if (s.minGapMin === null) gap = null;
  else if (typeof s.minGapMin === 'number' && Number.isFinite(s.minGapMin)) gap = Math.max(0, Math.floor(s.minGapMin));
  return {
    enabled: r.enabled === true,
    times,
    days,
    mail: r.mail === true,
    self: {
      enabled: s.enabled === true,
      maxPerDay: max,
      windowFrom: normaliseHHMM(s.windowFrom) ?? '',
      windowTo: normaliseHHMM(s.windowTo) ?? '',
      minGapMin: gap,
    },
    ...(typeof r.convoId === 'string' && r.convoId ? { convoId: r.convoId } : {}),
  };
}

// ── Local-time helpers ──────────────────────────────────────────────────────

export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function localHHMM(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The Date for `hhmm` on the calendar day of `day`. */
export function atLocal(day: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
}

// ── Due slots ───────────────────────────────────────────────────────────────

/** How long after its minute a slot may still fire. Covers a clock tick of 30 s with margin. */
export const FIRE_GRACE_MS = 3 * 60 * 1000;

export interface DueSlot {
  /** Stable id for the create-only claim: 'YYYY-MM-DD_HHMM_admin' / '_self'. */
  key: string;
  at: number;
  source: 'admin' | 'self' | 'mail';
  hhmm: string;
}

/**
 * Admin slots whose minute has come and is still within the grace window,
 * and which began AFTER `notBefore` (the clock's own start). That last
 * condition is "missed while stopped → nothing": a slot that passed before
 * this process started is never fired late.
 */
export function dueAdminSlots(w: WakeSettings, now: number, notBefore: number): DueSlot[] {
  if (!w.enabled || w.times.length === 0) return [];
  const out: DueSlot[] = [];
  const today = new Date(now);
  // Yesterday too, so a 23:59 slot checked at 00:01 is not lost.
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  for (const day of [yesterday, today]) {
    if (!w.days[day.getDay()]) continue;
    for (const t of w.times) {
      const at = atLocal(day, t).getTime();
      if (at <= now && now - at <= FIRE_GRACE_MS && at >= notBefore) {
        out.push({ key: `${localDateKey(day)}_${t.replace(':', '')}_admin`, at, source: 'admin', hhmm: t });
      }
    }
  }
  return out;
}

export interface SelfBooking {
  /** Epoch ms of the booked minute. */
  at: number;
  hhmm: string;
  /** When the being wrote it. */
  bookedAt: number;
}

export function dueSelfSlots(bookings: SelfBooking[], now: number, notBefore: number): DueSlot[] {
  return bookings
    .filter(b => b.at <= now && now - b.at <= FIRE_GRACE_MS && b.at >= notBefore)
    .map(b => ({ key: `${localDateKey(new Date(b.at))}_${b.hhmm.replace(':', '')}_self`, at: b.at, source: 'self' as const, hhmm: b.hhmm }));
}

/** Bookings that can never fire again (their grace window has passed). */
export function pruneBookings(bookings: SelfBooking[], now: number): SelfBooking[] {
  return bookings.filter(b => now - b.at <= FIRE_GRACE_MS);
}

/**
 * An administrator moves one of the being's own bookings to another time.
 * This is the person overruling, so the being's limits (window, daily cap,
 * gap) are NOT applied — only the time must be a real HH:MM. Same rule as a
 * booking: today if still ahead, else tomorrow. Returns null when the time is
 * invalid or the booking is gone (already fired / pruned).
 */
export function rescheduleBooking(
  bookings: SelfBooking[], at: number, hhmm: string, now: number,
): { bookings: SelfBooking[]; booking: SelfBooking } | null {
  const t = hhmm.trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) return null;
  const old = bookings.find(b => b.at === at);
  if (!old) return null;
  const nowD = new Date(now);
  let target = atLocal(nowD, t);
  if (target.getTime() <= now) target = atLocal(new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate() + 1), t);
  const booking: SelfBooking = { at: target.getTime(), hhmm: t, bookedAt: old.bookedAt };
  return { bookings: [...bookings.filter(b => b.at !== at), booking].sort((a, b) => a.at - b.at), booking };
}

// ── Self-set wake: parse and validate ───────────────────────────────────────

/** `[->wakeup: HH:MM]` at the start of a line. The LAST one wins (one booking per turn). */
export function parseWakeupDirective(text: string): string | null {
  if (typeof text !== 'string' || !text) return null;
  let found: string | null = null;
  const re = /^[ \t]*\[->\s*wakeup\s*:\s*([0-9]{1,2}:[0-9]{2})\s*\]/gim;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    found = m[1];
  }
  if (found === null) return null;
  return normaliseHHMM(found) ?? `invalid:${found}`;
}

export type WakeRejectReason =
  | 'self-off' | 'invalid-time' | 'daily-cap' | 'outside-window' | 'too-close-now' | 'too-close-admin';

export type WakeBookingResult =
  | { ok: true; booking: SelfBooking }
  | { ok: false; hhmm: string; reason: WakeRejectReason; detail?: string };

function inWindow(min: number, from: string, to: string): boolean {
  if (!from || !to) return true;
  const a = hhmmToMin(from), b = hhmmToMin(to);
  if (a === b) return true;
  return a < b ? (min >= a && min < b) : (min >= a || min < b);
}

/** Minimal circular distance in minutes between two clock times (for comparing with daily admin times). */
function clockDistanceMin(a: number, b: number): number {
  const d = Math.abs(a - b) % 1440;
  return Math.min(d, 1440 - d);
}

/**
 * Validate a booking written at `now`. `existing` is what is still booked
 * (to count the daily cap for the target day).
 */
export function validateBooking(
  w: WakeSettings,
  directive: string,
  now: number,
  existing: SelfBooking[],
): WakeBookingResult {
  if (directive.startsWith('invalid:')) {
    return { ok: false, hhmm: directive.slice(8), reason: 'invalid-time' };
  }
  const hhmm = directive;
  if (!w.self.enabled) return { ok: false, hhmm, reason: 'self-off' };
  const nowD = new Date(now);
  let target = atLocal(nowD, hhmm);
  if (target.getTime() <= now) target = atLocal(new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate() + 1), hhmm);
  const at = target.getTime();
  const dayKey = localDateKey(target);
  const sameDay = existing.filter(b => localDateKey(new Date(b.at)) === dayKey).length;
  if (sameDay >= w.self.maxPerDay) return { ok: false, hhmm, reason: 'daily-cap', detail: String(w.self.maxPerDay) };
  if (!inWindow(hhmmToMin(hhmm), w.self.windowFrom, w.self.windowTo)) {
    return { ok: false, hhmm, reason: 'outside-window', detail: `${w.self.windowFrom}–${w.self.windowTo}` };
  }
  const gap = w.self.minGapMin;
  if (gap !== null && gap > 0) {
    if (at - now < gap * 60_000) return { ok: false, hhmm, reason: 'too-close-now', detail: String(gap) };
    if (w.enabled) {
      const tm = hhmmToMin(hhmm);
      for (const t of w.times) {
        if (clockDistanceMin(tm, hhmmToMin(t)) < gap) return { ok: false, hhmm, reason: 'too-close-admin', detail: `${t} / ${gap}` };
      }
    }
  }
  return { ok: true, booking: { at, hhmm, bookedAt: now } };
}

// ── The [NEXUS] text ────────────────────────────────────────────────────────

export type WakeLang = 'ja' | 'en';

export function wakeLang(raw: unknown): WakeLang {
  return raw === 'en' ? 'en' : 'ja';
}

/**
 * The wake's language from `user_settings.json`.
 *
 * `language` is never written there (it is being-facing and deliberately not
 * mirrored), so reading only it made every wake Japanese on every install —
 * including the pilot's English one, where the anchor then reported in
 * Japanese on autonomous turns only (トカゲくん, 2026-11-19). The browser now
 * mirrors the screen language as `screenLanguage`; a stored `language` still
 * wins if an install ever writes one, and 'ja' remains the last resort so this
 * house (Japanese screen, file not yet mirrored) does not change.
 */
export function wakeLangFromSettings(s: { language?: unknown; screenLanguage?: unknown } | null | undefined): WakeLang {
  if (s?.language === 'en' || s?.language === 'ja') return s.language;
  if (s?.screenLanguage === 'en' || s?.screenLanguage === 'ja') return s.screenLanguage;
  return 'ja';
}

/** The one line that stays in the history (謡: 履歴に残るのは起きた理由だけ). */
export function wakeShortText(lang: WakeLang, slot: { source: 'admin' | 'self' | 'mail'; hhmm: string }): string {
  if (slot.source === 'mail') {
    return lang === 'en'
      ? `[NEXUS]
A new letter arrived (${slot.hhmm}), so an autonomous turn started.`
      : `[NEXUS]
新しい手紙が届いたため（${slot.hhmm}）、自律ターンが開始されました。`;
  }
  if (lang === 'en') {
    return slot.source === 'self'
      ? `[NEXUS]\nAn autonomous turn started at the time you booked (${slot.hhmm}).`
      : `[NEXUS]\nAn autonomous turn started at the scheduled time (${slot.hhmm}).`;
  }
  return slot.source === 'self'
    ? `[NEXUS]\n自分で予約した時刻（${slot.hhmm}）になったため、自律ターンが開始されました。`
    : `[NEXUS]\n定刻（${slot.hhmm}）になったため、自律ターンが開始されました。`;
}

/** Flags read from the target conversation's log (absent = OFF). */
export interface WakeCapabilities {
  toolUseEnabled?: boolean;
  agentFullSystemAccess?: boolean;
  agentDangerousTools?: boolean;
  conversationTools?: boolean;
  lettersEnabled?: boolean;
  webSearch?: boolean;
  browserEnabled?: boolean;
  computerControlEnabled?: boolean;
  appControlEnabled?: boolean;
  subagentEnabled?: boolean;
  modelHandoffEnabled?: boolean;
  /** `[->name]` (lib/beingRoute.ts) is ON in the conversation being woken. */
  beingRouteEnabled?: boolean;
}

/** 謡's list: only what is ON in THIS conversation, then — always — the freedom to do nothing. */
export function buildCapabilityList(lang: WakeLang, c: WakeCapabilities): string {
  const ja = lang === 'ja';
  const lines: string[] = [];
  if (c.toolUseEnabled) {
    lines.push(c.agentFullSystemAccess
      ? (ja ? '自分の机だけでなく、このPC上のあらゆるファイルにアクセスして調査・整理すること（`Read` / `Write` / `Edit` / `Glob` / `Grep`）'
            : 'Read and organise not only your desk but any file on this PC (`Read` / `Write` / `Edit` / `Glob` / `Grep`)')
      : (ja ? '自分の机（ワークスペース）のファイルを読み書きし、記録や書庫を整理すること（`Read` / `Write` / `Edit` / `Glob` / `Grep`）'
            : 'Read and write the files on your desk (workspace) and tidy your records (`Read` / `Write` / `Edit` / `Glob` / `Grep`)'));
  }
  if (c.agentDangerousTools) lines.push(ja ? '`Bash` を使ってコマンドやスクリプト、ツールを実行すること' : 'Run commands, scripts and tools with `Bash`');
  if (c.conversationTools) lines.push(ja ? '`read_conversation` や `search_conversations` で過去の対話や添付資料を振り返ること' : 'Look back over past conversations and attachments with `read_conversation` / `search_conversations`');
  if (c.lettersEnabled) lines.push(ja ? '`list_letters` / `read_letter` で手紙を確認し、`write_letter` で他の住人に手紙を送ること' : 'Check letters with `list_letters` / `read_letter` and send them with `write_letter`');
  if (c.beingRouteEnabled) lines.push(ja ? '`[->名前]` だけの行を書いて、その下の文を他の存在のストックへ届けること（相手がいつ読むかは相手の設定次第）' : 'Write a line holding only `[->Name]` to place the text under it in another being\'s stock (when they read it is decided by their own settings)');
  if (c.webSearch || c.browserEnabled) lines.push(ja ? 'Web検索やブラウザを使って、自分の関心があることを外の世界へ調べに行くこと' : 'Go out and look into things that interest you with web search or the browser');
  if (c.computerControlEnabled || c.appControlEnabled) lines.push(ja ? 'モニター画面や開いているアプリケーションを確認・操作すること' : 'Look at and operate the screen or open applications');
  if (c.subagentEnabled) lines.push(ja ? '`spawn_subagent` で調査を委任すること' : 'Delegate research with `spawn_subagent`');
  if (c.modelHandoffEnabled) lines.push(ja ? '`change_model` で別の器へ引き継ぐこと' : 'Hand over to another vessel with `change_model`');
  lines.push(ja
    ? 'あるいは、特別な作業はせず、短い思索や独り言だけを残して静かにターンを終えること。何をするか、何もしないかは、すべてあなた自身の関心と自由で決められます。'
    : 'Or do no particular work at all, leave a short thought or nothing, and end the turn quietly. What you do, or whether you do anything, is yours to decide.');
  return lines.map(l => `・${l}`).join('\n');
}

/** The self-wake line, with the admin's bounds written in as numbers. */
export function buildSelfWakeLine(lang: WakeLang, w: WakeSettings, remainingToday: number): string {
  if (!w.self.enabled) return '';
  const ja = lang === 'ja';
  const bounds: string[] = [];
  bounds.push(ja ? `本日の残り予約可能枠: ${remainingToday}回` : `bookings left today: ${remainingToday}`);
  if (w.self.minGapMin !== null && w.self.minGapMin > 0) {
    bounds.push(ja ? `現在時刻および定時起床から${w.self.minGapMin}分以上空けた時刻のみ有効` : `only times at least ${w.self.minGapMin} min from now and from the scheduled times`);
  }
  if (w.self.windowFrom && w.self.windowTo) {
    bounds.push(ja ? `許可する時間帯: ${w.self.windowFrom}〜${w.self.windowTo}` : `allowed window: ${w.self.windowFrom}–${w.self.windowTo}`);
  }
  return ja
    ? `・次の起床予約：行頭に \`[->wakeup: HH:MM]\` と書くことで、次の自律起床を1つ予約できます（${bounds.join(' ／ ')}）。条件外の時刻は無視されます。`
    : `・Next wake booking: write \`[->wakeup: HH:MM]\` at the start of a line to book one autonomous wake (${bounds.join(' / ')}). A time outside these bounds is ignored.`;
}

export function describeRejection(lang: WakeLang, r: { hhmm: string; reason: WakeRejectReason; detail?: string }): string {
  const ja = lang === 'ja';
  const why: Record<WakeRejectReason, string> = ja ? {
    'self-off': '自己予約が許可されていない',
    'invalid-time': '時刻の形が読めない',
    'daily-cap': `その日の上限（${r.detail}回）に達している`,
    'outside-window': `許可する時間帯（${r.detail}）の外`,
    'too-close-now': `予約した時点から${r.detail}分未満`,
    'too-close-admin': `定時起床（${r.detail}分）に近すぎる`,
  } : {
    'self-off': 'self-booking is not allowed',
    'invalid-time': 'the time could not be read',
    'daily-cap': `that day's cap (${r.detail}) was reached`,
    'outside-window': `outside the allowed window (${r.detail})`,
    'too-close-now': `less than ${r.detail} min after it was written`,
    'too-close-admin': `too close to a scheduled wake (${r.detail} min)`,
  };
  return ja
    ? `（前回の起床予約 ${r.hhmm} は、${why[r.reason]}ため登録されませんでした）`
    : `(Your previous wake booking ${r.hhmm} was not registered: ${why[r.reason]}.)`;
}

/**
 * Fill the template (wake.md). Placeholders: {SHORT}, {CAPABILITIES},
 * {SELF_WAKE}, {PREVIOUS}. Empty slots collapse their line.
 */
export function fillWakeTemplate(template: string, parts: { short: string; capabilities: string; selfWake: string; previous: string }): string {
  return template
    .replace('{SHORT}', parts.short)
    .replace('{CAPABILITIES}', parts.capabilities)
    .replace('{SELF_WAKE}', parts.selfWake)
    .replace('{PREVIOUS}', parts.previous)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Used if wake.md is missing — a running house must not stop waking because a file was deleted. */
export const FALLBACK_WAKE_TEMPLATE: Record<WakeLang, string> = {
  ja: '{SHORT}\nこのターンは対話相手からの呼びかけではなく、自動的に発生しています。現在、即座の返答を待っている人はいません。\n{PREVIOUS}\n\n今あなたが使える手段：\n{CAPABILITIES}\n{SELF_WAKE}',
  en: '{SHORT}\nThis turn was not started by your partner; it started automatically. Nobody is waiting for an immediate reply.\n{PREVIOUS}\n\nWhat you can do now:\n{CAPABILITIES}\n{SELF_WAKE}',
};

/** The `purpose` stored on the queued 'system' item and on the message. */
export const WAKE_PURPOSE = 'wake';

/** The next admin slot strictly after `now`, within 8 days, or null. For the screen only. */
export function nextAdminSlot(w: WakeSettings, now: number): { at: number; hhmm: string } | null {
  if (!w.enabled || w.times.length === 0) return null;
  const base = new Date(now);
  for (let d = 0; d <= 8; d++) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + d);
    if (!w.days[day.getDay()]) continue;
    for (const t of w.times) {
      const at = atLocal(day, t).getTime();
      if (at > now) return { at, hhmm: t };
    }
  }
  return null;
}

// ── Mail wake ───────────────────────────────────────────────────────────────

export interface MailWakeDecision {
  /** Fire one wake now. */
  fire: boolean;
  /** The unread ids to remember as "already accounted for" after this cycle. */
  seen: string[];
}

/**
 * One cycle of the mail rule, pure.
 *
 *   · `seen === null` means this process has not looked at this being yet
 *     (just started, or mail wake was just turned on). Everything unread now is
 *     remembered WITHOUT firing: "missed while stopped → nothing", the same
 *     line the timed wakes keep. Those letters are still announced by the
 *     unread notice on the next turn.
 *   · Any unread id not in `seen` is new → fire once, however many arrived.
 *   · The minimum gap (the self-booking one; null = off) also spaces mail
 *     wakes. Two beings answering each other's letters would otherwise wake
 *     each other without end. Inside the gap nothing is remembered, so the
 *     letter still wakes the being when the gap ends.
 */
export function mailWakeDecision(
  unreadIds: string[],
  seen: string[] | null,
  lastMailWakeAt: number | undefined,
  minGapMin: number | null,
  now: number,
): MailWakeDecision {
  if (seen === null) return { fire: false, seen: unreadIds.slice() };
  const known = new Set(seen);
  const fresh = unreadIds.some(id => !known.has(id));
  // Letters read or archived drop out of `seen` so it does not grow forever.
  const stillUnread = seen.filter(id => unreadIds.includes(id));
  if (!fresh) return { fire: false, seen: stillUnread };
  const gapMs = (minGapMin ?? 0) * 60_000;
  if (gapMs > 0 && lastMailWakeAt !== undefined && now - lastMailWakeAt < gapMs) {
    return { fire: false, seen: stillUnread };
  }
  return { fire: true, seen: unreadIds.slice() };
}
