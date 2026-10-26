/**
 * Where this Pi Central installation lives, derived at runtime (issue #25).
 *
 * **Not configured, and that is the point** — the issue's constraint. A path in a config file would
 * be right for exactly one checkout (the author's) and silently wrong for everyone else, which is
 * worse than no detection because it would look like it was working.
 *
 * In its own module rather than beside the static file server, because the two answer unrelated
 * questions: `static-ui.ts` resolves where the *UI bundle* is, and this resolves where *the
 * installation* is. The supervisor needs this one and has no business importing an HTTP file
 * server to get it.
 *
 * Derived from THIS module's URL and walked up to the repository root. The walk is bounded and
 * checks for the pipeline's own package directories rather than assuming a fixed depth, so moving a
 * file within the package cannot quietly point the warning at the wrong directory. When the walk
 * finds nothing, `undefined` is returned and callers report the path as unidentifiable rather than
 * as safe — "I could not tell where I am" and "you are not pointing at me" are different statements.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { looksLikePiCentral } from "@pi-central/protocol";

export function resolveInstallationRoot(moduleUrl: string = import.meta.url): string | undefined {
  let current = fileURLToPath(new URL(".", moduleUrl));
  // Bounded so a surprising layout cannot walk to `/` and claim the filesystem is Pi Central.
  for (let depth = 0; depth < 8; depth += 1) {
    const parent = resolve(current, "..");
    if (parent === current) return undefined;
    if (looksLikeInstallationRoot(parent)) return parent;
    current = parent;
  }
  return undefined;
}

/**
 * Is this directory the root of a Pi Central checkout?
 *
 * Recognised by its WORKSPACE PACKAGES rather than by a directory name, because a checkout may be
 * called anything (`pi-central-dev`, `pi-central`, a temporary clone). All three are required: two
 * would mistake an unrelated repository that happens to have a `packages/ui`.
 *
 * `existsSync` is checked here and the list is then handed to the shared `looksLikePiCentral`, so
 * the naming rule lives in one place and this cannot disagree with the UI about what a checkout
 * looks like.
 *
 * The existence check is load-bearing, and its absence was a real bug: a list built by
 * concatenation trivially ENDS WITH the marker it was built from, so
 * `looksLikePiCentral(["/…/packages/orchestrator/packages/ui", …])` answered "yes" for every
 * directory. The walk therefore stopped at its first step and reported `packages/orchestrator` as
 * the installation root — a warning that would have pointed at the wrong tree for every session.
 */
function looksLikeInstallationRoot(directory: string): boolean {
  const markers = [
    join(directory, "packages", "orchestrator"),
    join(directory, "packages", "ui"),
    join(directory, "packages", "protocol"),
  ];
  if (!markers.every((marker) => existsSync(marker))) return false;
  return looksLikePiCentral(markers);
}
