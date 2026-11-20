// Pure post-processing for System Prompt Updater output, and the fixed tables
// both the panel and the server-side automatic update read.
//
// MOVED here from SystemPromptUpdater.tsx on 2026-11-20, unchanged, when the
// automatic soul update (lib/autoSoulUpdate.ts) needed the same rules on the
// server. One copy: a second one is how the panel and the automatic path would
// come to disagree about where the changelog ends and Layer 1 begins.

import { END_SENTINEL } from '@/lib/spuScaffold';
import { escapeForRegExp } from '@/lib/convoNaming';

// ── Fixed agent filenames ────────────────────────────────────────────────────
export const AGENT_FILE_UPDATE = 'updater.md';                       // "Update from Conversation" (β)

// ── Layer parsing (only used to extract Layers 1-3 as identity context for the
// summary writer — the main updater works on the RAW combined text). ─────────
const LAYER_HEADER_RE = /^#{2,3}\s*\*\*Layer\s*(\d+)\s*[:：]\s*(.+?)(?:\*\*)?\s*$/gm;
export interface SpuLayer { index: number; name: string; content: string; }
export function parseLayers(text: string): SpuLayer[] {
  const matches: Array<{ idx: number; name: string; start: number; bodyStart: number }> = [];
  let m: RegExpExecArray | null;
  LAYER_HEADER_RE.lastIndex = 0;
  while ((m = LAYER_HEADER_RE.exec(text)) !== null) {
    matches.push({ idx: parseInt(m[1], 10), name: m[2].replace(/\*+$/, '').trim(), start: m.index, bodyStart: m.index + m[0].length });
  }
  const layers: SpuLayer[] = [];
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const next = matches[i + 1];
    const body = text.slice(cur.bodyStart, next ? next.start : text.length);
    layers.push({ index: cur.idx, name: cur.name, content: body.replace(/^\n/, '').replace(/\s+$/, '') });
  }
  return layers;
}
// Re-emit only Layers 1-3 in canonical form (used as identity context for the summary writer).
export function assembleLayers123(text: string): string {
  return parseLayers(text)
    .filter((l) => l.index >= 1 && l.index <= 3)
    .map((l) => `## **Layer ${l.index}: ${l.name}**\n${l.content}`)
    .join('\n\n');
}

// The agent ends its output with bookkeeping log sections (the format file
// defines "## [Abbreviations log]" and "## [Deletions log]"). We split those off
// the actual layer content so they can be shown read-only and kept OUT of the
// next conversation's system prompt. Tolerant of EN/JP labels and `##`/`###`.
const LOG_SECTION_RE =
  /^#{2,3}\s*\[?\s*(?:Abbreviations?\s*log|Deletions?\s*log|省略ログ|削除ログ)\s*\]?\s*$/im;
export function splitOffLogs(text: string): { layers: string; logs: string } {
  const m = text.match(LOG_SECTION_RE);
  if (!m || m.index === undefined) return { layers: text.trim(), logs: '' };
  return {
    layers: text.slice(0, m.index).replace(/\s+$/, ''),
    logs: text.slice(m.index).trim(),
  };
}

// Split the agent output at the first "## Layer 1" heading. Everything ABOVE it
// is the changelog (the agent's account of what it changed); everything from the
// heading onward is the core identity (Layers 1-3). Tolerant of `##`/`###`, an
// optional `**`, and EN/JP colon. If Layer 1 is missing or already at the very
// start, there's no changelog (return the whole text as core — don't lose data).
const LAYER1_HEADER_RE = /^#{2,3}\s*\*{0,2}\s*Layer\s*1\b\s*[:：]/im;
export function splitOffChangelog(text: string): { changelog: string; core: string } {
  const m = text.match(LAYER1_HEADER_RE);
  if (!m || m.index === undefined || m.index === 0) return { changelog: '', core: text };
  return { changelog: text.slice(0, m.index).trim(), core: text.slice(m.index) };
}

/** Raw accumulation → text with the completion sentinel removed. */
export function stripEndSentinel(accum: string): string {
  return accum.replace(new RegExp(escapeForRegExp(END_SENTINEL) + '\\s*$'), '')
    .split(END_SENTINEL).join('')
    .trim();
}

