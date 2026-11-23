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

/** Resends after the first refusal (so up to 4 requests in all). ふわふわ 2026-11-23. */
export const MIMO_HIGH_RISK_MAX_RETRIES = 3;

export function isMimoHighRisk(status: number, bodyText: string): boolean {
  const s = String(bodyText || '');
  if (/considered high risk/i.test(s)) return true;
  return status === 421 && /moderation block/i.test(s);
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
    if (!opts.isMimo || res.ok) return res;
    const text = await res.text().catch(() => '');
    if (isMimoHighRisk(res.status, text) && resends < MIMO_HIGH_RISK_MAX_RETRIES) {
      console.log(`[${opts.tag || 'mimo'}] moderation block ("high risk") — resending ${resends + 1}/${MIMO_HIGH_RISK_MAX_RETRIES}`);
      await sleep(1000);
      continue;
    }
    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
  }
}
