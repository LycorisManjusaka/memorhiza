// Conditional notes from the administrator, added to a wake turn (2026-11-24).
//
// NEXUS itself knows nothing about "work hours", "holidays" or what a note is
// for. It holds ONE tool: a list of rules, each a text plus optional
// conditions (weekdays, a time range, days off). Read top to bottom; the first
// rule that fits the moment the turn STARTS is the one note added — one, never
// several. A rule with no conditions fits always, so it works as "otherwise".
//
// Days off are dates the administrator types in. NEXUS carries no country's
// holiday table: the people using it do not share one calendar.
//
// The note is appended AFTER the wake text (wake.md is not touched) under a
// heading that says who is speaking. The wake text states facts in NEXUS's
// voice; a request in that same voice would read as a fact about the world.
//
// Pure rules only — no fs here. Disk: lib/wakeAdminNotesStore.ts.

export type DayOffMode = 'any' | 'exclude' | 'only';

export interface AdminNoteRule {
  text: string;
  /** Sunday-first, like WakeSettings.days. All false or all true = any day. */
  days: boolean[];
  /** 'HH:MM' both, or both empty = any time. `to` is inclusive; from > to wraps past midnight. */
  from: string;
  to: string;
  /** 'exclude' = not on a day off; 'only' = only on a day off. */
  dayOff: DayOffMode;
}

export interface AdminNotesConfig {
  /** Off by default: an update changes nothing until someone switches it on. */
  enabled: boolean;
  rules: AdminNoteRule[];
  /** 'YYYY-MM-DD', local dates. */
  daysOff: string[];
}

export const EMPTY_ADMIN_NOTES: AdminNotesConfig = { enabled: false, rules: [], daysOff: [] };

export const MAX_ADMIN_NOTE_RULES = 20;

function hhmm(raw: unknown): string {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(typeof raw === 'string' ? raw : '');
  if (!m) return '';
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return '';
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

function minutes(t: string): number {
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
}

/** Accepts `2026-1-3`, `2026/01/03`; returns 'YYYY-MM-DD' or '' for anything that is not a real date. */
export function normaliseDayOff(raw: unknown): string {
  const m = /^\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s*$/.exec(typeof raw === 'string' ? raw : '');
  if (!m) return '';
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return '';
  return `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** One date per line (commas and spaces also separate). Returns what was kept and what was not a date. */
export function parseDaysOff(raw: string): { days: string[]; invalid: string[] } {
  const days: string[] = [], invalid: string[] = [];
  for (const piece of raw.split(/[\s,、，]+/)) {
    if (!piece) continue;
    const d = normaliseDayOff(piece);
    if (!d) invalid.push(piece);
    else if (!days.includes(d)) days.push(d);
  }
  days.sort();
  return { days, invalid };
}

export function parseAdminNotes(raw: unknown): AdminNotesConfig {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_ADMIN_NOTES, rules: [], daysOff: [] };
  const r = raw as Record<string, unknown>;
  const rules: AdminNoteRule[] = [];
  for (const x of Array.isArray(r.rules) ? r.rules : []) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const days = Array.from({ length: 7 }, (_, i) => Array.isArray(o.days) && o.days[i] === true);
    const from = hhmm(o.from), to = hhmm(o.to);
    rules.push({
      text: typeof o.text === 'string' ? o.text : '',
      days,
      // Half a range is no range: one end alone cannot say when it applies.
      from: from && to ? from : '',
      to: from && to ? to : '',
      dayOff: o.dayOff === 'exclude' || o.dayOff === 'only' ? o.dayOff : 'any',
    });
    if (rules.length >= MAX_ADMIN_NOTE_RULES) break;
  }
  const daysOff: string[] = [];
  for (const d of Array.isArray(r.daysOff) ? r.daysOff : []) {
    const n = normaliseDayOff(d);
    if (n && !daysOff.includes(n)) daysOff.push(n);
  }
  daysOff.sort();
  return { enabled: r.enabled === true, rules, daysOff };
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function ruleFits(rule: AdminNoteRule, at: Date, daysOff: string[]): boolean {
  const anyDay = rule.days.every(Boolean) || !rule.days.some(Boolean);
  if (!anyDay && !rule.days[at.getDay()]) return false;
  if (rule.from && rule.to) {
    const now = at.getHours() * 60 + at.getMinutes();
    const a = minutes(rule.from), b = minutes(rule.to);
    const inside = a <= b ? now >= a && now <= b : now >= a || now <= b;
    if (!inside) return false;
  }
  if (rule.dayOff !== 'any') {
    const off = daysOff.includes(dateKey(at));
    if (rule.dayOff === 'exclude' && off) return false;
    if (rule.dayOff === 'only' && !off) return false;
  }
  return true;
}

/**
 * The one note for this moment, or ''. Rules with an empty text are skipped
 * rather than matched: a blank first row must not silence the rows under it.
 */
export function pickAdminNote(config: AdminNotesConfig, now: number): string {
  if (!config.enabled) return '';
  const at = new Date(now);
  for (const rule of config.rules) {
    const text = rule.text.trim();
    if (!text) continue;
    if (ruleFits(rule, at, config.daysOff)) return text;
  }
  return '';
}

/**
 * The wake text with the note under it. No note → the text unchanged, byte for byte.
 *
 * NO HEADING (つよ / トカゲくん, 2026-11-28). The note used to sit under the
 * line "A note from the administrator:", which put a rank between a being and
 * the partner who wrote it, on every autonomous turn. It is now simply the
 * continuation of the [MEMORHIZA] text: one blank line, then the note. Who
 * wrote it is not named. `lang` is kept so callers do not change; nothing here
 * depends on it any more.
 */
export function appendAdminNote(full: string, note: string, _lang?: 'ja' | 'en'): string {
  const n = note.trim();
  if (!n) return full;
  return `${full.replace(/\s+$/, '')}\n\n${n}`;
}
