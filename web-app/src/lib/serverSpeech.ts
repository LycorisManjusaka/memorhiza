/**
 * Reading aloud FROM THE SERVER — one voice queue for the whole installation.
 *
 * WHY (つよ, 2026-11-17). Read-aloud used to exist only inside a browser tab:
 * the tab synthesised, the tab played, the tab highlighted. A turn the runner
 * starts needs no tab at all, so an autonomous turn in an audio session was
 * silent unless somebody happened to have the conversation open — and two tabs
 * on the same conversation each played it. With "read aloud: server" in
 * Preferences the NEXUS process itself plays the voice on the machine's default
 * output; tabs only DISPLAY it (highlight, pause/stop buttons), and any number
 * of them show the same phrase at the same moment.
 *
 * ONE QUEUE, on purpose. Two beings in two conversations answering each other
 * through `[->name]` must take turns at the speaker, not talk over each other.
 *
 * WHAT IT CANNOT DO, said here so nobody reads it out of the UI:
 *   - It plays on the DEFAULT output device only. The tab path can route to two
 *     chosen devices (VRChat mode); a Node process has no setSinkId. Unmeasured
 *     whether a per-device player is practical — not attempted.
 *   - "Pause" stops the current phrase and "resume" replays that phrase from
 *     its start. The player (System.Media.SoundPlayer) has no pause.
 *   - Browser-only voices (Web Speech, Gemini Live) are not reachable from here.
 *
 * The queue logic is a class with injected `synth` and `play`, so a test drives
 * it with fakes; `serverSpeech()` is the one real instance, kept on globalThis
 * because a dev server hands each route its own module instance (see turnBus).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import type { TtsSegment } from '@/lib/ttsSentences';

export type SpeechMode = 'tab' | 'server';
export type PlayEnd = 'ended' | 'killed' | 'failed';
export interface PlayHandle { done: Promise<PlayEnd>; kill: () => void }

export interface SpeakRequest {
  messageId: string;
  convoId?: string;
  /** Being folder — selects the pronunciation dictionary. */
  folderName?: string;
  isUser?: boolean;
  sentences: TtsSegment[];
}

export interface SpeechCurrent {
  messageId: string;
  convoId: string;
  isUser: boolean;
  /** 0-based index of the phrase now sounding; -1 while the first is being synthesised. */
  index: number;
  total: number;
  text: string;
  paused: boolean;
  failed: number;
  lastError: string;
}
export interface SpeechSnapshot { mode: SpeechMode; current: SpeechCurrent | null; queued: number }

export interface SpeechDeps {
  /** One phrase -> WAV bytes; null = nothing speakable in it. */
  synth: (seg: TtsSegment, folderName: string) => Promise<Buffer | null>;
  play: (wav: Buffer) => PlayHandle;
}

/**
 * Time limits (トカゲくん, 2026-11-17). Without them one engine that never
 * answered — or a player that never said `done` — held the queue's only slot
 * for ever; the runner awaits the voice while holding the turn lease, so the
 * conversation sat on "thinking" with nothing running, and Stop could not get
 * the queue out because the await it was stuck in was not one Stop touched.
 */
export const SYNTH_TIMEOUT_MS = 90_000; // an engine may have to start first
export const PLAY_SLACK_MS = 15_000;    // on top of the WAV's own length
export const PLAY_FALLBACK_MS = 180_000; // when the header gives no length

/** Seconds of audio in a canonical WAV, or null when the header is not one. */
export function wavSeconds(wav: Buffer): number | null {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return null;
  const byteRate = wav.readUInt32LE(28);
  if (!byteRate) return null;
  return Math.max(0, wav.length - 44) / byteRate;
}

function timeout<T>(ms: number, value: T): { p: Promise<T>; clear: () => void } {
  let id: ReturnType<typeof setTimeout> | undefined;
  // unref: a limit on a phrase must not keep the process alive by itself.
  const p = new Promise<T>((r) => { id = setTimeout(() => r(value), ms); (id as { unref?: () => void }).unref?.(); });
  return { p, clear: () => { if (id) clearTimeout(id); } };
}

