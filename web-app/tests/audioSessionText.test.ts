import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeAudioSessionText, AUDIO_RULE_DEFAULT } from '../src/lib/audioSessionRule';
import { turnInputFromLog } from '../src/lib/turnInputFromLog';
import { buildTurnRequestBody } from '../src/lib/turnRequestBody';

const base = { audioSession: true, ruleEnabled: true, storedRule: '', notice: '[N]', language: 'ja' };

test('audio session: notice + built-in rule when nothing is stored', () => {
  assert.equal(composeAudioSessionText(base), `[N]\n\n${AUDIO_RULE_DEFAULT.ja}`);
});

test('audio session: stored rule wins over the built-in one', () => {
  assert.equal(composeAudioSessionText({ ...base, storedRule: 'ルール' }), '[N]\n\nルール');
});

test('audio session: rule switch OFF sends nothing at all (not even the notice)', () => {
  assert.equal(composeAudioSessionText({ ...base, ruleEnabled: false, storedRule: 'ルール' }), '');
});

test('audio session: session OFF sends nothing', () => {
  assert.equal(composeAudioSessionText({ ...base, audioSession: false }), '');
});

test('runner carries the audio fields from the log (they used to be dropped)', () => {
  const ctx: any = {
    messages: [], convoId: 'c', injectTurnId: 't', clientId: 'x', enableReadConversation: false,
    globalSettings: null,
    folderDefaults: { aiName: 'Claude', folderName: 'F', systemPrompt: '', specificModel: '', modelParams: {} },
  };
  const on = turnInputFromLog({ vrchatMode: true, vrchatRule: 'R' } as any, ctx);
  assert.equal(on.audioSession, true);
  assert.equal(on.audioSessionRule, 'R');
  assert.equal(on.audioSessionRuleEnabled, true, 'absent on disk = ON');
  const off = turnInputFromLog({ vrchatMode: true, audioSessionRuleEnabled: false } as any, ctx);
  assert.equal(off.audioSessionRuleEnabled, false);
  const body: any = buildTurnRequestBody(on as any);
  assert.equal(body.audioSession, true);
  assert.equal(body.audioSessionRule, 'R');
});
