// Automatic soul update (トカゲくん, 2026-11-20) — the last piece of the
// self-started turns: a being that reaches 100% of its log cap sleeps by
// itself. β (update from the conversation) + the summary, with exactly the
// settings the panel would use, then the next conversation is created and
// whatever was waiting in the stock is carried into it.
//
// Off unless the conversation says `autoSoulUpdate: true`.
//
// What this file is NOT: a reviewer. The panel's "Go to Next Conversation" has
// a person reading the right pane first; here nobody reads it. The one guard
// that carries over is the one that does not need a reader — a run that never
// printed the completion sentinel is not written as a soul.
//
// One retry for the whole update (a provider error or a cut-off output). After
// that it stops; the next thing that would start a turn tries again under the
// same rule. Everything touching disk or a model goes through `AutoSoulIo`, so
// the rules here run in a test with no server.

import { END_SENTINEL, buildUpdateUserMsg, buildSummaryUserMsg, defaultSummaryAgentPrompt, type ScaffoldLang } from '@/lib/spuScaffold';
import {
  AGENT_FILE_UPDATE, assembleLayers123, splitOffLogs, splitOffChangelog, stripEndSentinel,
  resolveSpuVessels, formatConversationLog, firstMessageStamp, type SpuVessel,
} from '@/lib/spuPost';
import { resolveSoulGeneration, titleForGeneration } from '@/lib/soulGeneration';
import { makeIsOriginalIndex } from '@/lib/firstOriginal';
import { logContextElapsedPercent } from '@/lib/autoHold';
import type { RunSpuResult } from '@/lib/runSpuAction';

export function autoSoulUpdateEnabled(raw: unknown): boolean {
  return raw === true;
}

/**
 * Is this conversation due to sleep by itself? ON, and the same "context
 * elapsed" the header gauge shows is at 100% or more. A cap of 0 reads as 0%
 * (lib/handoverRestore), so such a conversation is never due.
 */
export function autoSoulUpdateDue(
  log: Record<string, unknown> | null | undefined,
  beingSettings: Record<string, unknown> | null | undefined,
): boolean {
  if (!log || !autoSoulUpdateEnabled(log.autoSoulUpdate)) return false;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const family = str(log.aiName) ?? str(beingSettings?.aiName);
  return logContextElapsedPercent(log, family, beingSettings?.maxConversationLog) >= 100;
}

/** What one SPU call needs; the route wraps runSpuAction (+ relay) behind it. */
export interface AutoSoulSpuCall {
  label: string;
  action: 'update' | 'summary';
  convoId: string;
  userMsg: string;
  agentSystemPrompt: string;
  lang: ScaffoldLang;
  vessel: SpuVessel;
  modelParams: Record<string, unknown>;
  maxContinuations?: number;
}

export interface AutoSoulIo {
  loadLog: (convoId: string) => Promise<Record<string, unknown> | null>;
  saveLog: (convoId: string, log: Record<string, unknown>) => Promise<{ ok: boolean }>;
  /** Every conversation of this being, newest first (id + title). */
  listConversations: (being: string) => Promise<Array<{ id: string; title: string }>>;
  beingSettings: (being: string) => Promise<Record<string, unknown>>;
  patchBeingSettings: (being: string, patch: Record<string, unknown>) => Promise<void>;
  readSoul: (being: string, label: string) => Promise<string | null>;
  /** The panel's left-pane working copy; null when none exists. */
  readWork: (being: string, label: string) => Promise<string | null>;
  writeSoul: (being: string, label: string, text: string) => Promise<unknown>;
  backupSoul: (being: string, fromLabel: string, toLabel: string, phase: 'BEFORE' | 'AFTER', text: string) => Promise<unknown>;
  /** An agent file's instruction part (above its `---`), or null. */
  agentPrompt: (lang: ScaffoldLang, file: string) => Promise<string | null>;
  summaryAgentPrompt: (lang: ScaffoldLang) => Promise<string | null>;
  deletionPatterns: (lang: ScaffoldLang) => Promise<string[]>;
  applyDeletions: (text: string, patterns: string[]) => string;
  footer: (being: string) => Promise<string>;
  layer4Index: (being: string, currentConvoId: string, lang: ScaffoldLang) => Promise<string>;
  writeSummary: (being: string, title: string, content: string) => Promise<unknown>;
  writeChangelog: (being: string, title: string, content: string) => Promise<unknown>;
  clearRunRecord: (being: string, label: string) => Promise<unknown>;
  runSpu: (call: AutoSoulSpuCall) => Promise<RunSpuResult>;
  newId: () => string;
}

