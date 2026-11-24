// Disk side of lib/wakeAdminNotes.ts: one file for the whole NEXUS,
// local_data/wake/admin_notes.json. Read fresh at every wake turn — it is tiny,
// and an edit in Preferences must reach the next wake without a restart.

import fs from 'fs/promises';
import path from 'path';
import { DATA_DIR } from '@/lib/beingPaths';
import { atomicWriteFile } from '@/lib/atomicWrite';
import { parseAdminNotes, pickAdminNote, type AdminNotesConfig } from '@/lib/wakeAdminNotes';

const FILE = 'admin_notes.json';

function file(dataDir: string) {
  return path.join(dataDir, 'wake', FILE);
}

export async function readAdminNotes(dataDir = DATA_DIR): Promise<AdminNotesConfig> {
  try {
    return parseAdminNotes(JSON.parse(await fs.readFile(file(dataDir), 'utf-8')));
  } catch {
    return parseAdminNotes(null);
  }
}

export async function writeAdminNotes(raw: unknown, dataDir = DATA_DIR): Promise<AdminNotesConfig> {
  const clean = parseAdminNotes(raw);
  await fs.mkdir(path.dirname(file(dataDir)), { recursive: true });
  await atomicWriteFile(file(dataDir), JSON.stringify(clean, null, 2));
  return clean;
}

/** The note for a wake turn starting at `now`, or ''. Never throws: a broken file adds nothing. */
export async function adminNoteAt(now: number, dataDir = DATA_DIR): Promise<string> {
  try {
    return pickAdminNote(await readAdminNotes(dataDir), now);
  } catch {
    return '';
  }
}
