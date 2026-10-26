/**
 * The hazard of pointing a session at the checkout Pi Central is running from (issue #25).
 *
 * ## Why this is worth naming
 *
 * Three failures follow from it, and none of them looks like the actual cause — see
 * `docs/DOGFOODING.md` for the full account:
 *
 *   1. Vite hot-reloads the UI you are using into a mid-edit error overlay.
 *   2. A branch switch desynchronises the UI and the orchestrator.
 *   3. If the agent breaks the orchestrator's source, the next restart loads it, and Pi Central
 *      becomes unavailable exactly when it is needed to supervise the repair.
 *
 * Without a warning, a user sees a dashboard that mysteriously stops working and has no reason to
 * connect that to the directory they chose. The warning names the consequences, not the condition.
 *
 * ## Why the predicate lives in the PROTOCOL package
 *
 * It is needed in **two** places and must give the same answer in both: the directory sheet warns
 * *before* spawning (in the browser) and the supervisor attaches the warning to the session so it
 * persists on the rail afterwards (in the orchestrator). Two implementations would be two chances to
 * disagree, and the disagreement would be invisible — one surface warning, the other not.
 *
 * So it lives in the package both sides already share, rather than in the orchestrator with the UI
 * importing across packages. It is dependency-free and pure, which is what keeps it safe to put in
 * the protocol: nothing here reads a file, a clock, or the environment, so it adds no runtime
 * behaviour to the client bundle beyond a few hundred bytes of string comparison.
 *
 * It is also **pure**: two paths in, a boolean out. No filesystem, no configuration, no module
 * state. That is what makes the cases testable, including the one that must be FALSE (a separate
 * clone) and would otherwise be a bug nobody notices until the recommended setup nags them.
 *
 * ## Ancestor, descendant, and the same directory
 *
 * All three are hazards, and for different reasons:
 *
 *   - **The same directory**: the obvious case.
 *   - **An ancestor** (e.g. `~/git` containing the checkout): a session there is sandboxed to that
 *     broader tree, so it can write the checkout's files anyway. The sandbox grants the working
 *     directory, so a parent *is* a grant on the child.
 *   - **A descendant** (e.g. `packages/ui`): editing one package is enough to hot-reload the UI or
 *     break the orchestrator. It is less obviously a hazard than the parent, which is exactly why it
 *     would be missed.
 *
 * ## What must NOT warn
 *
 * A sibling clone — `~/git/pi-central-dev` while running from `~/git/pi-central` — is the
 * recommended setup, and it is protected by the sandbox (a session cannot write a sibling at all).
 * Warning there would train the user to dismiss the warning, which is worse than not having one.
 */

/** The names a Pi Central installation is recognisable by. */
const PIPELINE_MARKERS = ["packages/orchestrator", "packages/ui", "packages/protocol"] as const;

/**
 * Normalise a path for comparison.
 *
 * Trailing slashes are removed and `.`/`..` segments are resolved **textually**, with no filesystem
 * access. `realpath` is deliberately not used: the predicate must be sync and pure for the sheet to
 * call it on every keystroke, and a symlink that resolves differently from its spelling (a common
 * macOS `/tmp` → `/private/tmp`) is a case where warning is the safer error — the consequence of a
 * false positive is a sentence on screen, and the consequence of a false negative is a broken
 * dashboard.
 *
 * A root path (`/`) survives as `/` rather than becoming empty, so "is the parent of everything"
 * does not silently become "the empty string".
 */
export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  const joined = parts.join("/");
  return path.startsWith("/") ? `/${joined}` : joined;
}

/**
 * Is `candidate` the same directory as `installation`, inside it, or a parent of it?
 *
 * Comparison is on whole path SEGMENTS, which is the detail that makes the sibling case correct:
 * a bare `startsWith` would call `…/pi-central-dev` a descendant of `…/pi-central`, and that is
 * precisely the configuration that must not warn.
 *
 * A session is sandboxed to its working directory, so an ancestor is a hazard for the same reason
 * the directory itself is: the policy grants the working directory, and a parent grant includes the
 * child.
 */
export function isOwnInstallation(candidate: string, installation: string): boolean {
  const a = normalizePath(candidate);
  const b = normalizePath(installation);
  if (a.length === 0 || b.length === 0) return false;
  if (a === b) return true;
  // `/a/b` is inside `/a`; `/a/bc` is not. The slash is what enforces the segment boundary — a
  // bare `startsWith` would call the sibling clone `pi-central-dev` a descendant of `pi-central`,
  // which is the one case that must NOT warn.
  return isInside(a, b) || isInside(b, a);
}

/**
 * Is `child` inside `parent` (strictly)?
 *
 * The root is special-cased, and not for tidiness: `parent + "/"` is `"//"` when the parent IS
 * `/`, which matches nothing — so the one directory that contains everything would have been the
 * only one that warns about nothing. Found by a test asserting that a session in `/` is an ancestor
 * of every checkout.
 */
function isInside(child: string, parent: string): boolean {
  if (parent === "/") return child !== "/";
  return child.startsWith(`${parent}/`);
}

/**
 * Does this path look like a Pi Central checkout at all?
 *
 * Distinguished from "is the running installation" because the two have different consequences and
 * different copy. A `__dirname` fallback is reported as *unidentifiable* rather than as *safe* —
 * "I could not tell where I am running from" and "you are not pointing at me" are different
 * statements, and collapsing them would make the warning silently stop working.
 */
export function looksLikePiCentral(paths: readonly string[]): boolean {
  const normalized = paths.map(normalizePath);
  return PIPELINE_MARKERS.every((marker) =>
    normalized.some((path) => path === marker || path.endsWith(`/${marker}`)),
  );
}

/**
 * The warning to show, or `undefined` when there is nothing to say.
 *
 * **The copy names the consequences**, because "this is the installation Pi Central is running
 * from" describes a condition the reader cannot evaluate. What they need to know is which three
 * things break, so that the sentence alone is enough to decide.
 *
 * Returns a single string (not a paragraph or an array) so the same value can go into
 * `LiveSession.warnings` — which the rail renders as one line with a tooltip — and into the sheet.
 */
export const OWN_INSTALLATION_WARNING =
  "This is the checkout Pi Central is running from. Editing it can hot-reload this UI, desynchronise " +
  "it from the orchestrator on a branch switch, and leave Pi Central unable to restart if the " +
  "orchestrator's source is broken — exactly when you need it. Use a separate clone (see " +
  "docs/DOGFOODING.md).";

/**
 * The warning for a candidate directory, given where Pi Central is running from.
 *
 * `installation === undefined` means the path could not be determined, and the result is
 * deliberately `undefined` rather than a warning: a warning that fires on every session would be
 * noise, and the honest report for "unknown" is the absence of a claim rather than a guess. The
 * caller is expected to say the path was unidentifiable where that matters (the startup banner),
 * not to attach a per-session warning to it.
 */
export function ownInstallationWarning(
  candidate: string,
  installation: string | undefined,
): string | undefined {
  if (installation === undefined) return undefined;
  return isOwnInstallation(candidate, installation) ? OWN_INSTALLATION_WARNING : undefined;
}
