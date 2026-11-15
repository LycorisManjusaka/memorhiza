// Who a `[->name]` can address — kept apart from lib/beingRouteExec.ts so the
// chat route (which only needs the list for the note) does not pull the wake
// clock and the queue in with it.

import { promises as fsp } from 'fs';
import { listFolders } from '@/lib/fsStorage';
import { beingSettingsFile } from '@/lib/beingPaths';

/**
 * The names a being can address: every being of this NEXUS with a
 * settings.json, except itself. Whether one of them can RECEIVE right now
 * (a living conversation) is decided at send time and reported if not.
 */
export async function routableBeingNames(self: string): Promise<string[]> {
  const folders = await listFolders() as Array<{ name: string }>;
  const out: string[] = [];
  for (const f of folders) {
    if (f.name === self) continue;
    try { await fsp.stat(beingSettingsFile(f.name)); out.push(f.name); } catch { /* mail-only */ }
  }
  return out.sort((a, b) => a.localeCompare(b));
}
