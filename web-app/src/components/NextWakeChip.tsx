'use client';

// Beside the conversation title:
//   · the next wake (トカゲくん 2026-11-20) — one time only, the sooner of the
//     admin schedule and the being's own booking (lib/wakeSchedule.ts → nextWake);
//   · how long automatic turns still wait (トカゲくん 2026-11-28) — the minimum
//     interval between automatic turns (lib/autoGap.ts).
// Details live in the hover tips. Renders nothing when neither applies.

import { useEffect, useState } from 'react';
import { AlarmClock, Hourglass } from 'lucide-react';
import { useT } from '@/lib/i18n';

type Slot = { at: number; hhmm: string };
type NextWake = { next: (Slot & { kind: 'admin' | 'self' }) | null; admin: Slot | null; self: Slot | null };
/** `readyAt` is on THIS browser's clock (now + the server's remaining ms), so a phone whose clock differs still counts down right. */
type Gap = { minGapMin: number; readyAt: number };

/** Same refresh pace as Preferences → Runner. */
const REFRESH_MS = 30_000;

function when(at: number): string {
  const d = new Date(at);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const today = new Date();
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay ? hhmm : `${d.getMonth() + 1}/${d.getDate()} ${hhmm}`;
}

export default function NextWakeChip({ folderName }: { folderName: string }) {
  const t = useT();
  const [data, setData] = useState<NextWake | null>(null);
  const [gap, setGap] = useState<Gap | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!folderName) return;
    let dead = false;
    const load = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      try {
        const r = await fetch(`/api/wake?folder=${encodeURIComponent(folderName)}`, { cache: 'no-store' });
        if (!r.ok) return;
        const j = await r.json();
        if (dead) return;
        setData(j?.nextWake ?? null);
        const g = j?.autoGap;
        setGap(g && typeof g.remainingMs === 'number' && g.remainingMs > 0 && typeof g.minGapMin === 'number'
          ? { minGapMin: g.minGapMin, readyAt: Date.now() + g.remainingMs }
          : null);
        setNow(Date.now());
      } catch { /* a missed refresh just keeps the last reading */ }
    };
    void load();
    const id = setInterval(load, REFRESH_MS);
    // The countdown moves between refreshes.
    const tick = setInterval(() => setNow(Date.now()), 10_000);
    const onVis = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { dead = true; clearInterval(id); clearInterval(tick); document.removeEventListener('visibilitychange', onVis); };
  }, [folderName]);

  const next = data?.next;
  const waiting = gap && gap.readyAt > now ? gap : null;
  if (!next && !waiting) return null;
  const lines = next ? [
    t('chat.nextWake.tipTitle'),
    `${t('chat.nextWake.admin')}: ${data!.admin ? when(data!.admin.at) : t('chat.nextWake.none')}`,
    `${t('chat.nextWake.self')}: ${data!.self ? when(data!.self.at) : t('chat.nextWake.none')}`,
    t('chat.nextWake.tipNote'),
  ] : [];
  return (
    <>
      {next && (
        <span
          className="shrink-0 inline-flex items-center gap-1 text-xs font-normal tabular-nums text-indigo-400"
          title={lines.join('\n')}
        >
          <AlarmClock size={12} />
          {when(next.at)}
          {next.kind === 'self' && <span className="opacity-70">*</span>}
        </span>
      )}
      {waiting && (
        <span
          className="shrink-0 inline-flex items-center gap-1 text-xs font-normal tabular-nums text-amber-500"
          title={t('chat.nextWake.gapTip').replace('{at}', when(waiting.readyAt)).replace('{gap}', String(waiting.minGapMin))}
        >
          <Hourglass size={12} />
          {t('chat.nextWake.gapMin').replace('{n}', String(Math.max(1, Math.ceil((waiting.readyAt - now) / 60_000))))}
        </span>
      )}
    </>
  );
}