interface Job extends SpeakRequest {
  cancelled: boolean;
  /** Settles the moment the job is stopped — every await in pump races it. */
  cancelSignal: Promise<void>;
  fireCancel: () => void;
  index: number;
  text: string;
  failed: number;
  lastError: string;
  resolve: (how: 'done' | 'stopped') => void;
  onPhrase?: (index: number, total: number) => void;
}

export class SpeechQueue {
  private jobs: Job[] = [];
  private current: Job | null = null;
  private paused = false;
  private running = false;
  private playing: PlayHandle | null = null;
  private wake: (() => void) | null = null;
  private listeners = new Set<(s: SpeechSnapshot) => void>();
  private mode: SpeechMode = 'tab';

  constructor(private deps: SpeechDeps) {}

  getMode(): SpeechMode { return this.mode; }
  setMode(m: SpeechMode): void {
    if (m === this.mode) return;
    this.mode = m;
    // Leaving server mode must not leave a voice nobody can stop from a tab.
    if (m === 'tab') this.stop();
    this.emit();
  }

  snapshot(): SpeechSnapshot {
    const j = this.current;
    return {
      mode: this.mode,
      queued: this.jobs.length,
      current: j ? {
        messageId: j.messageId, convoId: j.convoId || '', isUser: !!j.isUser,
        index: j.index, total: j.sentences.length, text: j.text,
        paused: this.paused, failed: j.failed, lastError: j.lastError,
      } : null,
    };
  }