export type AutoSoulStage = 'precheck' | 'update' | 'summary' | 'finalize';

export type AutoSoulResult =
  | { ok: true; newConvoId: string; newTitle: string; label: string; retried: boolean }
  | { ok: false; stage: AutoSoulStage; reason: string; retried: boolean };

type StepFail = { ok: false; reason: string; retryable: boolean };

/** β's raw output → Layers 1-3, or why it cannot be a soul. Pure. */
export function settleUpdateOutput(r: RunSpuResult):
  | { ok: true; layers: string; changelog: string }
  | StepFail {
  if (!r.ok) return { ok: false, reason: r.reason, retryable: true };
  if (r.record.status === 'stopped') return { ok: false, reason: 'the update was stopped', retryable: false };
  const cleaned = stripEndSentinel(r.record.accum);
  if (!cleaned) return { ok: false, reason: 'the updater returned no text', retryable: true };
  // The guard the panel's commit has a human for. See SystemPromptUpdater's
  // runUpdate: the damage on 2026-10-22 was reporting a cut-off run as done.
  if (!r.record.accum.includes(END_SENTINEL)) {
    return { ok: false, reason: `the updater's output was cut off (${cleaned.length} chars, no completion marker)`, retryable: true };
  }
  const { changelog, core } = splitOffChangelog(cleaned);
  const { layers } = splitOffLogs(core);
  if (!layers.trim()) return { ok: false, reason: 'the updater wrote no layers', retryable: true };
  return { ok: true, layers, changelog };
}

/** The summary writer's raw output → the summary text, or why not. Pure. */
export function settleSummaryOutput(r: RunSpuResult): { ok: true; text: string } | StepFail {
  if (!r.ok) return { ok: false, reason: r.reason, retryable: true };
  if (r.record.status === 'stopped') return { ok: false, reason: 'the summary was stopped', retryable: false };
  const text = r.record.accum.trim();
  if (!text) return { ok: false, reason: 'the summary writer returned no text', retryable: true };
  return { ok: true, text };
}

/**
 * Run the whole thing for one conversation. Never throws: every failure comes
 * back as a stage and a sentence.
 */
