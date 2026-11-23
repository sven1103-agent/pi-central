/**
 * Which Pi Central the shell is about to launch, and whether that is the one you are looking at (issue #244).
 *
 * ## The confusion this exists to end
 *
 * `npm run install-app` builds the desktop shell, and the shell launches the **installed npm package** — not the
 * checkout it was built from (ADR-0013: the app is a launcher, so there is one artifact and one version). That is
 * correct by design, and it produces a trap:
 *
 *   - a developer builds the app to look at their work;
 *   - the app shows the UI of whatever `npm install -g` last put on disk;
 *   - both report the same version, because an unreleased checkout and the last release are often the same number.
 *
 * Measured on a real machine: the dock showed the old single-strip topbar while the checkout had the activity bars,
 * and nothing anywhere said which package was running. `grep -c navrail` on the installed `dist/ui` was 0.
 *
 * So the launch states which directory it is serving from, and says when that directory is not the shell's own source
 * tree. Not an error — running the installed package is the normal case, and a locally built app is exactly how a
 * reader tries a release before publishing it.
 *
 * ## Why the decision is a pure function
 *
 * The three inputs (`pkg.root`, the shell's own path, whether a `PI_CENTRAL_PACKAGE` override was used) come from
 * Electron at runtime and cannot be exercised by `node --test`, which cannot load `main.ts` at all. The judgement —
 * "is this directory the checkout I am built from?" — is what can be wrong, so it lives here.
 */

/** Where a launch is serving Pi Central from. */
import { resolve } from "node:path";

export interface LaunchOrigin {
  /** The package root the orchestrator will be started from. */
  packageRoot: string;
  /**
   * The directory holding the shell's own sources, when it is running from a checkout. `undefined` for an installed
   * app, which is the normal case.
   */
  shellSourceRoot: string | undefined;
  /** True when `PI_CENTRAL_PACKAGE` chose the root, so the reader already knows. */
  overridden: boolean;
}

/**
 * A one-line statement of what is being launched, plus a caveat when it is worth one.
 *
 * Returns `{ message, caveat }`. `caveat` is `undefined` in the cases where saying more would be noise:
 *
 *   - an installed app serving the installed package — the designed path, and the reader chose it;
 *   - an override the reader set by hand — they already said where to look.
 */
export function describeLaunch(origin: LaunchOrigin): {
  message: string;
  caveat: string | undefined;
  /** Present when the launch must not proceed. Takes precedence over \`caveat\`. */
  refusal?: string | undefined;
} {
  const message = `Pi Central: serving the package at ${origin.packageRoot}`;

  if (origin.overridden) return { message, caveat: undefined };

  /*
   * The checkout case: the run started from a working tree but serves a DIFFERENT package.
   *
   * And it is not only a warning, because the mistake was measured. `npm run app` from a checkout served the globally
   * installed package instead -- `/opt/homebrew/lib/node_modules/pi-central` -- and the shell happily launched it,
   * showing a reader an interface from a build that contained none of their changes. The launcher's own log said
   * "serving the package at /opt/homebrew/…" and nothing else; the code being tested was never on screen.
   *
   * A warning would not have prevented that: every symptom (a missing control, no error, a plausible interface) points
   * at the code, not at the launch path. So a launch from a checkout that would serve another package is REFUSED, naming
   * the override. The reader can always choose the other package explicitly.
   */
  if (origin.shellSourceRoot !== undefined && !isWithin(origin.packageRoot, origin.shellSourceRoot)) {
    return {
      message,
      caveat: undefined,
      refusal:
        `this run started from the checkout at ${origin.shellSourceRoot}, but it would serve Pi Central from ` +
        `${origin.packageRoot}. That package's interface contains none of your working tree's changes.` +
        `\n\nTo run the checkout, set PI_CENTRAL_PACKAGE=${origin.shellSourceRoot} (and run ` +
        `npm run build:package there first). To run the installed package deliberately, unset PI_CENTRAL_DEV or ` +
        `launch the installed app.`,
    };
  }
  return { message, caveat: undefined };
}

/**
 * The checkout the shell was started from, or `undefined` when it is an installed app.
 *
 * Derived from `process.argv[1]`, which is `<checkout>/packages/app/src/main.ts` for `npm run app` and
 * `<App>.app/Contents/Resources/app.asar/main.js` for an installed bundle. The test is structural rather than a path
 * comparison — `…/src/main.ts` is a checkout, anything else is a bundle — because an installed app has no sources
 * beside it and therefore nothing the reader could be editing.
 *
 * `app-icon.ts` resolves the icon path the same way and for the same reason.
 */
export function shellSourceRoot(entryPath: string | undefined): string | undefined {
  if (entryPath === undefined || entryPath === "") return undefined;
  /*
   * Resolved to an absolute path BEFORE matching, and that ordering is the whole fix.
   *
   * `npm run app` passes Electron a RELATIVE entry -- `packages/app/src/main.ts` -- so the pattern, which requires a
   * separator before `packages`, matched nothing and this returned `undefined`. Undefined means "an installed app",
   * which means the checkout refusal and the adopt-a-stranger refusal both stayed silent while the app adopted an
   * orchestrator started from a different package. Measured: `npm run app` from this checkout loaded pid 4806 and
   * printed four lines about adoption, with no refusal.
   */
  const absolute = resolve(entryPath);
  const match = /^(.*)[/\\]packages[/\\]app[/\\]src[/\\][^/\\]+$/.exec(absolute);
  return match?.[1];
}

/** Is `path` inside `root`? Trailing separators tolerated; both are expected to be absolute. */
function isWithin(path: string, root: string): boolean {
  const normalise = (value: string): string => (value.endsWith("/") ? value.slice(0, -1) : value);
  const candidate = normalise(path);
  const base = normalise(root);
  return candidate === base || candidate.startsWith(`${base}/`);
}