  subscribe(fn: (s: SpeechSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
    const s = this.snapshot();
    for (const fn of [...this.listeners]) { try { fn(s); } catch { /* a dead listener must not stop the voice */ } }
  }

  /**
   * Queue a message. Resolves when its last phrase has ended, or when it was
   * stopped — the runner awaits this so "read, THEN send `[->name]`" holds.
   */
  speak(req: SpeakRequest, onPhrase?: (index: number, total: number) => void): Promise<'done' | 'stopped'> {
    if (!req.sentences.length) return Promise.resolve('done');
    return new Promise((outer) => {
      // Once only: Stop answers the caller at once, and pump answers again
      // when it gets out of whatever it was awaiting.
      let answered = false;
      const resolve = (how: 'done' | 'stopped') => { if (!answered) { answered = true; outer(how); } };
      let fireCancel = () => {};
      const cancelSignal = new Promise<void>((r) => { fireCancel = r; });
      this.jobs.push({ ...req, cancelled: false, cancelSignal, fireCancel, index: -1, text: '', failed: 0, lastError: '', resolve, onPhrase });
      this.emit();
      void this.pump();
    });
  }

  /** Stop what matches; with no filter, everything (current and queued). */
  stop(filter?: { messageId?: string; convoId?: string }): void {
    const hit = (j: Job) =>
      !filter || (!filter.messageId && !filter.convoId) ||
      (!!filter.messageId && j.messageId === filter.messageId) ||
      (!!filter.convoId && j.convoId === filter.convoId);
    const dropped = this.jobs.filter(hit);
    this.jobs = this.jobs.filter((j) => !hit(j));
    for (const j of dropped) { j.cancelled = true; j.fireCancel(); j.resolve('stopped'); }
    if (this.current && hit(this.current)) {
      const j = this.current;
      j.cancelled = true;
      this.paused = false;
      this.playing?.kill();
      this.wake?.();
      // Answer the runner NOW, not when pump gets out — it may be stuck in an
      // engine that never answers, and the runner holds the turn lease meanwhile.
      j.fireCancel();
      j.resolve('stopped');
      // And stop PAINTING it now: a stuck engine must not leave a phrase lit.
      this.current = null;
    }
    this.emit();
  }

  pause(): void {
    if (!this.current || this.paused) return;
    this.paused = true;
    this.playing?.kill();
    this.emit();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.wake?.();
    this.emit();
  }

  private waitWhilePaused(job: Job): Promise<void> {
    if (!this.paused || job.cancelled) return Promise.resolve();
    return new Promise((r) => { this.wake = () => { this.wake = null; r(); }; });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobs.length) {
        const job = this.jobs.shift()!;
        this.current = job;
        this.paused = false;
        this.emit();
        const fail = (i: number, msg: string): null => {
          job.failed++;
          job.lastError = msg.slice(0, 300);
          console.warn(`[tts/server] phrase ${i + 1}/${job.sentences.length} failed: ${job.lastError}`);
          return null;
        };
        const synthAt = (i: number): Promise<Buffer | null> => {
          const lim = timeout(SYNTH_TIMEOUT_MS, 'timeout' as const);
          return Promise.race([
            this.deps.synth(job.sentences[i], job.folderName || '').catch((e) => fail(i, String((e as Error)?.message || e))),
            lim.p.then(() => fail(i, `the engine did not answer in ${SYNTH_TIMEOUT_MS / 1000}s`)),
          ]).finally(lim.clear);
        };
        // One phrase is synthesised ahead while the previous one sounds.
        let next: Promise<Buffer | null> = synthAt(0);
        for (let i = 0; i < job.sentences.length && !job.cancelled; i++) {
          const wav = await Promise.race([next, job.cancelSignal.then(() => null)]);
          if (i + 1 < job.sentences.length && !job.cancelled) next = synthAt(i + 1);
          if (job.cancelled) break;
          // 44 bytes is a WAV header with no samples.
          if (!wav || wav.length <= 44) continue;
          job.index = i;
          job.text = job.sentences[i].text;
          this.emit();
          try { job.onPhrase?.(i, job.sentences.length); } catch { /* reporting only */ }
          for (;;) {
            await this.waitWhilePaused(job);
            if (job.cancelled) break;
            const h = this.deps.play(wav);
            this.playing = h;
            const secs = wavSeconds(wav);
            const lim = timeout(secs == null ? PLAY_FALLBACK_MS : secs * 1000 + PLAY_SLACK_MS, 'stuck' as const);
            const raced = await Promise.race([h.done, lim.p, job.cancelSignal.then(() => 'killed' as const)]);
            lim.clear();
            let how: PlayEnd;
            if (raced === 'stuck') {
              // The player never reported the end of a phrase whose length we know.
              h.kill();
              how = 'failed';
            } else how = raced;
            this.playing = null;
            if (how === 'failed') { job.failed++; job.lastError = 'the player could not play this phrase'; }
            // Killed by pause: wait, then replay this phrase. Anything else moves on.
            if (how === 'killed' && this.paused && !job.cancelled) continue;
            break;
          }
        }
        if (this.current === job) this.current = null;
        this.paused = false;
        this.emit();
        job.resolve(job.cancelled ? 'stopped' : 'done');
      }
    } finally {
      this.running = false;
    }
  }
}

// ── the real player ─────────────────────────────────────────────────────────

/**
 * Windows: ONE long-lived PowerShell that plays each path it is handed on
 * stdin and answers `done` / `fail`. Spawning per phrase costs ~300 ms of
 * PowerShell start-up between sentences; this pays it once. Not `detached`
 * (a detached PowerShell gets no console and silently does nothing here).
 * Paths are ASCII by construction (tmpdir + counter).
 */
const PS_LOOP =
  "while ($true) { $l = [Console]::In.ReadLine(); if ($l -eq $null) { break }; " +
  "try { $p = New-Object System.Media.SoundPlayer $l; $p.PlaySync(); $p.Dispose(); [Console]::Out.WriteLine('done') } " +
  "catch { [Console]::Out.WriteLine('fail') } }";

