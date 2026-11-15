// One capture, one tab per conversation (MEASURED 2026-11-15).
//
// Every open tab keeps its own /api/vrchat/watch connection, so two tabs on the
// same conversation each received the same photo and each sent it: the being
// got it twice (seen as one interjection carrying the same file twice). The
// first connection for a conversation to emit a file claims it; the others skip
// it. Tabs on DIFFERENT conversations are unaffected — the key includes the
// conversation id — and a connection that sends no id keeps the old behaviour.
//
// On globalThis so a dev hot reload does not reset the claims mid-session.
import path from 'path';

const CLAIM_MS = 10 * 60 * 1000;
const _g = globalThis as any;
if (!_g.__nx_vrchat_claims) _g.__nx_vrchat_claims = new Map<string, number>();
const claims: Map<string, number> = _g.__nx_vrchat_claims;

/** True when this connection should emit the file; false when another took it. */
export function claimCapture(convo: string, fullPath: string, now = Date.now()): boolean {
  if (!convo) return true;
  for (const [k, t] of claims) if (now - t > CLAIM_MS) claims.delete(k);
  const key = `${convo}\u0000${path.resolve(fullPath).toLowerCase()}`;
  if (claims.has(key)) return false;
  claims.set(key, now);
  return true;
}
