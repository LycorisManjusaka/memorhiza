import { NextResponse } from 'next/server';
import { claim, release, abandon, markReturned, queuedConversations, itemIsForThisInstallation, pending, type QueueItem } from '@/lib/turnQueue';
import { classifyReturn } from '@/lib/stockPanel';
import { runTurnForQueue, type RunTurnResult } from '@/lib/runTurnForQueue';
import { runnerHostStatus, describeRunnerHost, installationId, claimRunnerHostIfUnset, readRunnerHost, type RunnerHostStatus } from '@/lib/runnerHost';
import { autoTriggerEnabled } from '@/lib/autoTriggers';
import { conversationToolsEnabled } from '@/lib/agentCapabilities';
import { onStop } from '@/lib/turnStop';
import { resolveTurnName, mintTurnId } from '@/lib/turnName';
import { beginTurn, endTurn, publishTurnText, liveTurnStatus } from '@/lib/turnBus';
// Aliased: `endTurn` above closes the RELAY (what watchers read), this one
// retires the cross-tab REGISTRY entry (what tabs probe before sending). Two
// different lifetimes that happen to end at the same moment.
import { endTurn as endRegistryTurn } from '@/lib/turnRegistry';
import { takeUndelivered } from '@/lib/injectMessage';
import { FALLBACK_FAMILY } from '@/lib/beingVessel';
import { beingIsBlockedHere } from '@/lib/blockedBeings';
import { loadLog, saveLog, listFolders, loadUserSettings } from '@/lib/fsStorage';
// ⚠ The FIRST route-to-route import in this tree (measured: zero others).
// The alternative was an HTTP fetch to our own server, which would have to get
// past the admin gate — and src/middleware.ts says why there is exactly one
// gate. A runner is the same process; it does not need a key to talk to
// itself. The cost is that this one line is untestable (next/server cannot
// load outside Next's runtime), which is why every rule lives in lib.
import { POST as chatPost } from '@/app/api/chat/route';
import { execAnchor, ANCHOR_REWRITE_FILE } from '@/lib/anchorExec';
import { buildRewriteUserMsg } from '@/lib/anchorRewrite';
import { planBeingRoutes } from '@/lib/beingRouteExec';
import { recordSelfWakeFromReply, ensureWakeClock } from '@/lib/wakeClock';
import type { AnchorMessage } from '@/lib/anchor';
import { serverSpeech, speechModeFromSettings } from '@/lib/serverSpeech';
import { assistantSpeechSentences } from '@/lib/ttsSentences';
import { autoTurnsHeldForLog, isWakeItem, passIsUnattended } from '@/lib/autoHold';
import { autoGapStatusFor, recordAutoTurn } from '@/lib/autoGap';
import { soulUpdateRunning } from '@/lib/soulUpdateHold';
import { movePendingItems, readLease, holderIsGone } from '@/lib/turnQueue';
import { runSpuAction } from '@/lib/runSpuAction';
import { spuRelayKey } from '@/lib/spuRun';
import { writeSpuRunRecord, writeSpuBillingEntry } from '@/lib/systemPromptStorage';
import { autoSoulUpdateDue, runAutoSoulUpdate, withDelayedStartNote, type AutoSoulResult } from '@/lib/autoSoulUpdate';
import { realAutoSoulIo, writeAutoSoulStatus, readAutoSoulStatus, hasNewReason } from '@/lib/autoSoulUpdateIo';
import { autoSoulRun, beginAutoSoulRun, endAutoSoulRun, strongerPass } from '@/lib/autoSoulRuns';
import { wakeLangFromSettings, localHHMM } from '@/lib/wakeSchedule';
import { onlyQuietWaiting } from '@/lib/quietStock';
import { leaveQuietMessages } from '@/lib/quietLeaveIo';

// ── Automatic soul update (トカゲくん, 2026-11-20) ────────────────────────────
// A conversation at 100% with the switch on does not take the turn: what was
// about to start it stays in the stock, β + the summary run, the next
// conversation is created, the stock is carried into it, and the pass that was
// held runs THERE. Rules in lib/autoSoulUpdate.ts; this is only the wiring that
// needs the chat route and the relay.

/** What can start an automatic update: a message, or a wake. Not ζ, not a command. */
function startsAutoSoul(it: QueueItem): boolean {
  return it.kind === 'user_message' || isWakeItem(it);
}

