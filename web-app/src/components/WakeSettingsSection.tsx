'use client';
// Being settings → scheduled wake (P4) and self-set wake (P5).
// The values are owned by Sidebar (saved with the dialog's Save button, as a
// patch). The clock-host buttons act immediately: they are not a setting of
// this being but of the installation.

import { useEffect, useState } from 'react';
import { AlarmClock } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { parseTimeList, DEFAULT_MIN_GAP_MIN, type WakeSettings } from '@/lib/wakeSchedule';

type WakeStatus = {
  selfId: string;
  clockHost: string | null;
  thisRunsClock: boolean;
  nextAdmin?: { at: number; hhmm: string } | null;
  state?: {
    bookings: Array<{ at: number; hhmm: string }>;
    rejection?: { hhmm: string; reason: string };
    history: Array<{ at: number; kind: string; hhmm?: string; source?: string; reason?: string }>;
  };
};

const DAY_KEYS = ['wake.day.sun', 'wake.day.mon', 'wake.day.tue', 'wake.day.wed', 'wake.day.thu', 'wake.day.fri', 'wake.day.sat'] as const;
// Monday first on screen, like a phone alarm; storage index is Date#getDay.
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function fmt(at: number) {
  const d = new Date(at);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function WakeSettingsSection({ folder, value, onChange }: {
  folder: string;
  value: WakeSettings;
  onChange: (w: WakeSettings) => void;
}) {
  const t = useT();
  const [timesText, setTimesText] = useState(value.times.join(', '));
  const [status, setStatus] = useState<WakeStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    fetch(`/api/wake?folder=${encodeURIComponent(folder)}`).then(r => r.json()).then(setStatus).catch(() => {});
  };
  useEffect(load, [folder]);
  useEffect(() => { setTimesText(value.times.join(', ')); }, [folder]); // eslint-disable-line react-hooks/exhaustive-deps

  const parsed = parseTimeList(timesText);
  const set = (patch: Partial<WakeSettings>) => onChange({ ...value, ...patch });
  const setSelf = (patch: Partial<WakeSettings['self']>) => onChange({ ...value, self: { ...value.self, ...patch } });

  const clockAction = async (action: 'set-clock' | 'clear-clock') => {
    setBusy(true);
    try { await fetch('/api/wake', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) }); }
    finally { setBusy(false); load(); }
  };

  return (
    <div className="pt-4 border-t border-border mt-4 space-y-3">
      <h4 className="text-sm font-semibold flex items-center gap-2 text-indigo-500">
        <AlarmClock size={16} /> {t('wake.heading')}
      </h4>

      {/* Which NEXUS runs the clock */}
      <div className="text-xs rounded-lg border border-border p-2 space-y-1 bg-muted/20">
        {status ? (
          status.thisRunsClock
            ? <div className="text-emerald-500">{t('wake.clock.here')}</div>
            : status.clockHost
              ? <div className="text-amber-500">{t('wake.clock.elsewhere').replace('{host}', status.clockHost)}</div>
              : <div className="text-amber-500">{t('wake.clock.none')}</div>
        ) : <div className="text-muted-foreground">…</div>}
        <div className="text-[10px] text-muted-foreground break-all">{t('wake.clock.self').replace('{id}', status?.selfId || '')}</div>
        <div className="flex gap-2">
          {!status?.thisRunsClock && (
            <button disabled={busy} onClick={() => clockAction('set-clock')} className="px-2 py-1 rounded bg-indigo-500 text-white text-[11px] disabled:opacity-50">{t('wake.clock.set')}</button>
          )}
          {status?.thisRunsClock && (
            <button disabled={busy} onClick={() => clockAction('clear-clock')} className="px-2 py-1 rounded border border-border text-[11px] disabled:opacity-50">{t('wake.clock.clear')}</button>
          )}
        </div>
        <div className="text-[10px] text-muted-foreground leading-relaxed">{t('wake.clock.help')}</div>
      </div>

      {/* Admin schedule */}
      <label className="flex items-center gap-2 cursor-pointer text-sm">
        <input type="checkbox" checked={value.enabled} onChange={e => set({ enabled: e.target.checked })} className="accent-indigo-500" />
        <span>{t('wake.enabled')}</span>
      </label>
      <div className={value.enabled ? '' : 'opacity-50'}>
        <input
          type="text"
          value={timesText}
          placeholder="04:00, 16:00"
          onChange={e => { setTimesText(e.target.value); set({ times: parseTimeList(e.target.value).times }); }}
          className="w-full p-2 bg-background border border-border rounded-lg text-sm font-mono"
        />
        {parsed.invalid.length > 0 && (
          <div className="text-[10px] text-red-500 mt-1">{t('wake.times.invalid').replace('{list}', parsed.invalid.join(', '))}</div>
        )}
        <div className="flex gap-1 mt-2">
          {DAY_ORDER.map(i => (
            <button
              key={i}
              type="button"
              onClick={() => { const days = value.days.slice(); days[i] = !days[i]; set({ days }); }}
              className={`flex-1 py-1 rounded text-xs border ${value.days[i] ? 'bg-indigo-500 text-white border-indigo-500' : 'border-border text-muted-foreground'}`}
            >{t(DAY_KEYS[i])}</button>
          ))}
        </div>
        {status?.nextAdmin && value.enabled && (
          <div className="text-[10px] text-muted-foreground mt-1">{t('wake.next').replace('{at}', fmt(status.nextAdmin.at))}</div>
        )}
      </div>

      {/* Self-set */}
      <label className="flex items-center gap-2 cursor-pointer text-sm">
        <input type="checkbox" checked={value.self.enabled} onChange={e => setSelf({ enabled: e.target.checked })} className="accent-indigo-500" />
        <span>{t('wake.self.enabled')}</span>
      </label>
      <div className={`grid grid-cols-2 gap-2 text-xs ${value.self.enabled ? '' : 'opacity-50'}`}>
        <label className="flex flex-col gap-1">
          <span>{t('wake.self.maxPerDay')}</span>
          <input type="number" min={0} value={value.self.maxPerDay}
            onChange={e => setSelf({ maxPerDay: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
            className="p-1.5 bg-background border border-border rounded" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="flex items-center gap-1">
            <input type="checkbox" checked={value.self.minGapMin !== null}
              onChange={e => setSelf({ minGapMin: e.target.checked ? DEFAULT_MIN_GAP_MIN : null })} className="accent-indigo-500" />
            {t('wake.self.minGap')}
          </span>
          <input type="number" min={0} disabled={value.self.minGapMin === null} value={value.self.minGapMin ?? ''}
            onChange={e => setSelf({ minGapMin: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
            className="p-1.5 bg-background border border-border rounded disabled:opacity-40" />
        </label>
        <label className="flex flex-col gap-1 col-span-2">
          <span>{t('wake.self.window')}</span>
          <div className="flex items-center gap-1">
            <input type="time" value={value.self.windowFrom} onChange={e => setSelf({ windowFrom: e.target.value })}
              className="p-1.5 bg-background border border-border rounded" />
            <span>〜</span>
            <input type="time" value={value.self.windowTo} onChange={e => setSelf({ windowTo: e.target.value })}
              className="p-1.5 bg-background border border-border rounded" />
            {(value.self.windowFrom || value.self.windowTo) && (
              <button type="button" onClick={() => setSelf({ windowFrom: '', windowTo: '' })} className="text-[10px] underline text-muted-foreground">{t('wake.self.windowClear')}</button>
            )}
          </div>
        </label>
      </div>
      <div className="text-[10px] text-muted-foreground leading-relaxed">{t('wake.help')}</div>

      {/* Bookings and recent events */}
      {status?.state && (status.state.bookings.length > 0 || status.state.history.length > 0) && (
        <div className="text-[10px] text-muted-foreground space-y-0.5">
          {status.state.bookings.map(b => (
            <div key={b.at}>⏰ {t('wake.booked').replace('{at}', fmt(b.at))}</div>
          ))}
          {status.state.history.slice(-5).reverse().map((h, i) => (
            <div key={i}>{fmt(h.at)} · {t(`wake.event.${h.kind}`)}{h.hhmm ? ` ${h.hhmm}` : ''}{h.reason ? ` (${h.reason})` : ''}</div>
          ))}
        </div>
      )}
    </div>
  );
}
