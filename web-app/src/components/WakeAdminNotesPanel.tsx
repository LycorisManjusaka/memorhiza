'use client';

import React from 'react';
import { ArrowDown, ArrowUp, Loader2, Plus, Trash2 } from 'lucide-react';
import { useT } from '@/lib/i18n';
import {
  parseAdminNotes, parseDaysOff, pickAdminNote, MAX_ADMIN_NOTE_RULES,
  type AdminNotesConfig, type AdminNoteRule, type DayOffMode,
} from '@/lib/wakeAdminNotes';

// Preferences → Runner: the administrator's conditional notes for wake turns.
// Rules: lib/wakeAdminNotes.ts. A closed <details> until someone opens it, so
// a NEXUS that never uses this shows one line.

const BLANK: AdminNoteRule = { text: '', days: [false, false, false, false, false, false, false], from: '', to: '', dayOff: 'any' };

export default function WakeAdminNotesPanel() {
  const t = useT();
  const [cfg, setCfg] = React.useState<AdminNotesConfig | null>(null);
  const [daysOffText, setDaysOffText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState<{ text: string; error?: boolean } | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const loaded = React.useRef(false);
  const dayNames = t('settings.wakeList.dayNames').split(',');

  const load = async () => {
    try {
      const r = await fetch('/api/wake?notes=1');
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`);
      const c = parseAdminNotes(d.notes);
      setCfg(c);
      setDaysOffText(c.daysOff.join('\n'));
      setDirty(false);
    } catch (e: unknown) {
      setNote({ text: e instanceof Error ? e.message : String(e), error: true });
    }
  };

  const edit = (fn: (c: AdminNotesConfig) => AdminNotesConfig) => {
    setCfg(c => (c ? fn(c) : c));
    setDirty(true);
    setNote(null);
  };
  const editRule = (i: number, patch: Partial<AdminNoteRule>) =>
    edit(c => ({ ...c, rules: c.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const move = (i: number, by: number) => edit(c => {
    const j = i + by;
    if (j < 0 || j >= c.rules.length) return c;
    const rules = [...c.rules];
    [rules[i], rules[j]] = [rules[j], rules[i]];
    return { ...c, rules };
  });

  const parsedDays = parseDaysOff(daysOffText);

  // Saves read the newest state through refs, so the debounce below never
  // writes a stale copy. Local state is never rewritten from the answer: a
  // half-typed date or half-typed time range must stay on screen.
  const cfgRef = React.useRef<AdminNotesConfig | null>(null);
  cfgRef.current = cfg;
  const daysOffRef = React.useRef('');
  daysOffRef.current = daysOffText;

  const save = async () => {
    const c = cfgRef.current;
    if (!c) return;
    const days = parseDaysOff(daysOffRef.current).days;
    const sent = parseAdminNotes({ ...c, daysOff: days });
    setBusy(true);
    try {
      const r = await fetch('/api/wake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-notes', notes: { ...c, daysOff: days } }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`);
      // Read back from disk. The POST answer is not evidence that the file
      // changed: a server started before this feature answers 400, and a
      // half-written file would answer ok too.
      const r2 = await fetch('/api/wake?notes=1');
      const d2 = await r2.json();
      if (!r2.ok) throw new Error(d2?.error || `HTTP ${r2.status}`);
      const back = parseAdminNotes(d2.notes);
      if (JSON.stringify(back) !== JSON.stringify(sent)) {
        throw new Error(t('settings.adminNotes.notPersisted'));
      }
      setDirty(false);
      setNote({ text: t('settings.adminNotes.saved') });
    } catch (e: unknown) {
      setNote({ text: `${t('settings.adminNotes.saveFailed')} ${e instanceof Error ? e.message : String(e)}`, error: true });
    } finally {
      setBusy(false);
    }
  };
  const saveRef = React.useRef(save);
  saveRef.current = save;

  // Every other field in this dialog saves as you edit; a button that has to be
  // remembered is how "it never saves" happens. 800 ms after the last keystroke
  // the same save runs. The button stays for an immediate save.
  const dirtyRef = React.useRef(false);
  dirtyRef.current = dirty;
  React.useEffect(() => {
    if (!dirty || !cfg) return;
    const id = setTimeout(() => { void saveRef.current(); }, 800);
    return () => clearTimeout(id);
  }, [cfg, daysOffText, dirty]);
  // Leaving with an unsaved edit must not lose it either.
  React.useEffect(() => () => {
    if (dirtyRef.current) void saveRef.current();
  }, []);

  // What a wake starting this minute would get, from what is on screen (saved or not).
  const nowNote = cfg ? pickAdminNote({ ...cfg, daysOff: parsedDays.days }, Date.now()) : '';

  return (
    <details
      className="border-t border-border pt-4"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open && !loaded.current) { loaded.current = true; void load(); }
      }}
    >
      <summary className="text-sm font-semibold text-indigo-500 cursor-pointer select-none">
        {t('settings.adminNotes.heading')}
      </summary>
      <div className="space-y-3 pt-2 text-xs">
        <p className="text-muted-foreground">{t('settings.adminNotes.help')}</p>
        {!cfg && !note && <Loader2 size={12} className="animate-spin" />}
        {cfg && (
          <>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={cfg.enabled} onChange={e => edit(c => ({ ...c, enabled: e.target.checked }))} />
              <span>{t('settings.adminNotes.enabled')}</span>
            </label>

            {cfg.rules.map((rule, i) => (
              <div key={i} className="border border-border rounded p-2 space-y-2">
                <div className="flex items-center gap-1">
                  <span className="text-muted-foreground flex-1">{t('settings.adminNotes.rule').replace('{n}', String(i + 1))}</span>
                  <button onClick={() => move(i, -1)} disabled={i === 0} title={t('settings.adminNotes.up')}
                    className="p-1 rounded text-muted-foreground hover:text-foreground disabled:opacity-30"><ArrowUp size={12} /></button>
                  <button onClick={() => move(i, 1)} disabled={i === cfg.rules.length - 1} title={t('settings.adminNotes.down')}
                    className="p-1 rounded text-muted-foreground hover:text-foreground disabled:opacity-30"><ArrowDown size={12} /></button>
                  <button onClick={() => edit(c => ({ ...c, rules: c.rules.filter((_, j) => j !== i) }))} title={t('settings.adminNotes.remove')}
                    className="p-1 rounded text-muted-foreground hover:text-destructive"><Trash2 size={12} /></button>
                </div>
                <textarea
                  value={rule.text}
                  onChange={e => editRule(i, { text: e.target.value })}
                  placeholder={t('settings.adminNotes.textPlaceholder')}
                  rows={3}
                  className="w-full bg-background border border-border rounded px-2 py-1 text-xs resize-y"
                />
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <div className="flex items-center gap-1">
                    {dayNames.map((name, d) => (
                      <button
                        key={d}
                        onClick={() => editRule(i, { days: rule.days.map((on, k) => (k === d ? !on : on)) })}
                        className={`w-7 h-6 rounded border text-[11px] transition-colors ${
                          rule.days[d] ? 'border-indigo-500 bg-indigo-500/15 text-foreground' : 'border-border text-muted-foreground hover:bg-muted'
                        }`}
                      >
                        {name}
                      </button>
                    ))}
                    {!rule.days.some(Boolean) && <span className="text-muted-foreground pl-1">{t('settings.adminNotes.anyDay')}</span>}
                  </div>
                  <div className="flex items-center gap-1">
                    <input type="time" value={rule.from} onChange={e => editRule(i, { from: e.target.value })}
                      className="bg-background border border-border rounded px-1 py-0.5" />
                    <span>–</span>
                    <input type="time" value={rule.to} onChange={e => editRule(i, { to: e.target.value })}
                      className="bg-background border border-border rounded px-1 py-0.5" />
                    {!(rule.from && rule.to) && (
                      <span className="text-muted-foreground pl-1">
                        {rule.from || rule.to ? t('settings.adminNotes.halfRange') : t('settings.adminNotes.anyTime')}
                      </span>
                    )}
                  </div>
                  <label className="flex items-center gap-1">
                    <span className="text-muted-foreground">{t('settings.adminNotes.dayOff')}</span>
                    <select value={rule.dayOff} onChange={e => editRule(i, { dayOff: e.target.value as DayOffMode })}
                      className="bg-background border border-border rounded px-1 py-0.5">
                      <option value="any">{t('settings.adminNotes.dayOff.any')}</option>
                      <option value="exclude">{t('settings.adminNotes.dayOff.exclude')}</option>
                      <option value="only">{t('settings.adminNotes.dayOff.only')}</option>
                    </select>
                  </label>
                </div>
              </div>
            ))}

            <button
              onClick={() => edit(c => ({ ...c, rules: [...c.rules, { ...BLANK, days: [...BLANK.days] }] }))}
              disabled={cfg.rules.length >= MAX_ADMIN_NOTE_RULES}
              className="px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted
                         transition-colors disabled:opacity-50 inline-flex items-center gap-1"
            >
              <Plus size={12} /> {t('settings.adminNotes.add')}
            </button>

            <div className="space-y-1">
              <div className="text-muted-foreground">{t('settings.adminNotes.daysOffLabel')}</div>
              <textarea
                value={daysOffText}
                onChange={e => { setDaysOffText(e.target.value); setDirty(true); setNote(null); }}
                placeholder={'2027-01-01\n2027-01-11'}
                rows={3}
                className="w-40 bg-background border border-border rounded px-2 py-1 text-xs font-mono resize-y"
              />
              {parsedDays.invalid.length > 0 && (
                <div className="text-destructive">{t('settings.adminNotes.badDates')} {parsedDays.invalid.join(', ')}</div>
              )}
            </div>

            <div className="text-muted-foreground">
              {t('settings.adminNotes.now')}{' '}
              {nowNote
                ? <span className="text-foreground whitespace-pre-wrap">{nowNote.length > 80 ? `${nowNote.slice(0, 80)}…` : nowNote}</span>
                : <span className="italic">{t('settings.adminNotes.nowNone')}</span>}
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => void save()}
                disabled={busy || !dirty}
                className="px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted
                           transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t('settings.adminNotes.saveNow')}
              </button>
              {busy && <Loader2 size={12} className="animate-spin" />}
              {dirty && !busy && <span className="text-amber-500">{t('settings.adminNotes.unsaved')}</span>}
            </div>
          </>
        )}
        {note && <div className={note.error ? 'text-destructive' : 'text-muted-foreground'}>{note.text}</div>}
      </div>
    </details>
  );
}
