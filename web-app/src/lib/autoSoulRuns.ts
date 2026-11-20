// Automatic soul updates in flight in THIS process (lib/autoSoulUpdate.ts).
//
// A soul update's run record says "running" only while one model call is
// streaming; between β and the summary, and while the new conversation is
// being written, no record does. This map covers the whole span, so a pass
// arriving in one of those gaps still waits. Process-local on purpose: the
// installation that started the update is the one that carries the stock over.
//
// On globalThis for the reason turnBus is: the dev server hands each route its
// own module instance, and the runner and the stock poll must see one map.

export interface AutoSoulRun<O> {
  convoId: string;
  startedAt: number;
  /** The pass to rerun in the new conversation; the strongest one seen wins. */
  opts: O;
}

const KEY = '__nexusAutoSoulRuns';

function runs<O>(): Map<string, AutoSoulRun<O>> {
  const g = globalThis as Record<string, unknown>;
  return (g[KEY] as Map<string, AutoSoulRun<O>>) || (g[KEY] = new Map<string, AutoSoulRun<O>>()) as Map<string, AutoSoulRun<O>>;
}

export function autoSoulRun<O>(being: string): AutoSoulRun<O> | undefined {
  return runs<O>().get(being);
}

export function beginAutoSoulRun<O>(being: string, run: AutoSoulRun<O>): void {
  runs<O>().set(being, run);
}

export function endAutoSoulRun<O>(being: string): AutoSoulRun<O> | undefined {
  const m = runs<O>();
  const r = m.get(being);
  m.delete(being);
  return r;
}

/**
 * Which held pass to rerun afterwards. A person's send (neither flag) outranks
 * a wake, which outranks a stock starting by itself: the rerun must not be
 * refused by a checkbox the strongest waiting reason never needed.
 */
export function strongerPass<O extends { auto: boolean; wake: boolean }>(a: O, b: O): O {
  const rank = (o: O) => (!o.auto && !o.wake ? 2 : o.wake ? 1 : 0);
  return rank(b) > rank(a) ? b : a;
}
