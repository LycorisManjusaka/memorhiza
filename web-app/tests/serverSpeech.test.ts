import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpeechQueue, speechModeFromSettings, type PlayEnd, type PlayHandle } from '@/lib/serverSpeech';
import { assistantSpeechSentences, splitTtsSentences, segmentFor } from '@/lib/ttsSentences';
import { pickMirroredGlobalSettings } from '@/lib/serverGlobalSettings';
import { runTurnForQueue, type RunTurnDeps } from '@/lib/runTurnForQueue';
import type { QueueItem } from '@/lib/turnQueue';

// A player the test ends by hand: each play() waits until `finish` or `kill`.
function fakePlayer() {
  const log: string[] = [];
  let live: { end: (how: PlayEnd) => void; text: string } | null = null;
  const play = (wav: Buffer): PlayHandle => {
    const text = wav.subarray(44).toString('utf8');
    log.push(`play:${text}`);
    let end!: (how: PlayEnd) => void;
    const done = new Promise<PlayEnd>((r) => { end = r; });
    live = { end, text };
    return { done, kill: () => { log.push(`kill:${text}`); end('killed'); } };
  };
  const finish = async () => { const l = live; live = null; l?.end('ended'); await tick(); };
  return { play, log, finish, playing: () => live?.text ?? null };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const wavOf = (text: string) => Buffer.concat([Buffer.alloc(44), Buffer.from(text, 'utf8')]);
const seg = (text: string) => segmentFor(text, null, 0);

test('queue: phrases in order, one message after another, never two voices at once', async () => {
  const p = fakePlayer();
  const q = new SpeechQueue({ synth: async (s) => wavOf(s.text), play: p.play });
  const a = q.speak({ messageId: 'a', sentences: [seg('a1'), seg('a2')] });
  const b = q.speak({ messageId: 'b', sentences: [seg('b1')] });
  await tick();
  assert.equal(p.playing(), 'a1');
  assert.equal(q.snapshot().current?.messageId, 'a');
  assert.equal(q.snapshot().queued, 1);
  await p.finish();
  assert.equal(p.playing(), 'a2');
  assert.equal(q.snapshot().current?.index, 1);
  await p.finish();
  assert.equal(await a, 'done');
  assert.equal(p.playing(), 'b1', 'the second message starts only after the first ended');
  await p.finish();
  assert.equal(await b, 'done');
  assert.deepEqual(p.log, ['play:a1', 'play:a2', 'play:b1']);
  assert.equal(q.snapshot().current, null);
});

test('queue: pause kills the phrase, resume replays THAT phrase from its start', async () => {
  const p = fakePlayer();
  const q = new SpeechQueue({ synth: async (s) => wavOf(s.text), play: p.play });
  const done = q.speak({ messageId: 'a', sentences: [seg('one'), seg('two')] });
  await tick();
  q.pause();
  await tick();
  assert.equal(q.snapshot().current?.paused, true);
  assert.deepEqual(p.log, ['play:one', 'kill:one']);
  q.resume();
  await tick();
  assert.equal(p.playing(), 'one');
  await p.finish();
  await p.finish();
  assert.equal(await done, 'done');
  assert.deepEqual(p.log, ['play:one', 'kill:one', 'play:one', 'play:two']);
});

test('queue: stop ends the current message and resolves "stopped"; others are untouched', async () => {
  const p = fakePlayer();
  const q = new SpeechQueue({ synth: async (s) => wavOf(s.text), play: p.play });
  const a = q.speak({ messageId: 'a', convoId: 'c1', sentences: [seg('a1'), seg('a2')] });
  const b = q.speak({ messageId: 'b', convoId: 'c2', sentences: [seg('b1')] });
  await tick();
  q.stop({ convoId: 'c1' });
  assert.equal(await a, 'stopped');
  await tick();
  assert.equal(p.playing(), 'b1');
  assert.ok(!p.log.includes('play:a2'));
  // Stopping while paused must not hang the queue.
  q.pause();
  await tick();
  q.stop();
  assert.equal(await b, 'stopped');
  assert.equal(q.snapshot().current, null);
});

test('queue: a phrase the engine refuses is skipped and counted, the rest is still read', async () => {
  const p = fakePlayer();
  const seen: number[] = [];
  const q = new SpeechQueue({
    synth: async (s) => { if (s.text === 'bad') throw new Error('engine down'); return s.text === 'mute' ? null : wavOf(s.text); },
    play: p.play,
  });
  const done = q.speak({ messageId: 'a', sentences: [seg('bad'), seg('mute'), seg('ok')] }, (i) => seen.push(i));
  await tick(); await tick();
  assert.equal(p.playing(), 'ok');
  assert.equal(q.snapshot().current?.failed, 1);
  await p.finish();
  assert.equal(await done, 'done');
  assert.deepEqual(seen, [2], 'progress is reported only for phrases that sounded');
});

test('queue: leaving server mode silences the voice; subscribers see every change', async () => {
  const p = fakePlayer();
  const q = new SpeechQueue({ synth: async (s) => wavOf(s.text), play: p.play });
  const modes: string[] = [];
  q.subscribe((s) => modes.push(`${s.mode}:${s.current?.messageId ?? '-'}`));
  q.setMode('server');
  const a = q.speak({ messageId: 'a', sentences: [seg('a1')] });
  await tick();
  q.setMode('tab');
  assert.equal(await a, 'stopped');
  assert.equal(modes[0], 'server:-');
  assert.equal(modes.at(-1), 'tab:-');
});

test('mode: only the literal "server" switches; the mirror carries only the two values', () => {
  assert.equal(speechModeFromSettings(null), 'tab');
  assert.equal(speechModeFromSettings({ ttsPlayback: 'Server' }), 'tab');
  assert.equal(speechModeFromSettings({ ttsPlayback: 'server' }), 'server');
  assert.deepEqual(pickMirroredGlobalSettings({ ttsPlayback: 'server' }), { ttsPlayback: 'server' });
  assert.deepEqual(pickMirroredGlobalSettings({ ttsPlayback: 'loud' }), {});
});

test('sentences: timestamps are never spoken; splitting is stable when applied twice', () => {
  const s = assistantSpeechSentences('[2026-11-17 13:00:00]\nやあ。元気？\nまたね', { engine: 1, speed: 1.2 }, 0.05);
  assert.deepEqual(s.map((x) => x.text), ['やあ。', '元気？', 'またね']);
  assert.equal(s[0].engine, 1);
  assert.equal(s[0].speed, 1.2);
  assert.equal(s[0].pitch, 0.05);
  assert.deepEqual(splitTtsSentences(s).map((x) => x.text), s.map((x) => x.text),
    'the server re-splits what a tab already split; that must change nothing');
  assert.deepEqual(assistantSpeechSentences('[2026-11-17 13:00:00]', null, 0), []);
});

// ── The runner: save, THEN read, THEN send `[->name]` ───────────────────────
const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
function bodyOf(frames: string[]) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    getReader() {
      return {
        read: async () => i >= frames.length ? { done: true, value: undefined } : { done: false, value: enc.encode(frames[i++]) },
        cancel: async () => {}, releaseLock: () => {}, closed: Promise.resolve(undefined),
      };
    },
  };
}
function rig(logExtra: Record<string, unknown>) {
  const events: string[] = [];
  const raw: string[] = [];
  let minted = 0; let disk = 5;
  const log = { id: 'c1', updatedAt: 5, aiName: 'Local', ...logExtra, messages: [{ id: 'u0', role: 'user', content: 'q' }, { id: 'a0', role: 'assistant', content: 'r' }] };
  const deps: RunTurnDeps = {
    loadLog: async () => log,
    saveLog: async () => { disk += 1; events.push('save'); return { ok: true, writtenUpdatedAt: disk }; },
    chatPost: async () => ({ ok: true, status: 200, body: bodyOf([frame({ type: 'text', content: '[->先輩]\nやあ' })]) } as unknown as Response),
    globalSettings: {}, enableReadConversation: false,
    folderDefaults: { aiName: 'Local', folderName: '謡', systemPrompt: '', specificModel: 'm', modelParams: {} },
    newId: () => `minted-${++minted}`, nowMs: () => 7000, clientId: 'runner:test',
    origin: 'http://localhost:3000', injectTurnId: 'turn_test',
    onRawText: (t: string) => { raw.push(t); },
    planRoutes: async () => ({ records: [], notice: '', deliver: async () => { events.push('deliver'); } }),
    speakReply: async (a) => { events.push(`speak:${a.content.length}`); a.onPhrase(0, 2); events.push('spoken'); },
  } as RunTurnDeps;
  return { deps, events, raw };
}
const item = (text: string): QueueItem => ({ id: 'item-1', at: 1000, kind: 'user_message', from: 'つよ', payload: { text } } as unknown as QueueItem);

