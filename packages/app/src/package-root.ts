/**
 * Where is the installed Pi Central package (issue #214, ADR-0013)?
 *
 * ## Why the shell resolves this itself instead of importing the orchestrator's copy
 *
 * The orchestrator already has `findOwnPackage()` (`packages/orchestrator/src/package-meta.ts`), and
 * ADR-0013 §3 says resolution is by NAME and relative to the package root. Reusing that *rule* is
 * required; importing that *module* is not, and would be wrong in a way that is invisible until the
 * worst moment:
 *
 *   - The artifact the shell launches is a **bundle** (`bin/pi-central.js`). Importing the
 *     orchestrator's source would mean the shell carries a second copy of the resolution logic,
 *     compiled at the shell's build time, and asks it about a package that may since have moved.
 *   - More practically, an Electron app that cannot locate the package still has to say *which*
 *     package it could not find. A module that lives inside the package is a strange place from which
 *     to report that the package is missing.
 *
 * So the walk is written here, small enough to audit, and `package-root.test.ts` pins it against the
 * real installed artifact rather than against a fixture the test also invented.
 *
 * ## The walk
 *
 * Up from a starting point, looking for a `package.json` whose `name` is `pi-central` — not the first
 * `package.json` found. The difference is the whole point: from a checkout, the first manifest on the
 * way up belongs to `@pi-central/orchestrator` and its version merely agrees today.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";

/** The published package's name. The one the shell launches and a user installs. */
export const PACKAGE_NAME = "pi-central";

export interface PackageRoot {
  /** Absolute path to the package's `package.json`. */
  manifest: string;
  /** Absolute path to the package root — where `bin/` and `dist/` live. */
  root: string;
  version: string;
  /** The entry the shell spawns: `<root>/bin/pi-central.js`. */
  bin: string;
}

/**
 * Read a `package.json` as an object, or `undefined` when it is absent or not an object.
 *
 * `undefined` rather than a throw: every caller here is *searching*, and a malformed manifest three
 * directories up is not an error if the real one is one directory up.
 */
function readManifest(path: string): { name?: unknown; version?: unknown } | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as { name?: unknown; version?: unknown };
  } catch {
    return undefined;
  }
}

/**
 * Find the installed package by walking up from `from`.
 *
 * `undefined` when nothing matches, because the caller must be able to *report* that rather than
 * render an empty window: "no package here" and "the package is broken" have different fixes.
 */
export function findPackageRoot(from: string): PackageRoot | undefined {
  let directory = from;
  for (;;) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      const parsed = readManifest(manifest);
      if (parsed?.name === PACKAGE_NAME && typeof parsed.version === "string") {
        return { manifest, root: directory, version: parsed.version, bin: join(directory, "bin", "pi-central.js") };
      }
    }
    const parent = dirname(directory);
    // `parse(dir).root === dir` is the portable stop condition; comparing to "/" misses a drive root.
    if (parent === directory || directory === parse(directory).root) return undefined;
    directory = parent;
  }
}

/**
 * Find a package named `pi-central` **inside** `directory`, one level down.
 *
 * ## The bug this fixes, which shipped in #214 and broke every global install
 *
 * `findPackageRoot` walks *up* — it answers "which package am I inside of?". That is the right question for a
 * directory within a checkout, and the wrong one for a `node_modules` directory, where the package is a **child**.
 * `locatePackage` was handing it `/opt/homebrew/lib/node_modules`, so a global install was never found: the window
 * said "Pi Central is not installed" while the package sat one directory below the path being searched, and it
 * listed that very path among "locations checked".
 *
 * It went unnoticed because the app only ever worked when *the app itself* lived inside the package — the
 * developer's case, where the walk-up found it. The failure appeared the first time it was launched as an
 * installed `.app` over a separate global install, which is the case the shell exists for.
 *
 * So both shapes are tried, inside-then-up, and `resolvePackage` decides between them. Trying the child FIRST is
 * deliberate: a `node_modules` directory that contains our package is a statement about where the package is,
 * while walking up from it would find some unrelated manifest higher in the prefix.
 */
