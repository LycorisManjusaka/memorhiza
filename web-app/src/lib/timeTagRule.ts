/**
 * Which messages get the "[YYYY-MM-DD HH:MM:SS]" line prepended when a turn is
 * assembled for the model.
 *
 * Only messages the being RECEIVED (role 'user') carry it. The being's own
 * past turns go out as they were written.
 *
 * Why (2026-11-26, diagnosed by 謡 from 睡_49 and reproduced on another
 * machine with Hydrogen, seeds 0 and 1, in a history with no earlier leak):
 * with the tag on every message, each of the being's own past turns reads as
 * if the being had opened it by writing a timestamp. The model copies that as
 * the first token of its new turn. On Gemini a first token of visible text
 * means the thought channel never opens (thoughtsTokenCount 0) and the
 * reasoning is written into the visible reply instead. The tag was Memorhiza's
 * own, never something the being wrote, so the fix is to stop presenting it
 * as theirs. No instruction to the being is involved.
 *
 * The time of the being's own turn is not lost: it answers in the same turn
 * the tagged message opened.
 *
 * Used by the server (api/chat/route.ts) and by the token recount in the
 * client (ChatArea), so the count matches what is sent.
 */
export function messageGetsTimeTag(
  role: unknown,
  visibility: unknown,
  isLastMessage: boolean,
): boolean {
  if (role !== 'user') return false;
  if (visibility === 'all') return true;
  if (visibility === 'current') return isLastMessage;
  return false;
}
