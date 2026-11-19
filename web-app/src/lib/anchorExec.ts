// One anchor call against an in-memory message list: read 謡's prompt from
// disk, build the anchor's single message, POST it through the chat route,
// drain, bill. Shared by the manual button (app/api/anchor) and the runner's
// automatic run, so the two can never show the anchor different things.
//
// `chatPost` is injected: lib modules must not import a route (next/server
// cannot load outside the Next runtime, and a route-to-route import is what
// the tick route already does for the runner — the runner hands it down).

import { readAllAgentFiles, extractAgentSystemPrompt } from '@/lib/systemPromptStorage';
import { recordAuxBilling } from '@/lib/auxBillingStore';
import {
  buildAnchorUserMsg, buildAnchorChatBody,
  type AnchorReport, type AnchorLang, type AnchorSettings, type AnchorMessage,
} from '@/lib/anchor';
import { drainAnchorCall } from '@/lib/anchorRun';

export const ANCHOR_FILE = 'anchor.md';
/** The REWRITE writer's prompt (謡's). A separate call; see lib/anchorRewrite.ts. */
export const ANCHOR_REWRITE_FILE = 'anchor_rewrite.md';

export type AnchorExecResult =
  | { ok: true; report: AnchorReport }
  | { ok: false; error: 'message-not-found' | 'no-anchor-prompt' | 'no-anchor-model' };

export async function execAnchor(a: {
  messages: AnchorMessage[];
  targetId: string;
  folder: string;
  convoId: string;
  lang: AnchorLang;
  settings: AnchorSettings;
  origin: string;
  chatPost: (req: Request) => Promise<Response>;
  signal?: AbortSignal;
  /** Which prompt file. Default the judge's. */
  promptFile?: string;
  /** Turns the judge's message into this call's message (the REWRITE writer puts the language on top). */
  wrapUserMsg?: (anchorUserMsg: string) => string;
  /** Text / thought chunks as they stream (the runner relays them to the tabs). */
  onDelta?: (d: { thought?: string; text?: string }) => void;
}): Promise<AnchorExecResult> {
  if (!a.settings.model) return { ok: false, error: 'no-anchor-model' };
  const judgeMsg = buildAnchorUserMsg({
    messages: a.messages, targetId: a.targetId, beingName: a.folder, lang: a.lang,
  });
  // The writer gets the SAME material the judge saw, byte for byte, plus its header.
  const userMsg = judgeMsg && a.wrapUserMsg ? a.wrapUserMsg(judgeMsg) : judgeMsg;
  if (!userMsg) return { ok: false, error: 'message-not-found' };

  // Read on every run, so editing anchor.md takes effect on the next run.
  const agents = await readAllAgentFiles(a.lang);
  const systemPrompt = extractAgentSystemPrompt(agents.find((x) => x.name === (a.promptFile || ANCHOR_FILE))?.content || '');
  if (!systemPrompt) return { ok: false, error: 'no-anchor-prompt' };

  const res = await a.chatPost(new Request(`${a.origin}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildAnchorChatBody({ systemPrompt, userMsg, folderName: a.folder, settings: a.settings })),
    ...(a.signal ? { signal: a.signal } : {}),
  }));
  const drained = await drainAnchorCall(res, a.onDelta);

  // Billed even when the call errored after spending tokens. Never throws.
  await recordAuxBilling({ being: a.folder, convoId: a.convoId }, {
    kind: 'anchor',
    model: a.settings.model,
    family: a.settings.family,
    authMode: a.settings.family === 'Claude' ? a.settings.authMode : 'api-key',
    usage: drained.usage,
  });

  return {
    ok: true,
    report: {
      at: Date.now(),
      family: a.settings.family,
      model: a.settings.model,
      thought: drained.thought.trim(),
      output: drained.text.trim(),
      ...(drained.error ? { error: drained.error } : {}),
    },
  };
}
