import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// ── Who may erase a pending stop request ────────────────────────────────────
// REPORTED 2026-11-27 by Lizard-kun, three times: "press Stop right after
// sending and nothing happens, the red button just blinks for ever". MEASURED
// on 3001 with a stack trace naming the caller:
//
//   T+0.000  requestStop -> no listener yet -> 'recorded'
//   T+0.007  /api/chat/active, event 'end'  -> forgetStop ERASED the record
//   T+0.104  the turn registers its listener -> finds nothing -> runs on
//
// The press was destroyed BY ITSELF: Stop aborts the tab's own fetch, that
// fetch's cleanup posts 'end', and the runner then starts the turn with no
// fetch attached. A tab's 'end' therefore means "this tab stopped watching",
// NOT "the turn finished" — and those stopped being the same thing the day the
// runner took the tab off the critical path.
//
// Source-reading rather than behavioural because the route imports
// next/server, which cannot be imported outside the Next runtime (this
// house's standing constraint), and because the defect WAS the presence of
// one call — exactly what a reader can check and a type-check cannot.
//
// Pressing Stop the instant you notice a typo is the normal use: it is the
// only way to avoid paying for a message you did not mean to send.

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

/**
 * Source with line comments stripped, so a comment ABOUT a call is never read
 * as a call. The comments in these files deliberately name `forgetStop` while
 * explaining why it is not called — without this, the test would fail on its
 * own documentation.
 */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .map((l) => {
      const i = l.indexOf('//');
      return i === -1 ? l : l.slice(0, i);
    })
    .join('\n');
}

test("the client's 'end' POST must not reach the stop channel at all", () => {
  const code = codeOnly(read('src/app/api/chat/active/route.ts'));
  assert.ok(
    !/forgetStop/.test(code),
    'active/route.ts calls forgetStop again — a tab that stopped watching would ' +
      'erase a stop the running turn has not been told about yet',
  );
});

test("'end' still retires the registry entry: cross-tab visibility is untouched", () => {
  const code = codeOnly(read('src/app/api/chat/active/route.ts'));
  assert.match(
    code,
    /endTurn\(convoId, turnId\)/,
    "removing forgetStop must not have taken endTurn with it — without it a finished " +
      "turn keeps warning other tabs that a turn is running",
  );
});

test('the chat route still owns the cleanup, at the turn-level abort', () => {
  const code = codeOnly(read('src/app/api/chat/route.ts'));
  assert.match(
    code,
    /forgetStop\(convoId, injectTurnId\)/,
    'the only caller that knows a turn is really over is the chat route; if this ' +
      'goes too, nothing clears the channel but the six-hour TTL',
  );
});