function startAutoSoulUpdate(being: string, convoId: string, opts: PassOpts): void {
  const clean = (o: PassOpts): PassOpts => ({ ...o, oneBeing: being, assistantMsgId: '', proposedTurnId: '', relayConvoId: null });
  beginAutoSoulRun<PassOpts>(being, { convoId, startedAt: Date.now(), opts: clean(opts) });
  const accept = (it: QueueItem) => itemIsForThisInstallation(it, opts.selfId, opts.hostStatus === 'host');
  void (async () => {
    let r: AutoSoulResult;
    try {
      const lang = wakeLangFromSettings(await loadUserSettings());
      r = await runAutoSoulUpdate({ being, convoId, lang }, realAutoSoulIo(async (call) => {
        // A relay per call, like /api/spu-run: it is what lets the panel watch,
        // lets Stop reach the call, and what the soul-update hold reads as
        // "running" for a record written by this very process.
        const relayKey = spuRelayKey(being, call.label);
        const turnId = newTurnId();
        beginTurn(relayKey, turnId);
        let stopped = false;
        const offStop = onStop(relayKey, turnId, () => { stopped = true; });
        try {
          const res = await runSpuAction(
            {
              folder: being, label: call.label, action: call.action, convoId: call.convoId,
              userMsg: call.userMsg, agentSystemPrompt: call.agentSystemPrompt, lang: call.lang,
              resumeText: '', aiName: call.vessel.aiName, specificModel: call.vessel.specificModel,
              authMode: call.vessel.authMode, modelParams: call.modelParams,
              maxContinuations: call.maxContinuations, relayKey, turnId,
            },
            {
              chatPost,
              writeRecord: writeSpuRunRecord,
              writeBilling: writeSpuBillingEntry,
              onRawText: (text) => publishTurnText(relayKey, text),
              isAborted: () => stopped,
              nowMs: () => Date.now(),
              newId: () => crypto.randomUUID(),
              origin: opts.origin,
              host: opts.selfId,
            },
          );
          endTurn(relayKey, res.ok ? undefined : { type: 'error', error: res.reason });
          return res;
        } catch (e) {
          endTurn(relayKey, { type: 'error', error: String((e as Error)?.message || e) });
          throw e;
        } finally {
          offStop();
        }
      }));
    } catch (e) {
      r = { ok: false, stage: 'finalize', reason: String((e as Error)?.message || e), retried: false };
    }

    // Carried while this being is still marked as updating, so no pass can
    // look at the old stock between "the update is over" and "the stock moved".
    if (r.ok) {
      console.log(`[auto-soul] ${being}: ${convoId} → ${r.newTitle} (${r.newConvoId})${r.retried ? ', after one retry' : ''}`);
      try {
        const hhmm = localHHMM(new Date());
        const mv = await movePendingItems(being, convoId, r.newConvoId, {
          pick: (it) => accept(it) && startsAutoSoul(it),
          map: (it) => (isWakeItem(it) ? withDelayedStartNote(it, hhmm) : it),
        });
        if (!mv.ok) console.warn(`[auto-soul] could not carry the stock of ${being}/${convoId}: ${mv.reason}`);
      } catch (e) {
        console.warn(`[auto-soul] carrying the stock of ${being}/${convoId} failed:`, e);
      }
    }
    let waitingIds: string[] = [];
    try { waitingIds = (await pending(being, convoId)).filter((it) => accept(it) && startsAutoSoul(it)).map((it) => it.id); } catch { /* an empty list only means the next pass may try again */ }
    await writeAutoSoulStatus(being, convoId, r, Date.now(), waitingIds);
    const held = endAutoSoulRun<PassOpts>(being);

    if (!r.ok) {
      // Stops here. The items stay in the stock; the same items do not start
      // another attempt (hasNewReason), a new one does.
      console.warn(`[auto-soul] FAILED ${being}/${convoId} at ${r.stage}${r.retried ? ' (after one retry)' : ''}: ${r.reason}`);
      return;
    }
    const o = held?.opts || clean(opts);
    void runPass({ ...o, oneBeing: being, oneConvo: r.newConvoId })
      .catch((e) => console.warn('[auto-soul] the pass in the new conversation failed:', e));
  })();
}

// ── Held by a soul update: rerun when it ends (2026-11-20) ───────────────────
// A pass that found the being mid soul update left the items in the stock.
// Something has to come back for them, and nobody is watching: the update may
// have been started from another tab, another installation, or a phone. So
// the process that held them polls the run record and reruns the SAME pass
// (same auto/wake flags, so the stock checkbox and the 100% hold still apply)
// once it is over. Process-local: if this server dies, the items simply stay
// in the stock, where "run it now" still reaches them.
const SOUL_HOLD_POLL_MS = 5000;
const soulHoldWatch: Map<string, PassOpts> =
  ((globalThis as Record<string, unknown>).__nexusSoulHoldWatch as Map<string, PassOpts>) ||
  ((globalThis as Record<string, unknown>).__nexusSoulHoldWatch = new Map<string, PassOpts>());

function watchSoulHold(being: string, convoId: string, opts: PassOpts): void {
  const key = `${being}\u0000${convoId}`;
  const prev = soulHoldWatch.get(key);
  // A non-auto pass outranks an auto one: if a person's send was held, the
  // rerun must not then be refused by the stock checkbox.
  if (prev && !prev.auto) return;
  const first = !prev;
  soulHoldWatch.set(key, { ...opts, oneBeing: being, oneConvo: convoId, assistantMsgId: '', proposedTurnId: '', relayConvoId: null });
  if (!first) return;
  const tick = async () => {
    try {
      if (await soulUpdateRunning(being)) { setTimeout(tick, SOUL_HOLD_POLL_MS); return; }
    } catch { setTimeout(tick, SOUL_HOLD_POLL_MS); return; }
    const o = soulHoldWatch.get(key);
    soulHoldWatch.delete(key);
    if (!o) return;
    console.log(`[runner] soul update over for ${being}/${convoId} — running what waited`);
    void runPass(o).catch((e) => console.warn('[runner] post-soul-update pass failed:', e));
  };
  setTimeout(tick, SOUL_HOLD_POLL_MS);
}

// One pass of the server-side runner (phase 4b-5, 2026-10-29).
//
// POST {}                          → every being, every queued conversation
// POST { being, convoId }          → just that one, and WAIT for it
// POST { being, convoId, detach }  → just that one, answer immediately
// POST { auto: true }              → ALSO require the behaviour checkbox
//
// This is the thing that makes "send it, close the tab, come back and it is
// finished" true: the turn runs here and the result is written to disk by this
// process, not by a browser.
//
// ── WHY `detach` EXISTS ────────────────────────────────────────────────────
//
// MEASURED 2026-10-29 (つよ): with the auto-trigger checked, sending and then
// closing the tab stopped LM Studio mid-generation. The queue was never the
// problem — the browser was still the one POSTing to /api/chat, so the tab's
// connection WAS the turn's lifeline. `detach` lets a tab hand the turn over
// and then merely WATCH it (GET /api/turn-events), which is what makes
// closing the tab cost a view instead of an answer.
//
// The relay is opened SYNCHRONOUSLY here, before this route answers, so the
// tab can subscribe the instant its kick returns. Opened in the detached pass
// instead, the subscribe would race it and lose.
//
// WHY `auto` IS A PARAMETER AND NOT THE DEFAULT
//
// つよ's design (2026-10-28): the behaviour tab lists the REASONS a being may
// wake by itself, and "stocked messages" is the first row. An explicit tick is
// not one of those reasons — somebody asked for it — so by default this route
// does not consult the checkbox, exactly as the client-side "run it now"
// button does not. A future poller passes `auto: true` and is then subject to
// the checkbox. Keeping that distinction in the request rather than in two
// endpoints means the rule has one implementation.
//
// WHY THE HOST FLAG IS HONOURED EVEN FOR A MANUAL TICK
//
// MEASURED: :3000 and :3001 are separate installations sharing ONE local_data
// (realpath C:\dev\common\local_data). The lease stops a turn running twice;
// it does not stop it running in the WRONG TREE, and which tree answered is
// invisible from the screen. Default is "nobody hosts", so a fresh checkout
// runs nothing until someone says where.
//
// ⚠ CORRECTED 2026-11-02. The paragraph above is still true about the PROBLEM
// and became false about the MECHANISM the same day the branches merged. The
// flag is one file in the shared store (トカゲくん measured it: both trees'
// `local_data\runner.json` are the same bytes), so honouring it for the whole
// tick meant the un-named installation refused every send typed into it.
//
// A tick is no longer refused as a whole. Each ITEM names the installation
// that may run it (QueueItem.host), and the flag decides only the items that
// name nobody — anything queued before addressing existed, and anything no
// screen produced (a letter, a timer). "Which tree answered" is now decided by
// which tree was typed into, which is also the one a person is looking at.
//
// NO RULES HERE. Scheduling, exclusivity, the relay and the turn itself live
// in lib.

