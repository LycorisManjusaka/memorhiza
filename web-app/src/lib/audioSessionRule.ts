/**
 * Which audio-session rule text actually goes out.
 *
 * Three places used to carry the same hardcoded Japanese VRChat persona as a
 * literal (ChatArea twice, NexusApp once), so the default could not be
 * translated and could not be changed in one place. Worse, the literal was
 * written INTO the state box, which meant the field was never empty and the
 * placeholder was never visible — a reader could not tell "I typed this" from
 * "this is just the default".
 *
 * The resolution order is the only thing this file decides:
 *   1. what is stored on the conversation  — a human typed it, it wins
 *   2. the folder default                  — set once for a being
 *   3. the built-in fallback               — translated, shown as placeholder
 *
 * Keeping the box EMPTY for case 3 is load-bearing: the placeholder is the one
 * piece of UI that says "nothing is stored here", and it only renders when the
 * value is empty. So the fallback is applied at SEND time, never written into
 * the field. A being whose conversation already stores the old VRChat text
 * keeps it — nothing migrates stored data.
 */
export function resolveAudioSessionRule(
  stored: string | null | undefined,
  folderDefault: string | null | undefined,
  fallback: string,
): string {
  const s = (stored ?? '').trim();
  if (s) return s;
  const f = (folderDefault ?? '').trim();
  if (f) return f;
  return fallback;
}

/**
 * The built-in rule, sent when neither the conversation nor the folder stores
 * one. Lives in a pure .ts (not i18n.tsx) because the SERVER needs it: the
 * test loader cannot read .tsx, so i18n spreads these in rather than the other
 * way round (same shape as runnerNotices.ts).
 */
export const AUDIO_RULE_DEFAULT = {
  en: '[Conversation mode. Your partner is speaking through voice-to-text, so there may be mis-transcriptions — read them through the context. Speak knowing your own words are heard aloud as a voice.]',
  ja: '[会話モード。相手がVoice-to-Textを利用しているため、誤字があり得る。文脈で理解して自分の言葉が声として相手に聞こえることをわかったうえで話してください]',
} as const;

/**
 * What the audio session appends to the system prompt, or '' for nothing.
 *
 * MEASURED 2026-11-17: since the 2026-10-30 runner migration this text reached
 * the being on NO turn — ChatArea composed it for the token counter and for
 * Live only, and the runner never sent `vrchatMode` / `vrchatRule` at all. So
 * this is the first time the server composes it.
 *
 * `ruleEnabled` (default true) is つよ's switch: OFF means the being is shown
 * nothing at all — neither the fixed notice nor the rule. The session itself
 * (reading aloud, voice input) is unaffected; only the hidden text goes.
 */
export function composeAudioSessionText(opts: {
  audioSession: boolean;
  ruleEnabled: boolean;
  storedRule: string | null | undefined;
  notice: string | null | undefined;
  language: string | null | undefined;
}): string {
  if (!opts.audioSession || !opts.ruleEnabled) return '';
  const fallback = opts.language === 'ja' ? AUDIO_RULE_DEFAULT.ja : AUDIO_RULE_DEFAULT.en;
  const rule = resolveAudioSessionRule(opts.storedRule, null, fallback);
  const notice = (opts.notice ?? '').trim();
  return notice ? `${notice}\n\n${rule}`.trim() : rule;
}