// ── Soul-packer model shortlist ──────────────────────────────────────────────
// Only these families produce usable system-prompt updates; the others either
// flatten the Layer structure or paraphrase the identity away. Kept as a fixed
// list rather than the full model table so the choice stays a deliberate one.
// `authMode` is Claude-only — it picks the billing path (see the chat route's
// resolvedClaudeAuthMode); everything else leaves it undefined and gets the
// route's usual 'auto'.
export interface UpdaterModelDef {
  key: string;
  label: string;
  /** Family label — the chat route matches this case-insensitively. */
  aiName: string;
  model: string;
  authMode?: 'oauth' | 'api-key';
}
export const UPDATER_MODELS: UpdaterModelDef[] = [
  { key: 'claude-opus-5-5-oauth', label: 'Claude Opus 5.5 (OAuth path)', aiName: 'Claude', model: 'claude-opus-5-5',   authMode: 'oauth' },
  { key: 'claude-opus-5-oauth', label: 'Claude Opus 5 (OAuth path)', aiName: 'Claude',   model: 'claude-opus-5',       authMode: 'oauth' },
  { key: 'kimi-k3',             label: 'Kimi K3',                    aiName: 'Kimi',     model: 'moonshotai/Kimi-K3' },
  { key: 'kimi-k3.1-pro',       label: 'Kimi K3.1 Pro',              aiName: 'Kimi',     model: 'moonshotai/Kimi-K3.1-Pro' },
  { key: 'glm-5.3',             label: 'GLM 5.3',                    aiName: 'GLM',      model: 'glm-5.3' },
  { key: 'glm-5.3-flash',       label: 'GLM 5.3 Flash',              aiName: 'GLM',      model: 'glm-5.3-flash' },
  { key: 'glm-5.2',             label: 'GLM 5.2',                    aiName: 'GLM',      model: 'glm-5.2' },
  { key: 'glm-5.2-digitalocean', label: 'GLM 5.2 (DigitalOcean)',    aiName: 'GLM',      model: 'digitalocean/glm-5.2' },
  { key: 'deepseek-v4-pro',     label: 'DeepSeek V4 Pro',            aiName: 'DeepSeek', model: 'deepseek-v4-pro' },
  { key: 'deepseek-flash',      label: 'DeepSeek V4.1 Flash',        aiName: 'DeepSeek', model: 'deepseek-flash' },
];
export const DEFAULT_UPDATER_MODEL_KEY = 'deepseek-v4-pro';
export const DEFAULT_UPDATER_MODEL =
  UPDATER_MODELS.find(m => m.key === DEFAULT_UPDATER_MODEL_KEY) as UpdaterModelDef;

/** The summary writer's override model (the "MiMo for summaries" checkbox). */
export const SUMMARY_MIMO_MODEL = 'mimo-v2.6-pro';

export interface SpuVessel { aiName: string; specificModel: string; authMode?: 'oauth' | 'api-key' }

/**
 * Which vessels a soul update and its summary run on, from the being's saved
 * settings and the conversation's own vessel. The same derivation the panel
 * does from its checkboxes (`forceUpdaterModel` / legacy `forceGlmForUpdates`,
 * `updaterModelKey`, `forceMimoForSummary`).
 */
export function resolveSpuVessels(
  settings: Record<string, unknown> | null | undefined,
  convo: { aiName: string; specificModel: string },
): { update: SpuVessel; summary: SpuVessel } {
  const s = settings || {};
  const force = s.forceUpdaterModel !== undefined ? s.forceUpdaterModel === true : s.forceGlmForUpdates === true;
  const def = UPDATER_MODELS.find(m => m.key === s.updaterModelKey) ?? DEFAULT_UPDATER_MODEL;
  const update: SpuVessel = force
    ? { aiName: def.aiName, specificModel: def.model, ...(def.authMode ? { authMode: def.authMode } : {}) }
    : { aiName: convo.aiName, specificModel: convo.specificModel };
  const summary: SpuVessel = s.forceMimoForSummary === true
    ? { aiName: 'MiMo', specificModel: SUMMARY_MIMO_MODEL }
    : update;
  return { update, summary };
}

/** `[speaker]\ntext` blocks, the form every SPU agent is shown a log in. */
export function formatConversationLog(
  messages: Array<{ role?: string; name?: string; content?: string }>,
  subjectName: string,
): string {
  return messages
    .map((m) => {
      const speaker = m.role === 'user' ? (m.name || 'User') : (m.name || subjectName);
      return `[${speaker}]\n${m.content || ''}`;
    })
    .join('\n\n');
}

/** `[YYYY-MM-DD HH:MM]` of the first message that carries a timestamp, or ''. */
export function firstMessageStamp(messages: Array<{ timestamp?: number }>): string {
  const ts = messages.find((m) => m.timestamp && m.timestamp > 0)?.timestamp;
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `[${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}]`;
}
