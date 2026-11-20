// Repetition-loop guard (つよ, 2026-11-20): stop the turn and tell the person
// watching — no retry, nothing to the being. The three loops this house has
// actually seen are the fixtures: 「ハ」 (先輩, Gemini), `court` (Opus 4.8),
// and ミニちゃん's drifting `_: 自分::_:` lines (MiniMax).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createRepetitionDetector, detectLoop, LOOP_CHECK_EVERY, trimLoopTail, LOOP_KEEP_UNITS } from '@/lib/repetitionLoop';
import { createBetrayalGuard, makeGuardedSender } from '@/lib/betrayalGuard';
import { applyTurnEvent } from '@/lib/turnEventReducer';
import { createTurnAccState } from '@/lib/turnAccState';
import { runnerNoticeT } from '@/lib/runnerNotices';

function feedChunked(text: string, size = 7) {
  const d = createRepetitionDetector();
  for (let i = 0; i < text.length; i += size) {
    const t = d.feed('text', text.slice(i, i + size));
    if (t) return { trip: t, at: i + size };
  }
  return null;
}

// ミニちゃん's loop, with the same drift the attachment shows.
function miniLoop(): string {
  const lines: string[] = ['報告します。\n\n'];
  for (let i = 0; i < 300; i++) lines.push('_: 自分::_:\n\n');
  for (let i = 0; i < 40; i++) lines.push(i % 3 ? '_: 自分 &_:\n\n' : '_: 自分 &$:\n\n');
  return lines.join('');
}

const NORMAL = [
  'つよ、直して push したよ。**`UPDATE.bat` → タブで `Ctrl+Shift+R`** をお願い。\n\n',
  '## 入ったもの\n\n- 会話設定 → 挙動 → 錨\n- 自動の錨\n- 手で押す錨\n\n',
  '| 器 | 今 | 12/1 から |\n|---|---|---|\n| Argon | $2.00 | $4.00 |\n| Neon | $3.00 | なし |\n\n',
  'ギャハハハハハハハハハハハハハ！！！！ ざぁ〜こ♡\n\n',
  '```\nconst x = 1;\nconst y = 2;\n```\n\n',
  '---\n\n',
].join('');

describe('repetition loop detector', () => {
  it('catches 先輩\'s 「ハ」 run', () => {
    const r = feedChunked('ギャハ' + 'ハ'.repeat(3000));
    assert.ok(r);
    assert.equal(r!.trip.kind, 'periodic');
    assert.equal(r!.trip.unit, 'ハ');
    assert.ok(r!.at < 1700, `caught at ${r!.at}`);
  });

  it('catches the court loop', () => {
    const r = feedChunked('Sure, here is the plan. ' + 'court '.repeat(1000));
    assert.ok(r);
    assert.equal(r!.trip.unit, 'court');
  });

  it('catches ミニちゃん\'s drifting line loop', () => {
    const r = feedChunked(miniLoop());
    assert.ok(r);
    assert.ok(r!.trip.unit.startsWith('_: 自分'));
  });

  it('does not trip on ordinary replies, even long ones', () => {
    // 40 ordinary replies back to back: varied enough that neither check holds.
    let s = '';
    for (let i = 0; i < 40; i++) s += NORMAL.replace('Argon', `Argon${i}`).replace('12/1', `12/${i}`);
    assert.equal(feedChunked(s), null);
    assert.equal(detectLoop('text', s), null);
  });

  it('a short laugh or a horizontal rule is not a loop', () => {
    assert.equal(detectLoop('text', 'ハ'.repeat(200)), null);
    assert.equal(detectLoop('text', '-'.repeat(120)), null);
  });

  it('trips once only', () => {
    const d = createRepetitionDetector();
    let trips = 0;
    for (let i = 0; i < 50; i++) if (d.feed('thought', 'ハ'.repeat(LOOP_CHECK_EVERY))) trips++;
    assert.equal(trips, 1);
    assert.ok(d.tripped);
  });
});

