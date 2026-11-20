// While a soul update (a shikigami run) is in flight, the being takes no turn
// at all (トカゲくん, 2026-11-20). Everything that would start one — a person's
// send, the clock, a letter, the stock, another being's `[->name]`, ζ — waits
// in the stock, and runs once the run is over.
//
// The line is the RUN, not the soul: a finished update whose new soul has not
// been written yet holds nothing. That state is the human's to resolve, and
// turns keep moving through it exactly as before.
//
// "Running" means the record on disk says so AND the process that wrote it is
// still alive. A crash leaves `running` behind; trusting that alone would stop
// the being forever. Records written before `pid` existed hold nothing — the
// same refusal-to-guess as the queue lease (turnQueue.holderIsGone).

import { listSpuRunRecords } from '@/lib/systemPromptStorage';
import { holderIsGone } from '@/lib/turnQueue';
import { liveTurnStatus } from '@/lib/turnBus';
import { spuRelayKey } from '@/lib/spuRun';

export interface SoulUpdateRun {
  label: string;
  action: string;
  host: string;
  startedAt: number;
}

export interface RunLiveness {
  /** True when `pid` names no process on this machine. */
  isGone: (pid: number) => boolean;
  selfPid: number;
  /** For a run in THIS process: is its relay still live? */
  liveHere: (label: string) => boolean;
}

/** Pure: does one record hold the being's turns? */
export function runRecordHolds(rec: unknown, live: RunLiveness): SoulUpdateRun | null {
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as Record<string, unknown>;
  if (r.status !== 'running') return null;
  const pid = r.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  const label = typeof r.label === 'string' ? r.label : '';
  if (pid === live.selfPid) {
    // Same process: the pid is alive by definition, so ask the relay instead.
    // A run that threw past its own record write leaves `running` with our pid.
    if (!live.liveHere(label)) return null;
  } else if (live.isGone(pid)) {
    return null;
  }
  return {
    label,
    action: typeof r.action === 'string' ? r.action : '',
    host: typeof r.host === 'string' ? r.host : '',
    startedAt: typeof r.startedAt === 'number' ? r.startedAt : 0,
  };
}

/** The soul update holding this being's turns right now, or null. */
export async function soulUpdateRunning(folder: string): Promise<SoulUpdateRun | null> {
  if (!folder) return null;
  let recs: unknown[];
  try {
    recs = await listSpuRunRecords(folder);
  } catch {
    return null;   // an unreadable folder must not stop the being
  }
  const live: RunLiveness = {
    isGone: holderIsGone,
    selfPid: process.pid,
    liveHere: (label) => liveTurnStatus(spuRelayKey(folder, label))?.live === true,
  };
  for (const rec of recs) {
    const hit = runRecordHolds(rec, live);
    if (hit) return hit;
  }
  return null;
}
