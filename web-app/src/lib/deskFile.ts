import { promises as fsp } from 'fs';
import path from 'path';
import { resolveWorkspacePathSafe, realpathAllowingMissing } from '@/lib/fsStorage';
import { beingWorkspaceDir } from '@/lib/beingPaths';

// One desk path -> the real file, or null. Shared by /api/workspace-file (what a
// message SHOWS) and lib/beingRouteExec (what a `[->name]` block ATTACHES), so
// the two can never disagree about which paths are on a being's desk.
// Moved verbatim out of the route on 2026-11-15; fullAccess is NOT consulted.

/**
 * Make an absolute path the being can actually observe work.
 *
 * local_data is commonly a junction (here: C:\dev\nexus\local_data →
 * C:\dev\common\local_data), and the shared resolver's FIRST containment check
 * compares raw, pre-realpath strings against the junction-side workspace root.
 * So the junction-side absolute path passes and the real-side one — which is
 * what `pwd` prints inside the entity's own shell, and what the human sees in
 * Explorer — is rejected. Measured: link-side 200, real-side 403.
 *
 * Rather than loosening that shared check (it is the first gate for every file
 * tool, not just this route), strip the workspace prefix here when the absolute
 * path lies inside the workspace's REAL location, handing the resolver an
 * ordinary relative path. Anything that does not match is passed through
 * untouched, so containment is still decided by the resolver and not by this
 * function: C:\Windows\... cannot be rewritten into something acceptable.
 *
 * The absolute path is compared both as written and after realpath, so the
 * OTHER instance's link-side path works too: two houses share one local_data,
 * a message written in one is read in the other, and C:\dev\nexus\... is not a
 * prefix of C:\dev\nexus-cairn\... Measured: without this, the same markdown
 * rendered on 3000 and vanished on 3001.
 */
async function normalizeAbsoluteInsideWorkspace(folder: string, p: string): Promise<string> {
  if (!path.isAbsolute(p)) return p;
  const root = path.resolve(beingWorkspaceDir(folder));
  let realRoot: string;
  try { realRoot = await fsp.realpath(root); } catch { realRoot = root; }
  const abs = path.resolve(p);
  const realAbs = (await realpathAllowingMissing(abs)) || abs;
  for (const base of [realRoot, root]) {
    for (const cand of [abs, realAbs]) {
      if (cand === base) return '';
      if (cand.toLowerCase().startsWith(base.toLowerCase() + path.sep)) {
        return cand.slice(base.length + 1);
      }
    }
  }
  return (await relativeThroughWorkspaceLink(root, realAbs)) ?? p;
}

/**
 * Rewrite an absolute path into "<linkName>/<tail>" when it lands inside
 * something junctioned INTO the workspace.
 *
 * The shared folder is reached this way (beings/<X>/workspace/common_workspace
 * → ...\local_data\common_workspace), and that target is a SIBLING of the
 * workspace, not a descendant — so there is no workspace prefix to strip and
 * the absolute path was rejected even though the very same bytes are served
 * under the link's relative name. Every tool that produces a file there prints
 * the absolute form (ComfyUI's --out, pwd, Explorer), so the natural `![](...)`
 * failed while the equivalent relative one worked. Measured: identical bytes,
 * 403 vs 200.
 *
 * Containment is NOT widened: what comes back is exactly the relative path the
 * being could already have written, and resolveWorkspacePathSafe still judges
 * it (realpath + workspace/trusted-junction prefix check). An absolute path
 * that is not under one of these links falls through unchanged and is refused
 * as before — C:\Windows\... cannot be rewritten into something acceptable,
 * and neither can another being's workspace.
 *
 * Only the top level of the workspace is scanned, and only for absolute paths
 * that already failed the prefix test, so a relative request costs nothing.
 */
async function relativeThroughWorkspaceLink(root: string, realAbs: string): Promise<string | null> {
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isSymbolicLink()) continue;
    const realLink = await realpathAllowingMissing(path.join(root, e.name));
    if (!realLink) continue;
    if (realAbs === realLink) return e.name;
    if (realAbs.toLowerCase().startsWith(realLink.toLowerCase() + path.sep)) {
      return path.join(e.name, realAbs.slice(realLink.length + 1));
    }
  }
  return null;
}

/** A relative or absolute desk path -> the contained real path, or null when it escapes the workspace. */
export async function resolveDeskFile(folder: string, rawPath: string): Promise<string | null> {
  const relPath = await normalizeAbsoluteInsideWorkspace(folder, rawPath);
  return relPath ? await resolveWorkspacePathSafe(folder, relPath) : null;
}