/** Per-conversation outcome, so a failing pass names what it tried. */
type Outcome = {
  being: string;
  convoId: string;
  ran: boolean;
  /** Why nothing ran, when nothing ran. Never a bare "failed". */
  // 'blocked-here': this being is listed in NEXUS_BLOCKED_BEINGS on this
  // process. Distinct from 'elsewhere' on purpose — 'elsewhere' means another
  // installation CAN run it and this one should say so, while 'blocked-here'
  // means this installation is forbidden to, which is a property of the
  // launcher and not of the queue.
  skipped?: 'busy' | 'empty' | 'elsewhere' | 'auto-trigger-off' | 'claim-failed' | 'blocked-here' | 'context-full' | 'soul-update' | 'min-gap' | 'quiet-only';
  result?: RunTurnResult;
};

/**
 * The name a turn answers to for Stop and interjections.
 *
 * Minted HERE rather than inside runTurnForQueue because the relay has to
 * carry it, and the relay opens before the turn does. Same shape ChatArea
 * uses for a turn it POSTs itself, so /api/chat/active and /api/chat/inject
 * cannot tell the two apart -- which is the point.
 */
const newTurnId = mintTurnId;

function fail(e: unknown, fallback: string) {
  const msg = e instanceof Error ? e.message : fallback;
  return NextResponse.json({ error: msg }, { status: 500 });
}

interface PassOpts {
  auto: boolean;
  /**
   * The clock's kick (or the follow-up for a wake that waited): nobody asked
   * for this turn. Unlike `auto` it does NOT consult the stock checkbox — a
   * wake ignores that — but it IS held while the context is full.
   */
  wake: boolean;
  oneBeing: string;
  oneConvo: string;
  selfId: string;
  /**
   * What `runner.json` says about THIS installation, and who it names.
   *
   * Not "may this pass run" — that question is now per item, answered by
   * `itemIsForThisInstallation`. The flag is only the fallback half of that
   * rule: it decides who runs items with no address on them (anything queued
   * before addressing existed, and anything no screen produced — a letter, a
   * timer). An addressed item runs on the installation it names regardless.
   *
   * Carried as the four-way status rather than a boolean so the sentence this
   * pass can show a person keeps all four meanings. 'unset' and 'unreadable'
   * are both "not the host" for the rule and NEITHER of them is "someone else
   * is the host" for the human.
   */
  hostStatus: RunnerHostStatus;
  hostId?: string;
  origin: string;
  /**
   * The placeholder id a kicking tab is already streaming into. Passed
   * straight through to the runner, which adopts it for the first pass so the
   * tab's end-of-turn reload does not change the React key. See
   * RunTurnDeps.proposedAssistantId.
   */
  assistantMsgId: string;
  /**
   * The name the kicking tab already addresses Stop to.
   *
   * Same bargain as `assistantMsgId` one field up: whoever has to point at the
   * thing FIRST should be the one that names it. Here the stakes are higher
   * than a React key — a press that arrives before the tab learns the name has
   * nowhere to go, and MEASURED 2026-11-04 that cost 8.9 s on a turn the person
   * had already cancelled. See lib/turnName.ts.
   *
   * Declined (not rejected) when malformed, and always overruled by a turn
   * that is already live on this conversation.
   */
  proposedTurnId: string;
  /**
   * A relay this route already opened (the `detach` path). Whatever happens —
   * including nothing at all, because the batch was claimed by someone else —
   * it must be closed, or the tab that is watching waits forever on a turn
   * that is not coming.
   */
  relayConvoId: string | null;
}

