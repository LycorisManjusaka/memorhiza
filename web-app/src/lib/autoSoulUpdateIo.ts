// The real disk half of the automatic soul update (lib/autoSoulUpdate.ts).
// Kept apart so the rules can be tested against an in-memory `AutoSoulIo`.
// The model call (`runSpu`) is supplied by the route — it needs the chat
// route, which cannot load outside Next's runtime.

import path from 'path';
import { promises as fs } from 'fs';
import { loadLog, saveLog, listLogs, listFolders, writeBeingSettings, readEntityFooter } from '@/lib/fsStorage';
import { beingSoulDir } from '@/lib/beingPaths';
import {
  readSystemPromptFile, readSpuWorkFile, writeSystemPromptFile, backupSoulSnapshot,
  readAllAgentFiles, readSummaryAgent, extractAgentSystemPrompt, readDeletionPatterns,
  applyDeletionPatterns, clearSpuRunRecord,
} from '@/lib/systemPromptStorage';
import { buildLayer4IndexBody } from '@/lib/layer4Index';
import { writeSummary } from '@/lib/summaryStorage';
import { writeChangelog } from '@/lib/changelogStorage';
import type { AutoSoulIo, AutoSoulResult } from '@/lib/autoSoulUpdate';

export function realAutoSoulIo(runSpu: AutoSoulIo['runSpu']): AutoSoulIo {
  return {
    loadLog: async (id) => (await loadLog(id)) as Record<string, unknown> | null,
    saveLog: async (id, log) => saveLog(id, log),
    listConversations: async (being) =>
      (await listLogs() as Array<{ id: string; title?: string; folderName?: string }>)
        .filter((l) => l.folderName === being)
        .map((l) => ({ id: l.id, title: String(l.title || '') })),
    beingSettings: async (being) =>
      ((await listFolders() as Array<{ name: string; settings?: Record<string, unknown> }>)
        .find((f) => f.name === being)?.settings) || {},
    patchBeingSettings: (being, patch) => writeBeingSettings(being, { patch }),
    readSoul: readSystemPromptFile,
    readWork: readSpuWorkFile,
    writeSoul: writeSystemPromptFile,
    backupSoul: backupSoulSnapshot,
    agentPrompt: async (lang, file) => {
      const f = (await readAllAgentFiles(lang)).find((x) => x.name === file);
      return f ? extractAgentSystemPrompt(f.content) : null;
    },
    summaryAgentPrompt: async (lang) => {
      const raw = await readSummaryAgent(lang);
      return raw ? extractAgentSystemPrompt(raw) : null;
    },
    deletionPatterns: readDeletionPatterns,
    applyDeletions: applyDeletionPatterns,
    footer: async (being) => (await readEntityFooter(being)) || '',
    layer4Index: (being, currentConvoId, lang) => buildLayer4IndexBody({ folderName: being, currentConvoId, lang }),
    writeSummary,
    writeChangelog,
    clearRunRecord: clearSpuRunRecord,
    runSpu,
    newId: () => crypto.randomUUID(),
  };
}

// ── The last automatic update's outcome, for whoever looks next ─────────────
// Nobody is watching an automatic update, and a failed one changes nothing a
// person can see: the messages simply stay in the stock. So the outcome is
// written beside the soul's working files, and the stock panel reads it.
// A success overwrites a failure; the file is never needed for correctness.

export interface AutoSoulStatus {
  at: number;
  convoId: string;
  ok: boolean;
  stage?: string;
  reason?: string;
  retried?: boolean;
  newConvoId?: string;
  newTitle?: string;
  /**
   * On a failure: the stock items that were waiting when it failed. The same
   * items do not start another attempt (the clock re-kicks a waiting wake
   * every cycle — that would be a retry every 30 seconds, each one a full
   * soul update). Only an item that is NOT in this list is a new reason.
   */
  waitingIds?: string[];
}

function statusFile(being: string): string {
  return path.join(beingSoulDir(being), 'spu_work', '_auto_update_status.json');
}

export async function writeAutoSoulStatus(being: string, convoId: string, r: AutoSoulResult, nowMs: number, waitingIds: string[] = []): Promise<void> {
  const s: AutoSoulStatus = r.ok
    ? { at: nowMs, convoId, ok: true, retried: r.retried, newConvoId: r.newConvoId, newTitle: r.newTitle }
    : { at: nowMs, convoId, ok: false, stage: r.stage, reason: r.reason, retried: r.retried, waitingIds };
  try {
    const p = statusFile(being);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(s, null, 2), 'utf-8');
  } catch { /* a note for a person; never worth failing over */ }
}

export async function readAutoSoulStatus(being: string): Promise<AutoSoulStatus | null> {
  try {
    const s = JSON.parse(await fs.readFile(statusFile(being), 'utf-8'));
    return s && typeof s === 'object' && typeof s.at === 'number' ? (s as AutoSoulStatus) : null;
  } catch {
    return null;
  }
}

/**
 * After a failed automatic update: is anything waiting that was NOT there when
 * it failed? Pure. No earlier failure for this conversation → everything is new.
 */
export function hasNewReason(status: AutoSoulStatus | null, convoId: string, waitingNow: string[]): boolean {
  if (waitingNow.length === 0) return false;
  if (!status || status.ok || status.convoId !== convoId) return true;
  const seen = new Set(status.waitingIds || []);
  return waitingNow.some((id) => !seen.has(id));
}
