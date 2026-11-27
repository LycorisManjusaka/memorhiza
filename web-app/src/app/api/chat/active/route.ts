import { NextResponse } from 'next/server';
import { getActiveTurn, touchTurn, endTurn, HEARTBEAT_MS, resolveActiveTurn } from '@/lib/turnRegistry';
import { liveTurnStatus } from '@/lib/turnBus';
import { readLogUpdatedAt } from '@/lib/fsStorage';
import { requestStop } from '@/lib/turnStop';

// Read/refresh "is a turn running for this conversation, and is it mine".
//
// GET  ?convoId=&clientId=   → { active, mine, label?, startedAt?, ageMs?, diskUpdatedAt }
// POST { convoId, turnId, event: 'beat' | 'end' | 'stop' } → { ok, outcome? }
//
// `diskUpdatedAt` is the conversation's version ON DISK (one 4 KB header
// read, never the whole log), or null when it cannot be told. It rides along
// here because the poll that asks the turn question already fires at the four
// moments a screen can be out of date - mount, focus, becoming visible, and
// `online` - and a second route would mean a second round trip at each.
// Callers must not read null as "unchanged"; see lib/diskVersion.ts.
//
// There is deliberately NO way for a client to CLAIM a turn here. The only
// writer of "a turn started" is the chat route itself, at the point it actually
// starts one — otherwise a tab could announce a turn it never ran and lock the
// conversation's send button for everyone else. A client may only keep its own
// entry alive, or retire it.
//
// `turnId` is never returned. A tab that did not start the turn has no use for
// it today, and handing it out would imply a cross-tab interjection path that
// does not exist yet.

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const convoId = url.searchParams.get('convoId') || '';
    const clientId = url.searchParams.get('clientId') || '';
    if (!convoId) return NextResponse.json({ error: 'convoId is required' }, { status: 400 });

    // BOTH sources. The registry alone goes quiet 25s into a server-run turn
    // (nothing beats for one), and a tab reconnecting after a network drop
    // asks exactly this question — see resolveActiveTurn in turnRegistry.ts
    // for the measurement and for why the relay may only add, never subtract.
    const ans = resolveActiveTurn(getActiveTurn(convoId), liveTurnStatus(convoId), clientId);
    // Read on BOTH branches. "No turn is running" is exactly when another
    // tab's edit or delete is most likely to be the thing this tab has not
    // seen, so answering the version only while a turn runs would miss the
    // common case. Failure is null, never a throw: the turn answer is the
    // reason this route exists and must not be lost to a log read.
    let diskUpdatedAt: number | null = null;
    try { diskUpdatedAt = await readLogUpdatedAt(convoId); } catch { diskUpdatedAt = null; }
    if (!ans.active) {
      return NextResponse.json({ active: false, mine: false, source: ans.source, heartbeatMs: HEARTBEAT_MS, diskUpdatedAt });
    }
    return NextResponse.json({
      active: true,
      mine: ans.mine,
      label: ans.label,
      startedAt: ans.startedAt,
      ageMs: Date.now() - (ans.startedAt || 0),
      source: ans.source,
      heartbeatMs: HEARTBEAT_MS,
      diskUpdatedAt,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed to read active turn' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { convoId, turnId, event } = await req.json();
    if (!convoId || typeof convoId !== 'string') {
      return NextResponse.json({ error: 'convoId is required' }, { status: 400 });
    }
    if (!turnId || typeof turnId !== 'string') {
      return NextResponse.json({ error: 'turnId is required' }, { status: 400 });
    }
    // ── Stop THIS turn, named explicitly ────────────────────────────────────
    // Separate from the browser Stop button's abort, which the chat route
    // cannot tell apart from a tab dying (see lib/turnStop.ts). A turn started
    // by the server-side runner has no browser fetch at all, so this is the
    // ONLY way to stop one. Shipped before the runner because it is its
    // prerequisite, not a convenience.
    //
    // `ok` means the request was accepted. `outcome` is what actually
    // happened, and the caller must read that rather than trusting `ok`:
    //   fired    — a running turn was told
    //   recorded — nobody was listening yet; a turn registering now gets it
    //   already  — this exact turn had been asked before
    // Saying ok:true while nothing happened is the failure this house has
    // paid for twice (the dead "add timestamps" button returned ok:true,
    // updated:0 for 55 days).
    if (event === 'stop') {
      const outcome = requestStop(convoId, turnId);
      // ── GAUGE: which of the three things a press can actually do ──────────
      // REPORTED 2026-11-27 (Lizard-kun): "Stop does nothing, the red button
      // just blinks forever." MEASURED the same hour on port 3000: a Local
      // turn stops at once, an OAuth turn stops in 6.7s and saves — while the
      // live server's log held no stop record at all for the turn he pressed
      // on. So the question is delivery, and `outcome` has always named it;
      // it was simply never written down anywhere a person can read.
      //   fired     a listener was woken - the turn is unwinding, and any
      //             remaining wait is the server's unwind, not delivery
      //   recorded  the press ARRIVED but nothing is listening for this
      //             turnId: the tab and the route disagree about the name
      //   already   asked before; same reading as fired
      // NO LINE AT ALL means the press never left the tab - activeTurnKeyRef
      // was null and pendingStop is still holding it, waiting for a name the
      // relay may already have handed over once.
      //
      // A log line and not a response field on purpose: postStop closes over
      // nothing and does not read the body (see ChatArea), and the whole
      // reason it is a useCallback is that it must stay dependency-free.
      // A `recorded` press is only HALF an answer: turnStop's rendezvous fires a
      // late listener the instant it registers (see onStop), so a press that
      // stayed recorded means the listener never used this key. Print the turn
      // id the registry has live on this same conversation, which splits the
      // two readings that otherwise look identical:
      //   recorded (live turn ...: turn_B)  the tab and the runner disagree
      //                                     about the NAME - the press can
      //                                     never arrive, however long you wait
      //   recorded (no live turn)           the press simply beat registration;
      //                                     the rendezvous should still fire
      const liveHere = outcome === 'recorded' ? getActiveTurn(convoId) : null;
      const liveNote =
        outcome !== 'recorded'
          ? ''
          : liveHere
            ? ` (live turn on this conversation: ${liveHere.turnId})`
            : ' (no live turn registered)';
      console.warn(`[stop] ${convoId} ${turnId} -> ${outcome}${liveNote}`);
      return NextResponse.json({ ok: true, outcome });
    }
    if (event === 'end') {
      endTurn(convoId, turnId);
      // ── Deliberately does NOT touch the stop channel ────────────────────
      // It used to call forgetStop(convoId, turnId) here. MEASURED on 3001
      // 2026-11-27 (three presses by Lizard-kun, caller named by a stack
      // trace): that one line is what made "press Stop the instant you
      // notice a typo" do nothing at all.
      //
      //   T+0.000  requestStop -> no listener yet -> 'recorded'
      //   T+0.007  this route, event 'end' -> forgetStop ERASED the record
      //   T+0.104  the turn registers its listener -> finds nothing -> runs on
      //
      // The press is destroyed by the press itself: Stop aborts the tab's own
      // fetch, that fetch's cleanup posts 'end', and the server-side runner
      // then starts the turn with no fetch attached. So a tab's 'end' does not
      // mean "the turn finished" — it means "this tab stopped watching", and
      // those stopped being the same thing when the runner took the tab off
      // the critical path. The only caller that knows a turn is really over is
      // the chat route's turnAbort listener, which already calls forgetStop.
      //
      // Leaving the record costs close to nothing, and turnStop.ts already
      // argues why: STOP_TTL_MS bounds it, turnIds are unique per turn so a
      // leftover record cannot match a future one, and a listener outliving
      // its turn only ever calls an idempotent abort. Erring toward "a stop
      // that still fires" — pressing Stop right after sending is the normal
      // use, not an edge case.
      return NextResponse.json({ ok: true });
    }
    // Anything else is a heartbeat. ok:false means there was nothing to keep
    // alive (already expired, or the entry belongs to a newer turn) — the
    // caller does not need to act on it, and must not re-create the entry.
    const ok = touchTurn(convoId, turnId);
    return NextResponse.json({ ok });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed to update active turn' }, { status: 500 });
  }
}