export async function runAutoSoulUpdate(
  args: { being: string; convoId: string; lang: ScaffoldLang },
  io: AutoSoulIo,
): Promise<AutoSoulResult> {
  const { being, convoId, lang } = args;
  let retried = false;
  const fail = (stage: AutoSoulStage, reason: string): AutoSoulResult => ({ ok: false, stage, reason, retried });

  try {
    // ── precheck: nothing here costs a model call ───────────────────────────
    const log = await io.loadLog(convoId);
    if (!log) return fail('precheck', 'the conversation could not be read');
    const title = String(log.title || '');
    const gen = resolveSoulGeneration({ title, identityName: being });
    // Only `<being>_<n>`. Any other title needs "the row above" to name its
    // next label, and a wrong label here writes over another generation's soul.
    if (gen.kind !== 'numbered') {
      return fail('precheck', `the title "${title}" is not of the form "${being}_<number>", so the next generation cannot be named`);
    }
    const newTitle = titleForGeneration(being, gen.nextLabel);
    const siblings = await io.listConversations(being);
    if (siblings.some((c) => c.title === newTitle)) {
      return fail('precheck', `a conversation named "${newTitle}" already exists`);
    }

    const settings = await io.beingSettings(being);
    const agent = await io.agentPrompt(lang, AGENT_FILE_UPDATE);
    if (!agent) return fail('precheck', `${AGENT_FILE_UPDATE} was not found in system_prompt_agents/${lang}/`);

    const work = await io.readWork(being, gen.currentLabel);
    const leftText = (work !== null ? work : (await io.readSoul(being, gen.currentLabel)) || '').replace(/\s+$/, '');
    if (!leftText.trim()) return fail('precheck', `there is no soul for generation ${gen.currentLabel} to update`);

    const messages = Array.isArray(log.messages) ? (log.messages as Array<Record<string, unknown>>) : [];
    const isOrig = makeIsOriginalIndex(
      { firstOriginalMessageId: log.firstOriginalMessageId as string | undefined, firstOriginalIsNext: log.firstOriginalIsNext as boolean | undefined },
      messages as Array<{ id?: string }>,
    );
    const original = messages.filter((_, i) => isOrig(i)).map((m) => ({
      role: typeof m.role === 'string' ? m.role : undefined,
      name: typeof m.name === 'string' ? m.name : undefined,
      content: typeof m.content === 'string' ? m.content : '',
      timestamp: typeof m.timestamp === 'number' ? m.timestamp : undefined,
    }));
    if (original.length === 0) return fail('precheck', 'this conversation has no new messages to update from');

    const subjectName = being.trim() || title;
    const conversationLogText = formatConversationLog(original, subjectName);
    const header = typeof settings.systemPromptHeader === 'string' ? settings.systemPromptHeader : '';
    const focus = typeof settings.systemPromptFocusPoint === 'string' ? settings.systemPromptFocusPoint.trim() : '';
    const summaryInstr = typeof settings.summaryInstructions === 'string' ? settings.summaryInstructions.trim() : '';
    const entityFooter = await io.footer(being);
    const summaryIndexBody = await io.layer4Index(being, convoId, lang);
    const vessels = resolveSpuVessels(settings, {
      aiName: String(log.aiName || ''),
      specificModel: String(log.specificModel || settings.specificModel || ''),
    });
    const modelParams = ((log.modelParams || settings.modelParams || {}) as Record<string, unknown>);

    // One retry, shared by both steps.
    const withRetry = async <T extends { ok: true }>(step: () => Promise<T | StepFail>): Promise<T | StepFail> => {
      const first = await step();
      if (first.ok || !first.retryable || retried) return first;
      retried = true;
      return step();
    };

    // ── β ───────────────────────────────────────────────────────────────────
    const updateMsg = buildUpdateUserMsg({
      lang, subjectName, withConversation: true, focus, header, leftText,
      summaryIndexBody, entityFooter, conversationLogText, resumeText: '', endSentinel: END_SENTINEL,
    });
    const upd = await withRetry(async () => settleUpdateOutput(await io.runSpu({
      label: gen.nextLabel, action: 'update', convoId, userMsg: updateMsg,
      agentSystemPrompt: agent, lang, vessel: vessels.update, modelParams,
    })));
    if (!upd.ok) return fail('update', upd.reason);

    // The panel's right pane auto-saves here too: the draft is on disk before
    // the summary runs, so a failure after this point leaves it for a person.
    await io.writeSoul(being, gen.nextLabel, upd.layers);
    if (upd.changelog) { try { await io.writeChangelog(being, title, upd.changelog); } catch { /* an archive, not the artifact */ } }

    // ── summary ─────────────────────────────────────────────────────────────
    const summaryAgent = (await io.summaryAgentPrompt(lang)) || defaultSummaryAgentPrompt(lang);
    const summaryMsg = buildSummaryUserMsg({
      lang, subjectName, customInstr: summaryInstr, identityText: assembleLayers123(leftText),
      summaryIndexBody, entityFooter, conversationLogText,
    });
    const sum = await withRetry(async () => settleSummaryOutput(await io.runSpu({
      label: gen.nextLabel, action: 'summary', convoId, userMsg: summaryMsg,
      agentSystemPrompt: summaryAgent, lang, vessel: vessels.summary, modelParams, maxContinuations: 0,
    })));
    if (!sum.ok) return fail('summary', sum.reason);
    const stamp = firstMessageStamp(original);
    await io.writeSummary(being, title, (stamp ? stamp + ' ' : '') + sum.text);

    // ── finalize: what "Go to Next Conversation" does ───────────────────────
    try {
      await io.backupSoul(being, gen.currentLabel, gen.nextLabel, 'BEFORE', leftText);
      await io.backupSoul(being, gen.currentLabel, gen.nextLabel, 'AFTER', upd.layers);
    } catch { /* best-effort, as in the panel */ }

    const processed = io.applyDeletions(upd.layers, await io.deletionPatterns(lang));
    const fullPrompt = [header, processed].filter((s) => s && s.trim()).join('\n\n');

    // Read again: the turn that brought the conversation to 100% may have been
    // saved after the first read, and the clone must carry what is on disk now.
    const fresh = (await io.loadLog(convoId)) || log;
    const newId = io.newId();
    const clone: Record<string, unknown> = {
      ...fresh,
      id: newId,
      systemPrompt: fullPrompt,
      title: newTitle,
      // The whole carried history is context; the next message that lands
      // becomes the first original one (see firstOriginal.promotePendingMarker).
      firstOriginalMessageId: null,
      firstOriginalIsNext: true,
    };
    delete clone.updatedAt;   // a new conversation gets its own version stamp
    const saved = await io.saveLog(newId, clone);
    if (!saved.ok) return fail('finalize', 'the new conversation could not be saved');

    // The rest is bookkeeping: the conversation exists, so a failure below
    // must not report the update as failed (the stock would stay behind).
    try {
      const order = Array.isArray(settings.convoOrder)
        ? (settings.convoOrder as unknown[]).filter((x): x is string => typeof x === 'string')
        : siblings.map((c) => c.id);
      const patch: Record<string, unknown> = { convoOrder: [newId, ...order.filter((id) => id !== newId)] };
      // Same rule as the panel: only when nobody has decided yet.
      if (settings.useSummariesForLayer4 === undefined || settings.useSummariesForLayer4 === null) patch.useSummariesForLayer4 = true;
      if (settings.enableConversationTools === undefined || settings.enableConversationTools === null) patch.enableConversationTools = true;
      await io.patchBeingSettings(being, patch);
    } catch { /* order and switches; the title already decides which one is living */ }
    try { await io.clearRunRecord(being, gen.nextLabel); } catch { /* a stale record is offered to the panel, nothing more */ }

    return { ok: true, newConvoId: newId, newTitle, label: gen.nextLabel, retried };
  } catch (e) {
    return fail('finalize', String((e as Error)?.message || e));
  }
}

/**
 * The line added to a NEXUS item that had to wait for the soul update, so the
 * being reads why "04:00" arrived later than 04:00. Appended to both texts:
 * the short one stays in the history, the full one is what the turn is sent.
 */
export function delayedStartNote(lang: string | undefined, hhmm: string): string {
  return lang === 'en'
    ? `(This start was delayed until ${hhmm}: the soul update ran first, and this is the new conversation.)`
    : `（魂の更新を先に行ったため、この開始は ${hhmm} まで遅れました。ここは更新後の新しい会話です。）`;
}

export function withDelayedStartNote<T extends { payload?: unknown; uiLang?: string }>(item: T, hhmm: string): T {
  const p = (item.payload && typeof item.payload === 'object' ? item.payload : {}) as Record<string, unknown>;
  const note = delayedStartNote(item.uiLang, hhmm);
  const add = (v: unknown) => (typeof v === 'string' && v ? `${v}\n${note}` : v);
  return { ...item, payload: { ...p, text: add(p.text), ...(p.fullText !== undefined ? { fullText: add(p.fullText) } : {}) } };
}