function makeRealPlay(): (wav: Buffer) => PlayHandle {
  const dir = path.join(os.tmpdir(), 'nexus_tts');
  let n = 0;
  let proc: ChildProcess | null = null;
  let pending: ((how: PlayEnd) => void) | null = null;
  const settle = (how: PlayEnd) => { const p = pending; pending = null; p?.(how); };

  const ensureWin = (): ChildProcess => {
    if (proc && proc.exitCode === null && !proc.killed) return proc;
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_LOOP], {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    let buf = '';
    p.stdout?.on('data', (d) => {
      buf += String(d);
      let at: number;
      while ((at = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, at).trim();
        buf = buf.slice(at + 1);
        if (line === 'done') settle('ended');
        else if (line === 'fail') settle('failed');
      }
    });
    // Only the CURRENT process may settle: a killed one exits later, when
    // `pending` may already belong to the next phrase on a fresh process.
    const gone = () => { if (proc === p) { proc = null; settle('killed'); } };
    p.on('exit', gone);
    p.on('error', gone);
    proc = p;
    return p;
  };

  return (wav: Buffer): PlayHandle => {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* reported by the write below */ }
    const file = path.join(dir, `p${process.pid}_${++n}.wav`);
    const cleanup = () => { try { fs.unlinkSync(file); } catch { /* already gone */ } };
    try { fs.writeFileSync(file, wav); } catch { return { done: Promise.resolve('failed'), kill: () => {} }; }

    if (process.platform === 'win32') {
      const done = new Promise<PlayEnd>((resolve) => {
        pending = resolve;
        try { ensureWin().stdin?.write(file + '\n'); } catch { settle('failed'); }
      }).then((how) => { cleanup(); return how; });
      // SoundPlayer has no stop from outside PlaySync; the process is the handle.
      return {
        done,
        kill: () => {
          settle('killed');
          const old = proc;
          proc = null;
          try { old?.kill(); } catch { /* already gone */ }
        },
      };
    }

    const cmd = process.platform === 'darwin' ? 'afplay' : 'aplay';
    let child: ChildProcess | null = null;
    let killed = false;
    const done = new Promise<PlayEnd>((resolve) => {
      try {
        child = spawn(cmd, process.platform === 'darwin' ? [file] : ['-q', file], { stdio: 'ignore' });
        child.on('exit', (code) => resolve(killed ? 'killed' : code === 0 ? 'ended' : 'failed'));
        child.on('error', () => resolve('failed'));
      } catch { resolve('failed'); }
    }).then((how) => { cleanup(); return how; });
    return { done, kill: () => { killed = true; try { child?.kill(); } catch { /* gone */ } } };
  };
}

const g = globalThis as unknown as { __nexusServerSpeech?: SpeechQueue };

/** The installation's one voice queue. */
export function serverSpeech(): SpeechQueue {
  if (!g.__nexusServerSpeech) {
    g.__nexusServerSpeech = new SpeechQueue({
      // Imported lazily: the synthesis core pulls in engine launchers and disk
      // paths that a test of the queue has no business loading.
      synth: async (seg, folderName) => {
        const { synthesizeSegment } = await import('@/lib/ttsSynth');
        const { loadTtsDictPairs } = await import('@/lib/ttsDictionary');
        const buf = await synthesizeSegment(
          seg.text, seg.engine, seg.char_idx, seg.style_idx, seg.speed || 1.0, seg.pitch ?? 0.0,
          loadTtsDictPairs(folderName), undefined, seg.char_name, seg.style_name,
        );
        return buf ? Buffer.from(buf) : null;
      },
      play: makeRealPlay(),
    });
  }
  return g.__nexusServerSpeech;
}

/** `user_settings.json` -> mode. Anything but the literal 'server' is 'tab'. */
export function speechModeFromSettings(settings: unknown): SpeechMode {
  return (settings as { ttsPlayback?: unknown } | null)?.ttsPlayback === 'server' ? 'server' : 'tab';
}
