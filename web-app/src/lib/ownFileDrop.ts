/**
 * A file dragged out of NEXUS's own page (a video/audio/image player in a
 * message bubble) must be re-fetched from its URL, not taken from the drop.
 *
 * Measured 2026-11-18 (つよ's report): dragging the 39 MB 「残った石」 video
 * from a bubble into the input produced an attachment of EXACTLY 10,485,760
 * bytes named "workspace-file.mp4", and its sha256 matched the first 10 MiB of
 * the real file. Chrome builds the dragged File from what its media cache has
 * already buffered for playback (the player streams with Range requests), not
 * from the whole resource. An mp4 whose index (moov) sits at the end is then
 * unplayable: the bubble showed an empty player and Gemini answered 400
 * INVALID_ARGUMENT.
 *
 * So: when the drop carries a same-origin URL into one of the routes below,
 * the drop's File is not trusted and the bytes are fetched whole. Files from
 * the OS (Explorer) carry no such URL and are untouched.
 */

const OWN_FILE_ROUTES = ['/api/workspace-file', '/api/attachments/', '/api/camera-file', '/api/letters/'];

export interface OwnFileSource {
  url: string;
  /** A real name when the URL carries one (the desk path); else null. */
  name: string | null;
}

/** First non-comment line of a text/uri-list payload. */
function firstUri(uriList: string): string | null {
  for (const line of uriList.split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith('#')) return t;
  }
  return null;
}

/**
 * Chrome puts the source URL on a drag in different slots depending on what
 * was dragged, so look in all three: `text/uri-list`, a `src="…"` in
 * `text/html`, and `DownloadURL` ("mime:name:url").
 */
export function dropUrlCandidates(get: (type: string) => string): string[] {
  const out: string[] = [];
  const uri = firstUri(get('text/uri-list') || '');
  if (uri) out.push(uri);
  const html = get('text/html') || '';
  const m = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(html);
  if (m) out.push(m[1].replace(/&amp;/g, '&'));
  const dl = get('DownloadURL') || '';
  const dm = /^[^:]*:[^:]*:(.+)$/.exec(dl);
  if (dm) out.push(dm[1]);
  return out;
}

export function ownFileSourceFromDrop(uriList: string | null | undefined, origin: string): OwnFileSource | null {
  if (!uriList) return null;
  const raw = firstUri(uriList);
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw, origin); } catch { return null; }
  if (u.origin !== origin) return null;
  if (!OWN_FILE_ROUTES.some(r => u.pathname === r || u.pathname.startsWith(r))) return null;
  let name: string | null = null;
  const p = u.searchParams.get('path');
  if (p) {
    const base = p.split(/[\\/]/).filter(Boolean).pop();
    if (base) name = base;
  }
  return { url: u.pathname + u.search, name };
}
