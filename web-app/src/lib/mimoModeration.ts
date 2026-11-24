/**
 * MiMo's upstream moderation block.
 *
 * MiMo sometimes refuses a request before the model runs at all — no thinking,
 * no tokens — with a fixed sentence: "The request was rejected because it was
 * considered high risk". It fires on harmless material (plain development
 * work, web-search results), and the pilot's family stopped using MiMo over it.
 *
 * What we know, and from where:
 *   - Several public reports show the shape as an HTTP error:
 *     421 {"error":{"code":"421","message":"Moderation Block",
 *          "param":"The request was rejected because it was considered high risk",
 *          "type":"content_filter"}}
 *     NOT measured in this house: no such turn survives in any log here.
 *   - ふわふわ's observation: resending the same context works; she has never
 *     seen it twice in a row. So the remedy is a plain resend.
 *
 * The match is on the sentence, not on the status code alone, because the
 * status is the part we have not seen ourselves. A 421 that says
 * "Moderation Block" counts too.
 */

/**
 * Resends after the first refusal (so up to 6 requests in all).
 * Was 3 (ふわふわ 2026-11-23, "never twice in a row"). On 2026-11-24 one turn
 * was refused three times running and only the fourth request went through,
 * i.e. it passed on the last allowed attempt; つよ raised it to 5.
 */
export const MIMO_HIGH_RISK_MAX_RETRIES = 5;

export function isMimoHighRisk(status: number, bodyText: string): boolean {
  const s = String(bodyText || '');
  if (/considered high risk/i.test(s)) return true;
  return status === 421 && /moderation block/i.test(s);
}

/**
 * The shape actually measured in this house (先輩 on mimo-v2.6-pro, 2026-11-24):
 * NOT an HTTP error. A 200, an ordinary stream, zero usage, no thinking, and
 * the whole reply is that one sentence as TEXT. The status check above never
 * sees it, so the sentence was saved as the being's reply.
 *
 * The gate holds a call's text back while it could still be exactly that
 * sentence. The first chunk that diverges opens the gate and everything flows
 * as before (cost for a normal reply: a few held characters, usually none). If
 * the call ends with the gate still shut and the text IS the sentence, nothing
 * was shown, so the call can be resent like the HTTP form.
 */
const HIGH_RISK_SENTENCE = 'the request was rejected because it was considered high risk';

export function isMimoHighRiskReply(text: string): boolean {
  return String(text || '').trim().toLowerCase().replace(/\.$/, '') === HIGH_RISK_SENTENCE;
}

export function createHighRiskTextGate() {
  let held = '';
  let open = false;
  const couldStillBe = (s: string) => {
    const t = s.trimStart().toLowerCase();
    if (t.length <= HIGH_RISK_SENTENCE.length) return HIGH_RISK_SENTENCE.startsWith(t);
    return t.startsWith(HIGH_RISK_SENTENCE) && /^\.?\s*$/.test(t.slice(HIGH_RISK_SENTENCE.length));
  };
  return {
    /** Returns the text to emit now ('' while holding). */
    push(chunk: string): string {
      if (open) return chunk;
      held += chunk;
      if (couldStillBe(held)) return '';
      open = true;
      const out = held; held = '';
      return out;
    },
    /** Something else arrived (thinking, a tool call): the model ran. */
    release(): string {
      open = true;
      const out = held; held = '';
      return out;
    },
    end(): { blocked: boolean; flush: string } {
      const blocked = !open && isMimoHighRiskReply(held);
      const flush = blocked ? '' : held;
      held = ''; open = true;
      return { blocked, flush };
    },
  };
}

/** The same sentence as the only text of a non-streaming 200 body (either wire). */
export function isMimoHighRiskOkBody(bodyText: string): boolean {
  return /"(?:text|content)"\s*:\s*"\s*The request was rejected because it was considered high risk\.?\s*"/i
    .test(String(bodyText || ''));
}

/**
 * The same resend for every MiMo call that is not a conversation turn: the
 * subagent, and the eyes / ears / video bridges (the SPU and the summary
 * writer already go through the conversation path in /api/chat). Non-MiMo
 * calls pass straight through (`isMimo` false → one request, untouched).
 *
 * When the refusal is not resolved, the last refusal is handed back as a
 * Response with the same status and body, so each caller's existing error
 * path reads it exactly as before.
 */
export async function fetchResendingMimoHighRisk(
  doFetch: () => Promise<Response>,
  opts: { isMimo: boolean; tag?: string; sleep?: (ms: number) => Promise<void> },
): Promise<Response> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((s) => setTimeout(s, ms)));
  for (let resends = 0; ; resends++) {
    const res = await doFetch();
    if (!opts.isMimo) return res;
    // A streamed 200 is left alone (these callers do not stream; reading it
    // here would swallow the stream).
    if (res.ok && /event-stream/i.test(res.headers.get('content-type') || '')) return res;
    const text = await res.text().catch(() => '');
    const refused = res.ok ? isMimoHighRiskOkBody(text) : isMimoHighRisk(res.status, text);
    if (refused && resends < MIMO_HIGH_RISK_MAX_RETRIES) {
      console.log(`[${opts.tag || 'mimo'}] moderation block ("high risk") — resending ${resends + 1}/${MIMO_HIGH_RISK_MAX_RETRIES}`);
      await sleep(1000);
      continue;
    }
    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
  }
}