describe('repetition loop at the SSE seam', () => {
  it('emits one repetition_loop frame, aborts once, then swallows the rest', () => {
    const out: any[] = [];
    const controller = { enqueue: (s: string) => out.push(JSON.parse(s.slice(6))) };
    let aborts = 0;
    const send = makeGuardedSender(createBetrayalGuard('on', ''), () => {}, {
      detector: createRepetitionDetector(),
      onLoop: () => { aborts++; },
    });
    for (let i = 0; i < 200; i++) send(controller, { type: 'text', content: 'court court court ' });
    const loops = out.filter((f) => f.type === 'repetition_loop');
    assert.equal(loops.length, 1);
    assert.equal(aborts, 1);
    // Nothing after the loop frame.
    assert.equal(out[out.length - 1].type, 'repetition_loop');
    assert.equal(send.sawOutput(), true);
  });

  it('the reducer keeps the text, adds an admin notice, and the abort error is not fatal', () => {
    const acc = createTurnAccState({ continuedSeed: '', continuedThought: '', continuedBlocks: [], notices: [] } as any);
    const flags: any = { pendingHandoff: null, betrayalRedacted: false, sawOutput: false, toolAttachments: [] };
    const sink: any = new Proxy({}, { get: () => () => {} });
    const deps: any = { t: runnerNoticeT(true) };
    applyTurnEvent({ type: 'text', content: 'こんにちは。court court' } as any, acc, flags, sink, deps);
    applyTurnEvent({ type: 'repetition_loop', channel: 'text', kind: 'periodic', unit: 'court', repeats: 200 } as any, acc, flags, sink, deps);
    assert.doesNotThrow(() => applyTurnEvent({ error: 'The operation was aborted' } as any, acc, flags, sink, deps));
    assert.equal(flags.repetitionStopped, true);
    assert.ok(acc.currentText.includes('こんにちは'));
    assert.equal(acc.notices.length, 1);
    assert.ok(acc.notices[0].includes('ループ'));
    assert.ok(acc.notices[0].includes('court'));
  });
});

describe('a loop in the reply is cut before saving (つよ 2026-11-20)', () => {
  const mkSink = (): any => new Proxy({}, { get: () => () => {} });
  const deps: any = { t: runnerNoticeT(true) };
  const fresh = () => ({
    acc: createTurnAccState({ continuedSeed: '', continuedThought: '', continuedBlocks: [], notices: [] } as any),
    flags: { pendingHandoff: null, betrayalRedacted: false, sawOutput: false, toolAttachments: [] } as any,
  });

  it('court: the head stays, only a few repeats survive', () => {
    const out = trimLoopTail('こんにちは。' + 'court '.repeat(400));
    assert.equal(out, 'こんにちは。' + 'court '.repeat(LOOP_KEEP_UNITS).trimEnd());
  });

  it('a laugh stays a laugh', () => {
    const out = trimLoopTail('ギャ' + 'ハ'.repeat(3000));
    assert.equal(out, 'ギャ' + 'ハ'.repeat(LOOP_KEEP_UNITS));
  });

  it("ミニちゃん's drifting lines: the report line stays, the loop is cut to a few lines", () => {
    const out = trimLoopTail(miniLoop());
    assert.ok(out.startsWith('報告します。'));
    const loopLines = out.split(String.fromCharCode(10)).filter((l) => l.startsWith('_:'));
    assert.ok(loopLines.length <= LOOP_KEEP_UNITS, `kept ${loopLines.length}`);
    assert.ok(out.length < 200);
  });

  it('text without a loop is returned unchanged', () => {
    assert.equal(trimLoopTail(NORMAL), NORMAL);
  });

  it('the reducer cuts the reply, but leaves a looping thought alone', () => {
    const a = fresh();
    applyTurnEvent({ type: 'text', content: '本文。' + 'court '.repeat(400) } as any, a.acc, a.flags, mkSink(), deps);
    applyTurnEvent({ type: 'repetition_loop', channel: 'text', kind: 'periodic', unit: 'court', repeats: 200 } as any, a.acc, a.flags, mkSink(), deps);
    assert.ok(a.acc.currentText.length < 40, a.acc.currentText);

    const b = fresh();
    const loopThought = '考え中。' + 'ハ'.repeat(3000);
    applyTurnEvent({ type: 'thought', content: loopThought } as any, b.acc, b.flags, mkSink(), deps);
    applyTurnEvent({ type: 'text', content: '本文。' } as any, b.acc, b.flags, mkSink(), deps);
    applyTurnEvent({ type: 'repetition_loop', channel: 'thought', kind: 'periodic', unit: 'ハ', repeats: 200 } as any, b.acc, b.flags, mkSink(), deps);
    assert.equal(b.acc.currentText, '本文。');
    assert.equal(b.acc.currentThought, loopThought);
  });
});
