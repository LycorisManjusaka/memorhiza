// GET → the OpenCode Go subscription windows (5-hour rolling / weekly /
// monthly), asked from OpenCode right now with the stored key. Unlike the
// Claude meter this one can be asked at any time, so nothing is stored.
// {} when there is no key; { error } when OpenCode did not answer.
import { NextResponse } from 'next/server';
import { loadKeys } from '@/lib/fsStorage';
import { OPENCODE_GO_USAGE_URL, openCodeGoHeaders, parseGoUsage } from '@/lib/opencodeGo';

export const dynamic = 'force-dynamic';

export async function GET() {
  const noStore = { headers: { 'Cache-Control': 'no-store' } };
  let key = '';
  try { key = String(((await loadKeys()) as any)?.opencode || '').trim(); } catch { /* no keys file */ }
  if (!key) return NextResponse.json({}, noStore);
  try {
    const r = await fetch(OPENCODE_GO_USAGE_URL, {
      headers: { Authorization: `Bearer ${key}`, ...openCodeGoHeaders('usage') },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return NextResponse.json({ error: `HTTP ${r.status}` }, noStore);
    // Pass OpenCode's own shape through (percent + resetsAt per window) with
    // the time we asked; the browser reads it with the same parseGoUsage.
    const body: any = await r.json();
    if (!parseGoUsage(body, Date.now())) return NextResponse.json({ error: 'unreadable' }, noStore);
    const raw: any = body?.usage && typeof body.usage === 'object' ? body.usage : body;
    return NextResponse.json(
      { rolling: raw.rolling, weekly: raw.weekly, monthly: raw.monthly, capturedAt: Date.now() },
      noStore,
    );
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.name || 'fetch failed') }, noStore);
  }
}
