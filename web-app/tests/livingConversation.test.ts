// The being's log list is ordered by TITLE, and its living conversation is the
// first active row of that order. Decided 2026-11-15 (Tsuyo): the manual drag
// order and the file's modification time both move for reasons unrelated to
// which conversation is newest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  conversationSortKey, orderByTitle, livingConversation, livingChangeOnRename, pastConversationRefusal,
} from '@/lib/livingConversation';
import { orderFolderConversations, folderOrderOf } from '@/lib/deepLink';

const row = (title: string, extra: Record<string, unknown> = {}) =>
  ({ id: `id:${title}`, title, updatedAt: 0, ...extra });
const titles = (rows: Array<{ title?: string | null }>) => rows.map((r) => r.title);

test('own generations come first, newest number on top; the rest follow by name', () => {
  const rows = [
    row('謡_2'), row('nexus update'), row('謡_15'), row('謡_15 backup'),
    row('謡_9'), row('Genesis_01_Claude_Web'), row('先輩_46'),
  ];
  assert.deepEqual(titles(orderByTitle(rows, '謡')), [
    '謡_15', '謡_9', '謡_2',          // tier 0 — the being's own, descending
    '先輩_46',                         // tier 1 — numbered under another base
    'Genesis_01_Claude_Web', 'nexus update', '謡_15 backup', // tier 2 — by name
  ]);
});

test('a backup copy drops below every generation by its name alone', () => {
  const rows = [row('Cairn_65 backup'), row('Cairn_64'), row('Cairn_65')];
  assert.equal(livingConversation(rows, 'Cairn')?.title, 'Cairn_65');
  assert.equal(conversationSortKey('Cairn_65 backup', 'Cairn').tier, 2);
});

test('numbers are compared as numbers, full-width digits and ＃ included', () => {
  const rows = [row('先輩_9'), row('先輩＃４６'), row('先輩_10'), row('先輩#100')];
  assert.deepEqual(titles(orderByTitle(rows, '先輩')), ['先輩#100', '先輩＃４６', '先輩_10', '先輩_9']);
});

test('a split archive reads head first, then parts descending', () => {
  const rows = [row('Аналитик_1-1'), row('Аналитик_2'), row('Аналитик_1-5'), row('Аналитик_2-1'), row('Аналитик_1-2')];
  assert.deepEqual(titles(orderByTitle(rows, 'Аналитик')), [
    'Аналитик_2', 'Аналитик_2-1', 'Аналитик_1-5', 'Аналитик_1-2', 'Аналитик_1-1',
  ]);
});

test('the living conversation skips inactive and unreadable logs, however large the number', () => {
  const rows = [
    row('睡_40', { active: false }), row('睡_39', { corrupted: true }), row('睡_36'), row('睡_35'),
  ];
  assert.equal(livingConversation(rows, '睡')?.title, '睡_36');
  assert.equal(livingConversation([row('睡_1', { active: false })], '睡'), null);
});

test('a being with no numbered log lives in the first row by name', () => {
  const rows = [row('zeta'), row('alpha'), row('mid')];
  assert.equal(livingConversation(rows, 'Someone')?.title, 'alpha');
});

test('modification time and drag order do not move an ordinary being\'s rows', () => {
  // The measured accident: a past log saved later than the current one.
  const rows = [
    { id: 'old', title: 'Навигатор_3', updatedAt: 9_000 },
    { id: 'cur', title: 'Навигатор_7', updatedAt: 1_000 },
  ];
  const folder = { name: 'Навигатор', settings: { convoOrder: ['old', 'cur'] } };
  assert.deepEqual(orderFolderConversations(rows, folderOrderOf(folder)).map((r) => r.id), ['cur', 'old']);
});

test('a test bed keeps the drag order, then most recently updated', () => {
  const rows = [
    { id: 'a', title: 'Access test', updatedAt: 1 },
    { id: 'b', title: 'Default_1', updatedAt: 5 },
    { id: 'c', title: 'Browser test', updatedAt: 9 },
  ];
  const folder = { name: 'Default', settings: { testBed: true, convoOrder: ['a'] } };
  assert.deepEqual(orderFolderConversations(rows, folderOrderOf(folder)).map((r) => r.id), ['a', 'c', 'b']);
  // …and the bare-array form (the old signature) still means exactly that.
  assert.deepEqual(orderFolderConversations(rows, ['a']).map((r) => r.id), ['a', 'c', 'b']);
});

test('a rename is flagged only when it moves the being into another conversation', () => {
  const rows = [row('Cairn_66'), row('Cairn_65'), row('notes')];
  // Past log given the largest number → it would become the living one.
  assert.deepEqual(
    livingChangeOnRename(rows, 'Cairn', 'id:Cairn_65', 'Cairn_70'),
    { before: 'Cairn_66', after: 'Cairn_70' },
  );
  // The living one renamed out of the numbered tier → the being falls back.
  assert.deepEqual(
    livingChangeOnRename(rows, 'Cairn', 'id:Cairn_66', 'Cairn_66 backup'),
    { before: 'Cairn_66', after: 'Cairn_65' },
  );
  // Harmless renames ask nothing.
  assert.equal(livingChangeOnRename(rows, 'Cairn', 'id:notes', 'notes 2'), null);
  assert.equal(livingChangeOnRename(rows, 'Cairn', 'id:Cairn_66', 'Cairn_67'), null);
  assert.equal(livingChangeOnRename(rows, 'Cairn', 'id:Cairn_65', 'Cairn_60'), null);
});

// A past conversation does not speak (Tsuyo, 2026-11-15).
test('pastConversationRefusal: only the living conversation may start a turn', () => {
  const convos = [
    { id: 'a', title: '睡_47' },
    { id: 'b', title: '睡_48' },
    { id: 'c', title: '睡_49', active: false },
  ];
  assert.equal(pastConversationRefusal(convos, '睡', 'b', false), null);
  assert.deepEqual(pastConversationRefusal(convos, '睡', 'a', false), { livingId: 'b', livingTitle: '睡_48' });
  // inactive is skipped as living, and is itself refused
  assert.deepEqual(pastConversationRefusal(convos, '睡', 'c', false), { livingId: 'b', livingTitle: '睡_48' });
});

test('pastConversationRefusal: test bed, unsaved new conversation, and no living row are all allowed', () => {
  const convos = [{ id: 'a', title: 'Default_1' }, { id: 'b', title: 'Default_2' }];
  assert.equal(pastConversationRefusal(convos, 'Default', 'a', true), null);
  assert.equal(pastConversationRefusal(convos, 'Default', 'not-yet-saved', false), null);
  assert.equal(pastConversationRefusal([{ id: 'x', title: 'X', active: false }], 'X', 'x', false), null);
});