async function runPass(opts: PassOpts): Promise<{ attempted: number; ran: number; outcomes: Outcome[] }> {
  const folders = await listFolders();
  const globalSettings = (await loadUserSettings()) || null;
  const holder = `runner:${opts.selfId}`;

  // Bound once and passed to every place THIS PASS looks at an item — the
  // conversation list and the claim — so the two cannot disagree about which
  // items belong here. (GET /api/turn-queue binds its own, from the same
  // predicate: it answers a different request and has no PassOpts.)
  //
  // Declared HERE, above the target list, and not next to the claim: the sweep
  // below uses it, and a `const` used before its declaration is a TDZ throw at
  // runtime (tsc caught it; nothing else would have until a sweep ran).
  const accept = (it: QueueItem) => itemIsForThisInstallation(it, opts.selfId, opts.hostStatus === 'host');

  const targets: Array<{ being: string; convoId: string; settings: Record<string, unknown> }> = [];
  if (opts.oneBeing && opts.oneConvo) {
    const f = folders.find((x: { name: string }) => x.name === opts.oneBeing);
    targets.push({ being: opts.oneBeing, convoId: opts.oneConvo, settings: (f?.settings || {}) as Record<string, unknown> });
  } else {
    for (const f of folders as Array<{ name: string; settings?: Record<string, unknown> }>) {
      // Narrowed: a conversation holding ONLY the other clone's items is not
      // a target at all. Without this the sweep takes its lease, finds
      // nothing it may run, and releases — harmless for data, but the
      // rightful clone gets `busy` if it ticks in that instant, and there is
      // no poll loop to retry (ticks happen on send and on the button).
      for (const row of await queuedConversations(f.name, { accept })) {
        targets.push({ being: f.name, convoId: row.convoId, settings: f.settings || {} });
      }
    }
  }

  const outcomes: Outcome[] = [];
  /** Relays this pass is responsible for closing. */
  const open = new Set<string>(opts.relayConvoId ? [opts.relayConvoId] : []);

  const closeRelay = (convoId: string, note?: { type: string; [k: string]: unknown }) => {
    if (!open.has(convoId)) return;
    open.delete(convoId);
    endTurn(convoId, note);
  };

  try {
    for (const t of targets) {
      const log = await loadLog(t.convoId);

      // The checkbox lives on the CONVERSATION, so it is read from the log
      // and not from folder settings — the same place the client-side drain
      // reads it. A folder default only reaches new conversations.
      if (opts.auto && !autoTriggerEnabled(log?.autoTriggers, 'stock')) {
        outcomes.push({ being: t.being, convoId: t.convoId, ran: false, skipped: 'auto-trigger-off' });
        closeRelay(t.convoId, { type: 'notice', content: 'This conversation does not start by itself.' });
        continue;
      }

      // Everything waiting was left "without waking them" (lib/quietStock.ts):
      // a stock that starts by itself has nothing to start FOR. Only an `auto`
      // pass asks — a person's send, "run it now" and a wake take these items
      // along, which is exactly how they are meant to be delivered.
      if (opts.auto && onlyQuietWaiting((await pending(t.being, t.convoId)).filter((it) => accept(it)))) {
        outcomes.push({ being: t.being, convoId: t.convoId, ran: false, skipped: 'quiet-only' });
        closeRelay(t.convoId, { type: 'notice', content: 'Only messages left without waking are waiting; they go with the next turn.' });
        continue;
      }

      // An automatic soul update is under way for this being (this process
      // started it): wait, and let the strongest waiting pass be the one that
      // runs in the new conversation.
      const autoRun = autoSoulRun<PassOpts>(t.being);
      if (autoRun) {
        autoRun.opts = strongerPass(autoRun.opts, { ...opts, oneBeing: t.being, assistantMsgId: '', proposedTurnId: '', relayConvoId: null });
        outcomes.push({ being: t.being, convoId: t.convoId, ran: false, skipped: 'soul-update' });
        closeRelay(t.convoId, { type: 'notice', content: 'The soul is being updated. The message waits in the stock and runs in the new conversation when the update ends.' });
        continue;
      }

      // Due to sleep by itself (switch on, context at 100%) and something that
      // can start a turn is waiting → update instead of taking the turn. Not
      // while a manual update runs (that hold is below), not while a turn is
      // mid-flight here, and not for the same items a failed attempt already
      // saw — only a NEW reason tries again.
      if (autoSoulUpdateDue(log as Record<string, unknown> | null, t.settings) && !beingIsBlockedHere(t.being) && !(await soulUpdateRunning(t.being))) {
        const lease = await readLease(t.being, t.convoId);
        const busy = !!lease && !holderIsGone(lease.pid);
        const waiting = busy ? [] : (await pending(t.being, t.convoId)).filter((it) => accept(it) && startsAutoSoul(it)).map((it) => it.id);
        if (hasNewReason(await readAutoSoulStatus(t.being), t.convoId, waiting)) {
          console.log(`[runner] ${t.being}/${t.convoId} is at 100% with automatic soul update on — updating before any turn`);
          startAutoSoulUpdate(t.being, t.convoId, opts);
          outcomes.push({ being: t.being, convoId: t.convoId, ran: false, skipped: 'soul-update' });
          closeRelay(t.convoId, { type: 'notice', content: 'This conversation is at 100% of its log cap: the soul is being updated first. The message waits in the stock and runs in the new conversation.' });
          continue;
        }
      }

      // Context at 100% → turns nobody asked for wait (つよ, 2026-11-17). Before
      // the claim, so nothing is taken out of the stock: the items stay exactly
      // where they are. A person's send, "run it now" and ζ never set either
      // flag and are not held. See lib/autoHold.ts.
      if (passIsUnattended(opts) && autoTurnsHeldForLog(log as Record<string, unknown> | null, t.settings)) {
        outcomes.push({ being: t.being, convoId: t.convoId, ran: false, skipped: 'context-full' });
        console.log(`[runner] held ${t.being}/${t.convoId}: context is at 100%, automatic turns wait`);
        closeRelay(t.convoId, { type: 'notice', content: 'Automatic turns are waiting: this conversation is at 100% of its log cap.' });
        continue;
      }

      // The minimum interval between automatic turns (トカゲくん, 2026-11-28;
      // lib/autoGap.ts). Before the claim, like the hold above: the items stay
      // in the stock, and the clock's next cycle (or the tab's own timer) comes
      // back for them. A person's send, "run it now" and ζ are not unattended
      // and never reach this.
      if (passIsUnattended(opts)) {
        const gap = await autoGapStatusFor(t.being, t.settings);
        if (gap.remainingMs > 0) {
          outcomes.push({ being: t.being, convoId: t.convoId, ran: false, skipped: 'min-gap' });
          // Said once per wait, not on every 30 s retry.
          const said = ((globalThis as { __memorhizaGapSaid?: Map<string, number> }).__memorhizaGapSaid ??= new Map());
          if (said.get(t.being) !== gap.lastAt) {
            said.set(t.being, gap.lastAt ?? 0);
            console.log(`[runner] held ${t.being}/${t.convoId}: ${Math.ceil(gap.remainingMs / 60_000)} min left of the ${gap.minGapMin}-min interval between automatic turns`);
          }
          closeRelay(t.convoId, { type: 'notice', content: `Automatic turns are waiting: ${Math.ceil(gap.remainingMs / 60_000)} min left of this being's minimum interval (${gap.minGapMin} min).` });
          continue;
        }
      }

      // A soul update is running for this being → NOTHING starts, a person's
      // send included (トカゲくん, 2026-11-20). Before the claim, so the items
      // stay in the stock; watchSoulHold comes back for them. See
      // lib/soulUpdateHold.ts for what counts as "running".
      const soulRun = await soulUpdateRunning(t.being);
      if (soulRun) {
        outcomes.push({ being: t.being, convoId: t.convoId, ran: false, skipped: 'soul-update' });
        console.log(`[runner] held ${t.being}/${t.convoId}: soul update ${soulRun.label} is running`);
        closeRelay(t.convoId, { type: 'notice', content: 'The soul is being updated. The message waits in the stock and runs when the update ends.' });
        watchSoulHold(t.being, t.convoId, opts);
        continue;
      }

      // NEXUS_BLOCKED_BEINGS — the last door. The queue route already refuses
      // to enqueue or claim for a blocked being, so reaching here means an item
      // was queued by ANOTHER installation (one store, two clones) and this
      // tick happened to look at it. Refuse rather than claim: a claim is this
      // installation declaring "I will run this", which is the single thing the
      // variable forbids. Checked before `claim` so no lease is ever taken.
      if (beingIsBlockedHere(t.being)) {
        outcomes.push({ being: t.being, convoId: t.convoId, ran: false, skipped: 'blocked-here' });
        console.log(`[runner] skipped ${t.being}/${t.convoId}: blocked-here (NEXUS_BLOCKED_BEINGS)`);
        continue;
      }

      const c = await claim(t.being, t.convoId, holder, { accept });
      if (!c.ok) {
        // 'elsewhere' is split out of 'empty' because the two need opposite
        // reactions: an empty stock is normal and silent, while a stock full
        // of another clone's messages means THIS tick can never drain it and
        // the person should be told which installation can.
        const elsewhere = c.reason === 'empty' && c.elsewhere > 0;
        const skipped = c.reason === 'busy' ? 'busy'
          : elsewhere ? 'elsewhere'
          : c.reason === 'empty' ? 'empty'
          : 'claim-failed';
        outcomes.push({ being: t.being, convoId: t.convoId, ran: false, skipped });
        if (skipped !== 'empty') console.log(`[runner] skipped ${t.being}/${t.convoId}: ${skipped}`);
        closeRelay(t.convoId, {
          type: 'notice',
          content: elsewhere
            ? `Nothing ran here: ${(c as { elsewhere: number }).elsewhere} queued message(s) are addressed to a different installation of Memorhiza. ${describeRunnerHost(opts.hostStatus, opts.selfId, opts.hostId)}`
            : `Nothing ran: ${skipped}.`,
        });
        continue;
      }

      // An automatic turn starts here: note the time (the interval is counted
      // from this, and again from its end below).
      if (passIsUnattended(opts)) await recordAutoTurn(t.being, t.convoId, 'start');

      // A relay for a turn that is ABOUT to produce frames. Not opened before
      // the claim: a pass that skips must not clear the relay of a turn that
      // another pass is already streaming into.
      // The RELAY is the single source of this turn's id: a tab that is
      // already watching read it from there, and minting a second one here
      // would leave Stop pointing at a turn that does not exist.
      const existing = liveTurnStatus(t.convoId);
      // One derivation, shared with the tests: live wins, then a well-formed
      // proposal from the kicking tab, then a fresh mint.
      const named = resolveTurnName(
        existing?.live === true ? existing.turnId : null,
        opts.proposedTurnId || undefined,
        newTurnId,
      );
      const turnId = named.turnId;
      if (named.isNew) {
        beginTurn(t.convoId, turnId);
        open.add(t.convoId);
      }

      // Watch for an explicit Stop so a cancel can be told from a failure.
      // Registered HERE, before the turn starts, because this route knows the
      // turnId first and requestStop fires every listener for the key — the
      // chat route's (which aborts the generation) and this one (which only
      // records that it happened). A callback, not isStopRequested read later:
      // the chat route calls forgetStop the instant it aborts, so by the time
      // runTurnForQueue's throw is caught the record is already gone.
      let stopped = false;
      // Ends the anchor calls on Stop (the chat route's own listener only
      // covers the being's pass, and is gone by the time the anchor runs).
      const stopCtl = new AbortController();
      const offStop = onStop(t.convoId, turnId, () => {
        stopped = true;
        try { stopCtl.abort(); } catch { /* already aborted */ }
        // Stop also silences a reply the server is still reading for this turn.
        serverSpeech().stop({ convoId: t.convoId });
      });

      // Stocks this turn wrote into with `[->name]` — kicked after the turn ends.
      const routed: Array<{ being: string; convoId: string }> = [];
      let result: RunTurnResult;
      try {
        result = await runTurnForQueue(t.being, t.convoId, c.claim.items, {
          wasStopped: () => stopped,
          stopSignal: stopCtl.signal,
          loadLog,
          saveLog,
          chatPost,
          globalSettings,
          // ⚠ WAS `t.settings.enableReadConversation === true` until 2026-11-02.
          // No being has that key — it is the name of the REQUEST field, not of
          // the stored setting, so every runner turn silently had no
          // conversation tools (トカゲくん measured it on the work PC: the flag
          // was ticked and the tools were absent). The translating line lived
          // in the deleted browser turn engine. See conversationToolsEnabled.
          enableReadConversation: conversationToolsEnabled(t.settings),
          folderDefaults: {
            // WAS `String(t.settings.aiName || '')` until 2026-11-08, when the
            // per-being `settings.aiName` was removed. Two reasons this is the
            // fallback constant and not a derivation:
            //   · it is unreachable in practice — turnInputFromLog prefers the
            //     LOG's own aiName, and all 320 logs in this house carry one
            //     (measured 2026-11-08), so this value is only consulted for a
            //     log that has no vessel recorded at all;
            //   · deriving it would mean reading every log header of the being
            //     from the server for a branch that never runs.
            // What it fixes is the old empty string: routing a turn to family
            // "" is not a smaller error than routing it to a named family, it
            // is the same error with nothing to read in the log afterwards.
            aiName: FALLBACK_FAMILY,
            folderName: t.being,
            systemPrompt: String(t.settings.systemPrompt || ''),
            specificModel: String(t.settings.specificModel || ''),
            modelParams: (t.settings.modelParams || {}) as Record<string, unknown>,
          },
          newId: () => crypto.randomUUID(),
          wakeAdminNote: async (now) => (await import('@/lib/wakeAdminNotesStore')).adminNoteAt(now),
          proposedAssistantId: opts.assistantMsgId || undefined,
          nowMs: () => Date.now(),
          clientId: holder,
          // The route reads the body, not the host — but a Request needs a URL,
          // and using the incoming one means a failing turn names the port it
          // was aimed at rather than a port this file invented.
          origin: opts.origin,
          onRawText: (text) => publishTurnText(t.convoId, text),
          injectTurnId: turnId,
          // So a mid-turn interjection that found no tool boundary is reported
          // on the reply instead of vanishing. Passed in rather than imported
          // inside the runner, so a test can supply a known set.
          takeUndelivered,
          // The anchor (錨), run automatically on the finished reply when the
          // log's anchor settings say so. Same executor as the manual button.
          // `[->name]`: plan from the finished reply; the runner calls `deliver`
          // after its save. What was delivered is remembered for the kick below.
          planRoutes: async (a) => {
            const plan = await planBeingRoutes(a);
            if (!plan) return null;
            return {
              records: plan.records,
              notice: plan.notice,
              deliver: async () => { routed.push(...await plan.deliver()); },
            };
          },
          // Server-side read-aloud. Answers at once unless the house reads from
          // the server; the voice is the being's own (settings.json).
          speakReply: async (a) => {
            if (speechModeFromSettings(globalSettings) !== 'server') return;
            const q = serverSpeech();
            q.setMode('server');
            const pitch = Number(t.settings?.voicePitch);
            const sentences = assistantSpeechSentences(
              a.content,
              (t.settings?.aiVoice as Record<string, unknown> | undefined) ?? null,
              Number.isFinite(pitch) ? pitch : 0,
            );
            if (!sentences.length) return;
            await q.speak(
              { messageId: a.messageId, convoId: t.convoId, folderName: t.being, isUser: false, sentences },
              a.onPhrase,
            );
          },
          runAnchor: async (a) => {
            const r = await execAnchor({
              messages: a.messages as AnchorMessage[],
              targetId: a.targetId,
              folder: t.being,
              convoId: t.convoId,
              lang: a.lang,
              settings: a.settings,
              origin: opts.origin,
              chatPost,
              onDelta: a.onDelta,
              signal: a.signal,
            });
            return r.ok ? r.report : null;
          },
          runAnchorRewrite: async (a) => {
            const r = await execAnchor({
              messages: a.messages as AnchorMessage[],
              targetId: a.targetId,
              folder: t.being,
              convoId: t.convoId,
              lang: a.lang,
              settings: a.settings,
              origin: opts.origin,
              chatPost,
              promptFile: ANCHOR_REWRITE_FILE,
              wrapUserMsg: (m) => buildRewriteUserMsg(m, a.convLang, a.lang),
              onDelta: a.onDelta,
              signal: a.signal,
            });
            return r.ok ? r.report : null;
          },
        });
      } catch (e) {
        offStop();
        endRegistryTurn(t.convoId, turnId);
        // runTurnForQueue returns its failures; reaching here means something
        // outside its own error handling threw. The lease still has to go back
        // and the watcher still has to be told, or a crash in one turn leaves
        // the conversation permanently "running".
        const reason = String((e as Error)?.message || e);
        // STAMP BEFORE ABANDON — the lease is the only thing keeping another
        // pass off this batch (see markReturned). `classifyReturn` with no
        // stage gives `failed`, which is the honest answer here: a throw from
        // outside the runner's own handling tells us nothing about how far it
        // got, and the items it DID consume are simply not on disk to stamp.
        await markReturned(
          t.being, t.convoId, c.claim.token,
          c.claim.items.map((i) => i.id),
          { at: Date.now(), kind: classifyReturn(null), reason },
        );
        await abandon(t.being, t.convoId, c.claim.token);
        outcomes.push({ being: t.being, convoId: t.convoId, ran: false, result: { ok: false, stage: 'post', reason, consumedIds: [] } });
        closeRelay(t.convoId, { type: 'error', error: reason });
        continue;
      }

      offStop();
      // ── Retire the cross-tab registry entry ─────────────────────────────
      // The chat route registers a turn when it starts one and retires it on
      // `req.signal` abort — but the runner's POST ends by RETURNING, not by
      // aborting, so for a server-side turn that listener never fires and the
      // entry lingers until its 25s TTL.
      //
      // MEASURED 2026-10-31 (ふわふわ): after the answer landed, the tab that
      // SENT it also showed "running somewhere else", and both tabs kept
      // saying so for a few seconds. The turn was over; the registry had not
      // been told. A cross-tab warning that outlives its turn is the exact
      // shape this house refuses — a control that reports a state nobody is
      // in. Now the entry dies with the turn, and the TTL is back to being a
      // backstop instead of the normal path.
      endRegistryTurn(t.convoId, turnId);

      // WHICH ids are done is the runner's answer, not this route's.
      //
      // It used to be `every id we handed over`, which was right while a batch
      // could only be a run of user messages. It stopped being right the
      // moment rerun/continue existed: the runner takes only the LEADING run
      // of one shape, so the rest of a mixed batch was never answered and
      // releasing it here would delete those messages silently. The runner
      // also consumes a few FAILURES on purpose (a command whose target is
      // gone is permanent — abandoning it re-fires it forever).
      //
      // An empty list means abandon: the lease goes back, the items stay, the
      // auto-trigger signature is unchanged, and an instantly-failing turn
      // cannot re-fire forever.
      // Self-set wake (P5): read the reply just saved for `[->wakeup: HH:MM]`.
      // After the save, never instead of it; a booking problem is logged, not
      // thrown, so it cannot fail a finished turn.
      if (result.ok) {
        try {
          const saved = await loadLog(t.convoId);
          const msgs = (saved?.messages || []) as Array<{ id?: string; role?: string; content?: unknown }>;
          const reply = msgs.find((m) => m.id === result.messageId) || [...msgs].reverse().find((m) => m.role === 'assistant');
          if (reply && typeof reply.content === 'string') await recordSelfWakeFromReply(t.being, reply.content, t.settings);
        } catch { /* see recordSelfWakeFromReply */ }
      }

      if (result.consumedIds.length > 0) {
        await release(t.being, t.convoId, c.claim.token, result.consumedIds);
      } else {
        // F20: say WHY it is coming back, on the item, before the lease goes.
        //
        // Only for `!ok`. An `ok` pass that consumed nothing is abandon's
        // other meaning — "nothing to answer, let the next poll retry" — and
        // stamping that as a failure would be a sentence promising a cause it
        // does not have, which is the thing classifyReturn refuses to do.
        if (!result.ok) {
          await markReturned(
            t.being, t.convoId, c.claim.token,
            c.claim.items.map((i) => i.id),
            { at: Date.now(), kind: classifyReturn(result.stage), reason: result.reason },
          );
        }
        await abandon(t.being, t.convoId, c.claim.token);
      }
      outcomes.push({ being: t.being, convoId: t.convoId, ran: result.ok, result });
      // …and ends here, however it ended. BEFORE the follow-up passes below,
      // so a wake or a stocked message left waiting is spaced from this turn.
      if (passIsUnattended(opts)) await recordAutoTurn(t.being, t.convoId, 'end');
      // A message left "without waking them" WHILE this turn ran could not be
      // written into the log then (the turn had it). The lease is back now, so
      // it goes in — no model call. Before the follow-ups below, which then see
      // a stock without it. See lib/quietLeave.ts.
      try { await leaveQuietMessages(t.being, t.convoId, opts.selfId); }
      catch (e) { console.warn('[runner] could not write a quiet message into the log:', e); }
      // ── A NEXUS item that WAITED runs right now (2026-11-15, つよ) ─────────
      // A wake that fires while the being is answering finds the lease taken
      // and stays in the stock; the clock used to retry it on its next cycle
      // (up to TICK_MS later — 33 s on 2026-11-15 21:34). "Wait, then send
      // straight after" is the rule, so a finished turn checks for one and
      // starts the next pass itself. NOT `auto`: a NEXUS item ignores the
      // stock-trigger checkbox, exactly as the clock's own kick does. Messages
      // stocked in front of it ride along into the same turn (splitLeadingTurn).
      if (result.ok) {
        try {
          const left = await pending(t.being, t.convoId);
          const sys = left.filter((it) => it.kind === 'system' && accept(it));
          if (sys.length) {
            // Only wakes waiting → still a turn nobody asked for (held at 100%).
            // A ζ item among them has a button press behind it and is not.
            const wake = sys.every(isWakeItem);
            setTimeout(() => {
              void runPass({ ...opts, auto: false, wake, oneBeing: t.being, oneConvo: t.convoId, assistantMsgId: '', proposedTurnId: '', relayConvoId: null })
                .catch((e) => console.warn('[runner] follow-up Memorhiza pass failed:', e));
            }, 0);
          } else if (left.some((it) => accept(it))) {
            // Something arrived in the stock WHILE this turn ran (another being's
            // `[->name]`, with no tab open to notice). `auto: true`, so it runs
            // only when this conversation's "stocked messages" reason is on.
            setTimeout(() => {
              void runPass({ ...opts, auto: true, wake: false, oneBeing: t.being, oneConvo: t.convoId, assistantMsgId: '', proposedTurnId: '', relayConvoId: null })
                .catch((e) => console.warn('[runner] follow-up stock pass failed:', e));
            }, 0);
          }
        } catch { /* the clock retries on its next cycle anyway */ }
      }
      // ── `[->name]`: the stocks this turn wrote into ─────────────────────────
      // Putting a message in a stock starts nothing by itself (つよ: when the
      // other being reads is the OTHER being's setting). So this is an `auto`
      // pass: it runs only where "stocked messages" is ticked, and is skipped
      // as busy when that being is mid-turn — its own turn end picks it up.
      for (const r of routed) {
        setTimeout(() => {
          void runPass({ ...opts, auto: true, wake: false, oneBeing: r.being, oneConvo: r.convoId, assistantMsgId: '', proposedTurnId: '', relayConvoId: null })
            .catch((e) => console.warn('[runner] routed-stock pass failed:', e));
        }, 0);
      }
      // F46: a runner that says nothing is indistinguishable from one that is
      // broken — and the only person who can read this is whoever opens the
      // server console, because a detached pass has no response to answer in.
      console.log(
        result.ok
          ? `[runner] ran ${t.being}/${t.convoId} — saved ${result.messageId}`
          : result.stage === 'stopped'
            ? `[runner] stopped ${t.being}/${t.convoId} — cancelled by request`
            : `[runner] FAILED ${t.being}/${t.convoId} at ${result.stage}: ${result.reason}`,
      );
      // A stop is not an error: the watcher gets a notice, not an error frame.
      closeRelay(
        t.convoId,
        result.ok ? undefined
        : result.stage === 'stopped' ? { type: 'notice', content: 'Stopped.' }
        : { type: 'error', error: result.reason },
      );
    }
  } finally {
    // Nothing may leave a watcher hanging — including a target list that never
    // reached the conversation the relay was opened for.
    for (const convoId of [...open]) closeRelay(convoId, { type: 'notice', content: 'The runner finished without starting this turn.' });
  }

  return { attempted: targets.length, ran: outcomes.filter((o) => o.ran).length, outcomes };
}

