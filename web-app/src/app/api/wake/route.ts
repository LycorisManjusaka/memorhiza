import { NextResponse } from 'next/server';
import { installationId, normaliseInstallPath } from '@/lib/runnerHost';
import {
  readClockHost, setClockHost, clearClockHost, readWakeState, ensureWakeClock, wakeClockStartedAt,
} from '@/lib/wakeClock';
import { listFolders } from '@/lib/fsStorage';
import { parseWakeSettings, nextAdminSlot } from '@/lib/wakeSchedule';

// The wake clock's screen side. Rules: lib/wakeSchedule.ts; plumbing: lib/wakeClock.ts.
//
// GET  ?folder=<being>   → which NEXUS runs the clock, this one's id, and the being's state
// POST { action: 'set-clock' }    → THIS installation runs the clock (overwrites)
// POST { action: 'clear-clock' }  → nobody runs it
// POST { action: 'clear-bookings', folder } → drop the being's pending self-bookings
// POST { action: 'remove-booking', folder, at }       → an administrator deletes one
// POST { action: 'move-booking', folder, at, hhmm }   → an administrator moves one (limits not applied)

export async function GET(req: Request) {
  try {
    ensureWakeClock();
    const folder = new URL(req.url).searchParams.get('folder') || '';
    const selfId = await installationId();
    const clock = await readClockHost();
    const out: Record<string, unknown> = {
      selfId,
      clockHost: clock?.host ?? null,
      thisRunsClock: !!clock && normaliseInstallPath(clock.host) === normaliseInstallPath(selfId),
      clockStartedAt: wakeClockStartedAt(),
    };
    if (folder) {
      const f = (await listFolders() as Array<{ name: string; settings?: Record<string, unknown> }>).find(x => x.name === folder);
      const w = parseWakeSettings(f?.settings?.wake);
      const s = await readWakeState(folder);
      out.state = s;
      out.testBed = f?.settings?.testBed === true;
      out.nextAdmin = nextAdminSlot(w, Date.now());
    }
    return NextResponse.json(out);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const action = typeof body?.action === 'string' ? body.action : '';
    if (action === 'set-clock') {
      const rec = await setClockHost(await installationId());
      ensureWakeClock();
      return NextResponse.json({ ok: true, clockHost: rec.host });
    }
    if (action === 'clear-clock') {
      return NextResponse.json({ ok: true, removed: await clearClockHost() });
    }
    if (action === 'clear-bookings') {
      const folder = typeof body.folder === 'string' ? body.folder : '';
      if (!folder) return NextResponse.json({ error: 'folder required' }, { status: 400 });
      const { clearBookings } = await import('@/lib/wakeClock');
      await clearBookings(folder);
      return NextResponse.json({ ok: true });
    }
    if (action === 'remove-booking' || action === 'move-booking') {
      const folder = typeof body.folder === 'string' ? body.folder : '';
      const at = typeof body.at === 'number' ? body.at : NaN;
      if (!folder || !Number.isFinite(at)) return NextResponse.json({ error: 'folder and at required' }, { status: 400 });
      const { removeBooking, moveBooking } = await import('@/lib/wakeClock');
      if (action === 'remove-booking') {
        const ok = await removeBooking(folder, at);
        return NextResponse.json(ok ? { ok: true } : { error: 'booking not found' }, { status: ok ? 200 : 404 });
      }
      const hhmm = typeof body.hhmm === 'string' ? body.hhmm : '';
      const booking = await moveBooking(folder, at, hhmm);
      return NextResponse.json(booking ? { ok: true, booking } : { error: 'invalid time or booking not found' }, { status: booking ? 200 : 400 });
    }
    return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
