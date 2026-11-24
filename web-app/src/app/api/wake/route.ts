import { NextResponse } from 'next/server';
import { installationId, normaliseInstallPath } from '@/lib/runnerHost';
import {
  readClockHost, setClockHost, clearClockHost, readWakeState, ensureWakeClock, wakeClockStartedAt, runsClockOrClaims,
} from '@/lib/wakeClock';
import { listFolders } from '@/lib/fsStorage';
import { parseWakeSettings, nextAdminSlot, nextWake } from '@/lib/wakeSchedule';

// The wake clock's screen side. Rules: lib/wakeSchedule.ts; plumbing: lib/wakeClock.ts.
//
// GET  ?folder=<being>   → which NEXUS runs the clock, this one's id, and the being's state
// GET  ?overview=1       → every being that can wake by itself, soonest first (Preferences → Runner)
// POST { action: 'stop-self-turns', folder } → every self-wake path of that being off at once
// GET  ?notes=1          → the administrator's conditional wake notes (lib/wakeAdminNotes.ts)
// POST { action: 'set-notes', notes } → replace them (cleaned by parseAdminNotes)
// POST { action: 'set-clock' }    → THIS installation runs the clock (overwrites)
// POST { action: 'clear-clock' }  → nobody runs it
// POST { action: 'clear-bookings', folder } → drop the being's pending self-bookings
// POST { action: 'remove-booking', folder, at }       → an administrator deletes one
// POST { action: 'move-booking', folder, at, hhmm }   → an administrator moves one (limits not applied)

export async function GET(req: Request) {
  try {
    ensureWakeClock();
    const params = new URL(req.url).searchParams;
    const folder = params.get('folder') || '';
    const selfId = await installationId();
    // Same empty-seat rule the clock itself uses, so the screen never says
    // "nobody runs the clock" one tick before this NEXUS takes it.
    await runsClockOrClaims(selfId);
    const clock = await readClockHost();
    if (params.get('notes') === '1') {
      const { readAdminNotes } = await import('@/lib/wakeAdminNotesStore');
      return NextResponse.json({ notes: await readAdminNotes() });
    }
    if (params.get('overview') === '1') {
      const { wakeOverview } = await import('@/lib/wakeOverview');
      return NextResponse.json({
        selfId,
        clockHost: clock?.host ?? null,
        thisRunsClock: !!clock && normaliseInstallPath(clock.host) === normaliseInstallPath(selfId),
        beings: await wakeOverview(),
      });
    }
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
      // The header's "next wake" beside the title: one time, the sooner of the two.
      out.nextWake = nextWake(w, s.bookings, Date.now());
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
    if (action === 'set-notes') {
      const { writeAdminNotes } = await import('@/lib/wakeAdminNotesStore');
      return NextResponse.json({ ok: true, notes: await writeAdminNotes(body.notes) });
    }
    if (action === 'clear-clock') {
      return NextResponse.json({ ok: true, removed: await clearClockHost() });
    }
    if (action === 'stop-self-turns') {
      const folder = typeof body.folder === 'string' ? body.folder : '';
      if (!folder) return NextResponse.json({ error: 'folder required' }, { status: 400 });
      const { stopSelfTurns } = await import('@/lib/wakeOverview');
      const report = await stopSelfTurns(folder);
      return NextResponse.json({ ok: report.errors.length === 0, report }, { status: report.errors.length ? 207 : 200 });
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