export async function POST(req: Request) {
  try {
    // Fallback start for the wake clock (instrumentation.ts is the main one).
    ensureWakeClock();
    let body: Record<string, unknown> = {};
    try { body = (await req.json()) || {}; } catch { /* {} is a valid tick */ }

    const auto = body.auto === true;
    const wake = body.wake === true;
    const detach = body.detach === true;
    const oneBeing = typeof body.being === 'string' ? body.being.trim() : '';
    const oneConvo = typeof body.convoId === 'string' ? body.convoId.trim() : '';
    // Only meaningful alongside a single being+convo: it names ONE placeholder.
    // A sweep over every being has no tab behind it and leaves this empty.
    const assistantMsgId = typeof body.assistantMsgId === 'string' ? body.assistantMsgId.trim() : '';
    // Same scope as assistantMsgId: it names ONE turn. Shape-checked by
    // resolveTurnName at the point of use, not trusted here.
    const proposedTurnId = typeof body.turnId === 'string' ? body.turnId.trim() : '';
    const origin = new URL(req.url).origin;

    // ── Who may run turns for this store ──────────────────────────────────
    const selfId = await installationId();
    let status = await runnerHostStatus(selfId);

    // Nobody holds the role, and a TAB is behind this tick: take it.
    //
    // Gated on `detach` and not on every tick. MEASURED 2026-10-31: `detach:
    // true` has exactly ONE caller in the whole source (ChatArea's
    // runOnRunner), so a detach tick always has a browser pointed at this
    // port behind it. A sweep tick — no being, no convoId — has nobody
    // behind it, and letting that claim would hand the role to whichever
    // installation happened to poll first. That is precisely the race the
    // "nobody hosts" default in runnerHost.ts exists to prevent, so the
    // default is kept for sweeps and relaxed only where a person acted.
    //
    // Race-free by construction: claimRunnerHostIfUnset writes with
    // `flag: 'wx'`, so of two installations claiming in the same instant
    // exactly one write lands and the loser gets EEXIST. Both then re-read,
    // both agree, and the loser returns the sentence below. The status is
    // re-read rather than inferred from the return value because the record
    // on disk is the authority and a human could have cleared it in between.
    let claimOutcome: 'claimed' | 'taken' | 'failed' | null = null;
    if (status === 'unset' && detach) {
      claimOutcome = await claimRunnerHostIfUnset(selfId, { note: 'claimed automatically by the first server-side turn' });
      status = await runnerHostStatus(selfId);
    }

    // ⚠ A WHOLE-TICK REFUSAL STOOD HERE until 2026-11-02 and was wrong once
    // two clones shared one store:
    //
    //     if (status !== 'host') return { skipped: 'not-host' }
    //
    // MEASURED (トカゲくん, 2026-11-02): `C:\dev\nexus\local_data\runner.json`
    // and `C:\dev\nexus-cairn\local_data\runner.json` are THE SAME FILE — the
    // store is shared by junction. So the flag can name exactly one of the two
    // installations, and after the merge the other one has runner code and
    // refuses here: a message typed into it is stocked and never runs.
    //
    // The gate is now PER ITEM (`itemIsForThisInstallation`), because the
    // question the flag actually answers is "who runs an item that names
    // nobody". Addressing changes which answers are possible, not which
    // question is being asked — see the field doc on QueueItem.host.
    //
    // `status` is still read, still carried, and still turns into a sentence:
    // it decides un-addressed items, and `claim` reporting `elsewhere` is what
    // reaches a person when a stock belongs to the other clone.
    const hostRecord = status === 'not-host' ? await readRunnerHost().catch(() => null) : null;

    // Carried on every answer below, not just a refusal, because the thing a
    // person needs to know changed shape: a tick no longer stops at the flag,
    // so "did it run?" and "what does the flag say?" are separate facts and
    // both belong in the response. `claim: 'failed'` is the ONE outcome no
    // status word covers — the role was unclaimed, this turn tried to take it,
    // and the write did not land, which means the store may be read-only.
    const hostNote = {
      hostStatus: status,
      ...(status !== 'host' ? { hostReason: describeRunnerHost(status, selfId, hostRecord?.host) } : {}),
      ...(claimOutcome ? { claim: claimOutcome } : {}),
    };

    if (detach) {
      if (!oneBeing || !oneConvo) {
        return NextResponse.json(
          { ok: false, reason: 'detach needs both being and convoId — a background pass over every being has no one watching it' },
          { status: 400 },
        );
      }
      // Already streaming: do NOT start a second pass. The claim would refuse
      // it anyway, and opening a second relay would disconnect whoever is
      // watching the first. The caller subscribes to the live one instead —
      // which is two tabs on one turn, the thing 4d is for.
      if (liveTurnStatus(oneConvo)?.live === true) {
        return NextResponse.json({ ok: true, started: false, attached: true, host: selfId });
      }
      // THE site that matters for Stop latency: `detach: true` has exactly one
      // caller in the source (ChatArea's runOnRunner), so this is the path a
      // tab takes when a person presses Send. Adopting the name it already
      // minted means its Stop is addressable from before this request returns,
      // instead of two round-trips later. `liveTurnStatus` was checked just
      // above, hence `null` for the live argument.
      const named = resolveTurnName(null, proposedTurnId || undefined, newTurnId);
      const turnId = named.turnId;
      beginTurn(oneConvo, turnId);
      void runPass({ auto, wake, oneBeing, oneConvo, selfId, hostStatus: status, hostId: hostRecord?.host, origin, assistantMsgId, proposedTurnId, relayConvoId: oneConvo })
        .catch((e) => {
          console.error('[runner] detached pass threw:', e);
          endTurn(oneConvo, { type: 'error', error: String((e as Error)?.message || e) });
        });
      return NextResponse.json({ ok: true, started: true, attached: false, host: selfId, turnId, ...hostNote });
    }

    const r = await runPass({ auto, wake, oneBeing, oneConvo, selfId, hostStatus: status, hostId: hostRecord?.host, origin, assistantMsgId, proposedTurnId, relayConvoId: null });
    return NextResponse.json({ ok: true, host: selfId, auto, ...r, ...hostNote });
  } catch (e) {
    return fail(e, 'the runner tick failed');
  }
}
