'use client';

// The next wake, beside the conversation title (トカゲくん 2026-11-20).
// One time only — the sooner of the admin schedule and the being's own
// booking (lib/wakeSchedule.ts → nextWake). Details live in the hover tip.
// Renders nothing when no clock time is coming.

import { useEffect, useState } from 'react';
import { AlarmClock } from 'lucide-react';
import { useT } from '@/lib/i18n';

type Slot = { at: number; hhmm: string };
type NextWake = { next: (Slot & { kind: 'admin' | 'self' }) | null; admin: Slot | null; self: Slot | null };

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

  useEffect(() => {
    if (!folderName) return;
    let dead = false;
    const load = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      try {
        const r = await fetch(`/api/wake?folder=${encodeURIComponent(folderName)}`, { cache: 'no-store' });
        if (!r.ok) return;
        const j = await r.json();
        if (!dead) setData(j?.nextWake ?? null);
      } catch { /* a missed refresh just keeps the last reading */ }
    };
    void load();
    const id = setInterval(load, REFRESH_MS);
    const onVis = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { dead = true; clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [folderName]);

  const next = data?.next;
  if (!next) return null;
  const lines = [
    t('chat.nextWake.tipTitle'),
    `${t('chat.nextWake.admin')}: ${data!.admin ? when(data!.admin.at) : t('chat.nextWake.none')}`,
    `${t('chat.nextWake.self')}: ${data!.self ? when(data!.self.at) : t('chat.nextWake.none')}`,
    t('chat.nextWake.tipNote'),
  ];
  return (
    <span
      className="shrink-0 inline-flex items-center gap-1 text-xs font-normal tabular-nums text-indigo-400"
      title={lines.join('\n')}
    >
      <AlarmClock size={12} />
      {when(next.at)}
      {next.kind === 'self' && <span className="opacity-70">*</span>}
    </span>
  );
}