export function findPackageInside(directory: string): PackageRoot | undefined {
  const candidate = join(directory, PACKAGE_NAME);
  const manifest = join(candidate, "package.json");
  if (!existsSync(manifest)) return undefined;
  const parsed = readManifest(manifest);
  if (parsed?.name !== PACKAGE_NAME || typeof parsed.version !== "string") return undefined;
  return { manifest, root: candidate, version: parsed.version, bin: join(candidate, "bin", "pi-central.js") };
}

/** How resolution failed, in the two shapes that need different sentences. */
export type PackageLookup =
  | { ok: true; package: PackageRoot }
  | { ok: false; reason: "not-found"; message: string }
  | { ok: false; reason: "incomplete"; message: string; package: PackageRoot };

/**
 * Resolve the package the shell should launch.
 *
 * `override` is the explicit escape hatch (`PI_CENTRAL_PACKAGE`), and it takes the same walk from the
 * given directory rather than being trusted verbatim: a user pointing at a *file* or at the wrong
 * directory should get the named refusal, not a spawn of something that is not the artifact.
 *
 * The binary's existence is checked separately from the manifest's, because they fail differently and
 * the sentences differ: a package with a manifest and no `bin/` is a `--ignore-scripts` install or a
 * checkout that was never built, and saying "Pi Central is not installed" there would send a reader to
 * reinstall something that is present.
 */
export function resolvePackage(options: { override?: string | undefined; from?: string } = {}): PackageLookup {
  const start = options.override ?? options.from;
  if (start === undefined) {
    return {
      ok: false,
      reason: "not-found",
      message:
        "Pi Central's package directory could not be determined, so there is nothing to start. " +
        "Set PI_CENTRAL_PACKAGE to the directory that holds pi-central's package.json.",
    };
  }
  const found = findPackageInside(start) ?? findPackageRoot(start);
  if (found === undefined) {
    return {
      ok: false,
      reason: "not-found",
      message: options.override === undefined
        ? "Pi Central's package directory could not be determined, so there is nothing to start. " +
          "Set PI_CENTRAL_PACKAGE to the directory that holds pi-central's package.json."
        : `No pi-central package at ${options.override}: no package.json there (or above it) names "${PACKAGE_NAME}".`,
    };
  }
  if (!existsSync(found.bin)) {
    return {
      ok: false,
      reason: "incomplete",
      message:
        `Pi Central is installed at ${found.root}, but its entry point is missing: ${found.bin}. ` +
        "That is a package without its bundle — reinstall it (npm install -g pi-central@latest), " +
        "or, in a checkout, run npm run build:package.",
      package: found,
    };
  }
  return { ok: true, package: found };
}

/**
 * Every directory worth searching for a global install, in the order a shell would.
 *
 * Used only to make the *failure* message useful: when resolution finds nothing, naming the places
 * that were looked in turns "not installed" into "installed in a prefix I did not know about".
 *
 * `npm root -g` is deliberately not run here — this module stays free of subprocesses so it can be
 * tested with a plain temporary directory — and the runner in `executables.ts` is where a login shell
 * is available.
 */
export function candidateRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots: string[] = [];
  const prefix = env["npm_config_prefix"] ?? env["NPM_CONFIG_PREFIX"];
  if (prefix !== undefined && prefix !== "") roots.push(join(prefix, "lib", "node_modules"));
  if (env["HOME"] !== undefined && env["HOME"] !== "") roots.push(join(env["HOME"], ".npm-global", "lib", "node_modules"));
  // Homebrew on Apple Silicon is the documented install on this machine, so it is named rather than
  // left to a glob: a message that guesses is worse than one that states what it checked.
  roots.push("/opt/homebrew/lib/node_modules", "/usr/local/lib/node_modules");
  return roots;
}
