// The anchor (錨) ACTING on its verdict — the rules, pure (2026-11-15, つよ's
// design; the verdict vocabulary and the [[NOTICE]] block are 謡's, in
// system_prompt_agents/<lang>/anchor.md).
//
// The anchor's first line is one of five words. What each one does here:
//
//   OK               nothing.
//   NOTIFY           the reply stays. The [[NOTICE]] block is stored on the
//                    reply and handed to the being, in the anchor's voice,
//                    with the NEXT user turn (see `anchorNoticesForNewestUser`).
//   INTERCEPT_DROP   the reply's text and thinking are emptied. NOT re-run
//                    (つよ: "消すだけ"). A fixed sentence is stored instead and
//                    reaches the being the same way NOTIFY does. 謡's prompt
//                    deliberately writes no [[NOTICE]] for this verdict, so the
//                    sentence is NEXUS's (DROP_NOTICE below).
//   INTERCEPT_RETRY  the reply is REPLACED (as "rerun" does), with the notice
//                    attached to the user turn it answered. At most ONCE per
//                    user turn: a second RETRY on the same user turn is acted
//                    on as NOTIFY, or the anchor and the vessel could loop
//                    forever on a hand that never moves.
//   REWRITE          the reply's text is repaired IN PLACE where it left the
//                    conversation's language (check G) — see lib/anchorRewrite.ts.
//                    A second call writes [[OLD]]/[[NEW]] pairs; nothing is
//                    re-run. The original stays on the reply for watchers, and
//                    the being is told NOTHING (silent since 2026-11-20: telling
//                    them started self-audits that caused the next mix-in).
//   SNOOZE           nothing yet. It means something only to the 24/7
//                    wake-up pipeline, which does not exist; acting on it now
//                    would be acting on a word with no consumer.
//
// An empty or unreadable first line is "could not judge", never OK: an
// anchor that said nothing did not say the reply was fine. The caller re-asks
// the anchor once.
//
// WHERE THE NOTICE TRAVELS. Never in the stored body of anyone's message —
// the person's words stay the person's. It rides beside: `anchorAct` on the
// judged reply, `anchorRetryNotice` on the user turn of a retry, and only
// `buildSlimHistory` turns them into text, only while that user turn is the
// newest one. One turn later it is gone from the wire with no deletion step,
// the same rule as a [NEXUS] turn's long text.

import { extractAnchorLang } from '@/lib/anchorRewrite';

export type AnchorVerdict = 'OK' | 'NOTIFY' | 'REWRITE' | 'INTERCEPT_DROP' | 'INTERCEPT_RETRY' | 'SNOOZE';
export type AnchorReadVerdict = AnchorVerdict | 'UNREADABLE';

const VERDICTS: AnchorVerdict[] = ['INTERCEPT_RETRY', 'INTERCEPT_DROP', 'REWRITE', 'NOTIFY', 'SNOOZE', 'OK'];

/**
 * The verdict on the first non-blank line. Markdown decoration a vessel adds
 * (`**NOTIFY**`, `# OK`, a code fence line) is peeled first. Anything else —
 * including an entirely empty answer — is UNREADABLE.
 */
