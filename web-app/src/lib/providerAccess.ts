// Which model families and provider routes this install can actually reach
// (2026-11-25, つよ's rule: "no API key registered -> do not show the choice").
//
// Pure rules only. The screen holds a KeyPresence (booleans, never the key
// values) and asks three questions here:
//   - is this family reachable at all?            -> familyAvailable
//   - which families go in a family <select>?     -> visibleFamilies
//   - is there a real provider choice to offer?   -> routeChoice
//
// Two things are deliberate:
//   1. `null` presence means "not known yet" (fetch in flight or failed) and
//      hides NOTHING. A picker that empties itself because a fetch was slow
//      would be worse than the clutter this removes.
//   2. The value currently saved always stays in the list, key or no key. A
//      <select> whose saved value has no <option> displays its first child and
//      lies about what the conversation holds (lib/retiredModels.ts).

export type KeyPresence = Record<string, boolean>;

/** keys.json field names -> has a non-blank value. Values never leave here. */
export function keyPresence(keys: unknown): KeyPresence {
  const out: KeyPresence = {};
  if (!keys || typeof keys !== 'object') return out;
  for (const [k, v] of Object.entries(keys as Record<string, unknown>)) {
    out[k] = typeof v === 'string' && v.trim().length > 0;
  }
  return out;
}

export type ProviderRoute = { id: string; key: string };

/**
 * Families with more than one way in. `id` is what the picker's switch uses:
 * Claude's billing mode, and the provider derived from the model id prefix for
 * Gemini (opencode/) and GLM (digitalocean/).
 */
export const FAMILY_ROUTES: Record<string, ProviderRoute[]> = {
  // The OpenCode Go monthly allowance serves ten of these families
  // (lib/opencodeGo.ts OPENCODE_GO_CATALOG), so for each of them `opencode` is
  // a second (or third) way in, on the same `opencode/<id>` model-prefix rule
  // Gemini and GLM already use. Declared order is the order the switch shows.
  // Claude is deliberately NOT given an `opencode` route yet, even though Go
  // serves claude-haiku-5-5: its two routes are an AUTH MODE held in state, not
  // a model-id prefix, so a third option here would put two switches for the
  // same question on one screen (its own billing switch, and the shared route
  // switch). The chat route accepts `opencode/claude-haiku-5-5` — only the
  // picker does not offer it.
  Claude: [{ id: 'api-key', key: 'claude' }, { id: 'oauth', key: 'claudeOAuthToken' }],
  Gemini: [{ id: 'google', key: 'gemini' }, { id: 'opencode', key: 'opencode' }],
  GLM: [{ id: 'zai', key: 'glm' }, { id: 'digitalocean', key: 'digitalocean' }, { id: 'opencode', key: 'opencode' }],
  Qwen: [{ id: 'dashscope', key: 'qwen' }, { id: 'opencode', key: 'opencode' }],
  DeepSeek: [{ id: 'deepseek', key: 'deepseek' }, { id: 'opencode', key: 'opencode' }],
  Kimi: [{ id: 'moonshot', key: 'kimi' }, { id: 'opencode', key: 'opencode' }],
  Grok: [{ id: 'xai', key: 'grok' }, { id: 'opencode', key: 'opencode' }],
  Minimax: [{ id: 'minimax', key: 'minimax' }, { id: 'opencode', key: 'opencode' }],
  ChatGPT: [{ id: 'openai', key: 'openai' }, { id: 'opencode', key: 'opencode' }],
  MiMo: [{ id: 'xiaomi', key: 'mimo' }, { id: 'opencode', key: 'opencode' }],
};

/** Single-route families -> their keys.json field. Local needs no key. */
const FAMILY_KEY: Record<string, string> = {
  Cohere: 'cohere', ByteDance: 'bytedance', Meta: 'meta',
};

export type AccessOpts = {
  /**
   * Restrict a multi-route family to some of its routes, for a seat that can
   * only use those (the sense bridges reach Claude through OAuth and Gemini
   * through Google only).
   */
  only?: Record<string, string[]>;
};

function norm(family: string): string {
  const f = (family || '').toLowerCase();
  const all = [...Object.keys(FAMILY_ROUTES), ...Object.keys(FAMILY_KEY), 'Local'];
  return all.find((x) => x.toLowerCase() === f) ?? family;
}

/**
 * Does this family's switch offer `opencode` at all?
 *
 * The shared <GoRoute> switch (FamilyModelPicker) draws the routes declared
 * above, and the only thing it can DO with one is rewrite the model id
 * (`opencode/<id>`, `digitalocean/<id>`, or the family default). It has no way
 * to set an auth MODE. So a family whose routes are auth modes rather than
 * model prefixes — Claude: api-key / oauth — has to stay out of it, or the
 * switch lists two routes and does nothing when one is picked.
 *
 * Seen on screen 2026-11-27 14:29: Claude's OAuth could not be selected (the
 * dropdown snapped back to api-key) and the Model tab carried two switches
 * asking the same question. FAMILY_ROUTES already said Claude has no
 * `opencode` route; the switch simply never asked.
 */
export function familyOffersOpenCodeRoute(family: string): boolean {
  return (FAMILY_ROUTES[norm(family)] ?? []).some((r) => r.id === 'opencode');
}

/** Routes of `family` that have a key, in declared order. */
export function availableRoutes(family: string, presence: KeyPresence | null, opts?: AccessOpts): string[] {
  const fam = norm(family);
  let routes = FAMILY_ROUTES[fam] ?? [];
  const only = opts?.only?.[fam];
  if (only) routes = routes.filter((r) => only.includes(r.id));
  if (!presence) return routes.map((r) => r.id);
  return routes.filter((r) => presence[r.key]).map((r) => r.id);
}

export function familyAvailable(family: string, presence: KeyPresence | null, opts?: AccessOpts): boolean {
  if (!presence) return true;
  const fam = norm(family);
  if (fam === 'Local') return true;
  if (FAMILY_ROUTES[fam]) return availableRoutes(fam, presence, opts).length > 0;
  const key = FAMILY_KEY[fam];
  // A family this table does not know is not hidden: unknown is not "no key".
  if (!key) return true;
  return !!presence[key];
}

/**
 * The families to offer in a family <select>: those with a key, plus `current`
 * in its original position even when its key is gone.
 */
export function visibleFamilies(
  all: readonly string[], presence: KeyPresence | null, current?: string | null, opts?: AccessOpts,
): string[] {
  const cur = (current || '').toLowerCase();
  return all.filter((f) => f.toLowerCase() === cur || familyAvailable(f, presence, opts));
}

export type RouteChoice =
  /** Offer a switch between `routes`. */
  | { mode: 'choose'; routes: string[] }
  /** Exactly one route is possible and it is the one in use: say so, no switch. */
  | { mode: 'fixed'; route: string };

/**
 * Whether to draw a provider switch. A switch appears only when it can switch
 * to something: two or more reachable routes, or the route in use is itself
 * unreachable (then the way out to the reachable one has to stay on screen).
 */
export function routeChoice(
  family: string, presence: KeyPresence | null, current: string, opts?: AccessOpts,
): RouteChoice {
  const declared = (FAMILY_ROUTES[norm(family)] ?? []).map((r) => r.id);
  const avail = availableRoutes(family, presence, opts);
  const routes = declared.filter((id) => avail.includes(id) || id === current);
  if (routes.length <= 1) return { mode: 'fixed', route: routes[0] ?? current };
  return { mode: 'choose', routes };
}
