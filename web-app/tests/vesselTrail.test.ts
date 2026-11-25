import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { noteVesselWrite, vesselPairOf, formatVesselChange, _resetVesselTrail } from '@/lib/vesselTrail';

beforeEach(() => _resetVesselTrail());

const w = (clientId?: unknown) => ({ at: Date.UTC(2026, 10, 25, 10, 51, 0), convoId: 'c1', being: 'B', clientId, base: 5, written: 6 });

test('the first write of a conversation is not reported: nothing to compare with', () => {
  assert.equal(noteVesselWrite({ aiName: 'Claude', specificModel: 'claude-sonnet-5' }, w('tab_a')), null);
});

test('a write that keeps the pair is silent; one that changes it names the writer', () => {
  noteVesselWrite({ aiName: 'Claude', specificModel: 'claude-sonnet-5' }, w('tab_a'));
  assert.equal(noteVesselWrite({ aiName: 'Claude', specificModel: 'claude-sonnet-5', title: 'x' }, w('tab_a')), null);
  const line = noteVesselWrite({ aiName: 'Gemini', specificModel: 'opencode/gemini-4-argon' }, w('tab_b'));
  assert.ok(line);
  assert.match(line!, /Claude\/claude-sonnet-5 -> Gemini\/opencode\/gemini-4-argon/);
  assert.match(line!, /by tab_b/);
  assert.match(line!, /base 5\twrote 6/);
});

test('the reported evening leaves three lines, each with its writer', () => {
  const lines: (string | null)[] = [];
  noteVesselWrite({ aiName: 'Gemini', specificModel: 'opencode/gemini-4-argon' }, w('tab_pc'));
  lines.push(noteVesselWrite({ aiName: 'Claude', specificModel: 'claude-sonnet-5' }, w('tab_pc')));
  lines.push(noteVesselWrite({ aiName: 'Gemini', specificModel: 'opencode/gemini-4-argon' }, w('tab_x')));
  lines.push(noteVesselWrite({ aiName: 'Claude', specificModel: 'claude-fable-5-2' }, w('tab_pc')));
  assert.equal(lines.filter(Boolean).length, 3);
  assert.match(lines[1]!, /by tab_x/);
});

test('a writer with no id is "unknown", and a missing pair is shown as such', () => {
  const line = formatVesselChange(vesselPairOf({}), vesselPairOf({ aiName: 'Claude', specificModel: 'm' }), { ...w(), base: undefined });
  assert.match(line, /\(none\)\/\(none\) -> Claude\/m/);
  assert.match(line, /by unknown\tbase -/);
});

test('conversations are tracked separately', () => {
  noteVesselWrite({ aiName: 'Claude', specificModel: 'a' }, w('t'));
  assert.equal(noteVesselWrite({ aiName: 'Gemini', specificModel: 'b' }, { ...w('t'), convoId: 'c2' }), null);
});