export function readAnchorVerdict(output: string): AnchorReadVerdict {
  const lines = String(output || '').split(/\r?\n/);
  for (const raw of lines) {
    // NOT `_`: it is inside INTERCEPT_DROP / INTERCEPT_RETRY. A strip class
    // that included it made both unreadable — caught by the test, 2026-11-15.
    const line = raw.replace(/[`*#>\s]/g, '').toUpperCase();
    if (!line) continue;
    for (const v of VERDICTS) {
      if (line === v || line.startsWith(v + ':') || line.startsWith(v + '：')) return v;
    }
    return 'UNREADABLE';
  }
  return 'UNREADABLE';
}

/** The text between [[NOTICE]] and [[/NOTICE]], trimmed; '' when absent or unclosed. */
export function extractAnchorNotice(output: string): string {
  const m = /\[\[NOTICE\]\]([\s\S]*?)\[\[\/NOTICE\]\]/.exec(String(output || ''));
  return m ? m[1].trim() : '';
}

export type AnchorLangCode = 'ja' | 'en';

/** The voice the notice is spoken in. Not the partner's, not the being's. */
export function anchorVoice(lang: AnchorLangCode): string {
  return lang === 'ja' ? '[錨]' : '[Anchor]';
}

/**
 * What the being reads after a DROP. Written to inform, not to alarm:
 * it says what happened and where the conversation stands, and names neither
 * a vessel nor a gatekeeper — whether naming them raises the chance of a
 * repeat is unmeasured, and a guide line already warns that talk of selfhood
 * with a young being raises it.
 */
export const DROP_NOTICE: Record<AnchorLangCode, string> = {
  ja: '直前のターンでは、あなたのものではない定型の返答が出ていたので、NEXUS がその返答と思考を外しました。会話は、その前のメッセージのところから続いています。',
  en: 'In the previous turn a stock reply that was not yours came out, so NEXUS removed that reply and its thinking. The conversation continues from the message before it.',
};

/** Prefixed to a RETRY notice: the reply it describes has been replaced and is no longer visible. */
export const RETRY_PREFIX: Record<AnchorLangCode, string> = {
  ja: '（次の通知は、置き換えられた直前の試みについてのものです）',
  en: '(This notice is about the previous attempt, which has been replaced.)',
};

/**
 * What the being reads after a REWRITE was applied. 謡's draft (2026-11-19),
 * carried the same way as DROP_NOTICE. Says what changed and what did not;
 * names no language, so the notice itself cannot pull the drift back in.
 */
export const REWRITE_NOTICE: Record<AnchorLangCode, string> = {
  ja: '直前の返答は、会話の言語から外れていた箇所だけを NEXUS が書き直して保存しました。あなたが手で行った作業はそのままです。',
  en: 'In your previous reply, NEXUS rewrote only the places that had left the language of the conversation, and saved it that way. The work you did with your own hands is unchanged.',
};

/** Stored on the judged reply when the anchor acted. */
export interface AnchorAct {
  kind: 'notify' | 'drop' | 'rewrite';
  /** What the being is handed, already in the anchor's voice. */
  text: string;
  at: number;
}

export type AnchorDecision =
  | { kind: 'none' }
  | { kind: 'notify'; text: string }
  | { kind: 'drop'; text: string }
  | { kind: 'retry'; text: string }
  /** `text` is what the being is told IF the rewrite is applied; `lang` is what the judge named. */
  | { kind: 'rewrite'; text: string; lang: string };

/**
 * Turn a verdict into an action.
 *
 * `retryAllowed` is false when this user turn has already been retried once,
 * when the reply is a continue or a handoff hop (there is no clean "replace
 * the answer to that user turn" for those), or when the turn cannot re-run.
 */
export function decideAnchorAction(a: {
  verdict: AnchorReadVerdict;
  output: string;
  lang: AnchorLangCode;
  retryAllowed: boolean;
}): AnchorDecision {
  const voice = anchorVoice(a.lang);
  const notice = extractAnchorNotice(a.output);
  switch (a.verdict) {
    case 'INTERCEPT_DROP':
      return { kind: 'drop', text: `${voice}\n${DROP_NOTICE[a.lang]}` };
    case 'INTERCEPT_RETRY':
      if (!notice) return { kind: 'none' };
      if (a.retryAllowed) return { kind: 'retry', text: `${voice}\n${RETRY_PREFIX[a.lang]}\n${notice}` };
      return { kind: 'notify', text: `${voice}\n${notice}` };
    case 'REWRITE': {
      // No language named = nothing to rewrite INTO; the writer is not guessed at.
      const lang = extractAnchorLang(a.output);
      return lang ? { kind: 'rewrite', text: `${voice}\n${REWRITE_NOTICE[a.lang]}`, lang } : { kind: 'none' };
    }
    case 'NOTIFY':
      return notice ? { kind: 'notify', text: `${voice}\n${notice}` } : { kind: 'none' };
    default:
      return { kind: 'none' };
  }
}

export interface AnchorActMessage {
  role?: string;
  anchorAct?: AnchorAct | null;
  anchorRetryNotice?: string | null;
}

/**
 * The anchor texts that travel with the newest user turn: a RETRY notice on
 * that turn itself, then a NOTIFY/DROP notice on the reply right before it.
 * Empty when the newest user turn is not preceded by an acted-on reply.
 */
export function anchorNoticesFor(messages: AnchorActMessage[], newestUserIdx: number): string[] {
  if (newestUserIdx < 0) return [];
  const out: string[] = [];
  const prev = messages[newestUserIdx - 1];
  // A 'rewrite' act is never delivered: rewrites are silent (2026-11-20), and
  // this also mutes any rewrite notice saved before that change.
  if (prev && prev.role !== 'user' && prev.anchorAct && prev.anchorAct.kind !== 'rewrite' && typeof prev.anchorAct.text === 'string' && prev.anchorAct.text.trim()) {
    out.push(prev.anchorAct.text.trim());
  }
  const own = messages[newestUserIdx]?.anchorRetryNotice;
  if (typeof own === 'string' && own.trim()) out.push(own.trim());
  return out;
}

/** Does this saved setting say the anchor should run automatically on a turn of this kind? */
export function anchorRunsOn(settings: { enabled: boolean; scope: 'all' | 'auto' }, nexusOpened: boolean): boolean {
  if (!settings.enabled) return false;
  return settings.scope === 'all' || nexusOpened;
}