test('runner: in an audio session the reply is saved, read aloud, and only then routed', async () => {
  const r = rig({ beingRouteEnabled: true, vrchatMode: true });
  const res = await runTurnForQueue('謡', 'c1', [item('hi')], r.deps);
  assert.equal(res.ok, true);
  assert.deepEqual(r.events, ['save', 'speak:9', 'spoken', 'deliver']);
  const speech = r.raw.filter((t) => t.includes('"tool":"speech"'));
  assert.ok(speech.some((t) => t.includes('"detail":"1/2"')), 'progress reaches the watching tabs');
  assert.ok(r.raw.at(-1)!.includes('"tool":null') || r.raw.some((t) => t.includes('"tool":null')), 'the busy line is cleared');
});

test('runner: without an audio session nothing is read', async () => {
  const r = rig({ beingRouteEnabled: true });
  await runTurnForQueue('謡', 'c1', [item('hi')], r.deps);
  assert.deepEqual(r.events, ['save', 'deliver']);
});

test('queue: Stop gets out of an engine that never answers, and the next message still plays (2026-11-17)', async () => {
  const p = fakePlayer();
  const q = new SpeechQueue({
    // 'hang' never answers — the shape that held the turn lease for ever.
    synth: (s) => s.text === 'hang' ? new Promise<Buffer | null>(() => {}) : Promise.resolve(wavOf(s.text)),
    play: p.play,
  });
  const a = q.speak({ messageId: 'a', convoId: 'c', sentences: [seg('hang')] });
  await tick();
  q.stop({ convoId: 'c' });
  assert.equal(await a, 'stopped', 'the runner is answered at once');
  assert.equal(q.snapshot().current, null, 'nothing is left painted as sounding');
  const b = q.speak({ messageId: 'b', sentences: [seg('b1')] });
  await tick();
  assert.equal(p.playing(), 'b1', 'the queue is not wedged');
  await p.finish();
  assert.equal(await b, 'done');
});
