/**
 * Which build is this page (issue #114).
 *
 * ## The problem this solves, in one line
 *
 * Four times in one session a UI fix appeared not to work because half the system was stale — a rebuilt
 * `dist/`, a tab holding an old bundle, an orchestrator with cached modules — and each time the only way
 * to tell was to `curl` the served HTML, grep an asset hash, and compare it to the file on disk.
 *
 * The bundle knows its own identity. It should say it.
 *
 * ## Why the values are injected rather than derived
 *
 * A browser cannot read the commit it was built from. Vite has that at build time, so it is compiled in
 * as a literal — which also means a stale page is exactly the page whose stamp is old, rather than one
 * that queries something and might get a fresh answer.
 */
export interface BuildInfo {
  /** The commit the UI was built from, or `dev` when the build did not have one. */
  commit: string;
  /** ISO timestamp of the build. */
  builtAt: string;
}

/**
 * Read the injected identity, defaulting to values that are honest about being absent.
 *
 * `dev` rather than an empty string: a missing commit means "this build was not made from a tagged
 * checkout", which is true of a local `npm run ui:build` and should read as such rather than looking
 * like a broken value.
 */
export function buildInfo(): BuildInfo {
  return {
    commit: import.meta.env["VITE_PI_CENTRAL_COMMIT"] || "dev",
    builtAt: import.meta.env["VITE_PI_CENTRAL_BUILT_AT"] || "unknown",
  };
}

/** A short, glanceable form: `a1b2c3d · 2026-10-29 08:41`. */
export function buildLabel(info: BuildInfo = buildInfo()): string {
  // The time is trimmed to minutes: seconds are noise, and the date is what distinguishes "yesterday's
  // build" from "the one I just made".
  const when = info.builtAt === "unknown" ? "unknown build time" : info.builtAt.slice(0, 16).replace("T", " ");
  return `${info.commit} · ${when}`;
}
