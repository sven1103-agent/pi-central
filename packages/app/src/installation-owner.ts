/**
 * Who owns this installation, and whether this app may replace it (issue #217).
 *
 * ## The defect this exists for
 *
 * The first version of the update path ran `npm install --global pi-central@<v>` and called that "the app updates
 * itself". It assumed an installation shape this project does not require and cannot guarantee. On the machine this
 * was developed on, measured:
 *
 *   - `npm prefix -g` is **`/opt/homebrew`** — Homebrew's prefix, because node is a Homebrew formula.
 *   - `/opt/homebrew/lib/node_modules` is **not writable** by the user, so a plain `npm install -g` fails `EACCES`.
 *   - `pi-central` is **not** a Homebrew formula (`brew list` does not know it), so `npm` put it inside a tree
 *     Homebrew owns — the worst of both: not managed, and not writable.
 *   - The resolved `node` is `/opt/homebrew/Cellar/node/26.13.0_2/bin/node`, and `/opt/homebrew/bin/npm` is a symlink
 *     into the same Cellar directory. So the `npm` that must be used is the one **beside the node the app already
 *     resolved**, not whatever a login shell finds — a version manager's `npm` would install into a different prefix
 *     and "verify the installed version" would then read the wrong tree.
 *   - A **linked** install (`npm link`, or the repository `npm install -g .`) puts a **symlink** at
 *     `…/lib/node_modules/pi-central`. `npm install -g` over a link replaces the link with a real directory, quietly
 *     orphaning the working copy the reader was developing against.
 *
 * Every one of those makes "install it with npm" the wrong action. So the owner is decided first, and only an
 * installation this app is allowed to change may be changed. **Refusing is the correct outcome** in every other case:
 * there is no partial state to preserve, and replacing a file a package manager owns is the kind of "fix" that breaks
 * a machine.
 *
 * ## Why this is not a heuristic on the version string
 *
 * Ownership cannot be inferred from what is installed — it is a fact about *paths and managers*, and each kind has a
 * distinct, checkable signal. The signals are, in order of specificity:
 *
 *   1. **Homebrew** — the package root is inside a Homebrew Cellar or keg, or `brew` knows a formula of that name.
 *   2. **A version manager** — the installation sits under a prefix that a node version manager owns (`.nvm`, `.volta`,
 *      `.asdf`, `fnm`'s store, `~/.local/share/fnm`), where a shell-level `npm -g` is the only way in and the app has no
 *      business guessing which shell.
 *   3. **Not writable** — whatever the manager, an install into a prefix this user cannot write is refused with the
 *      `sudo` sentence rather than an `EACCES` from npm three steps later.
 *   4. **A linked working copy** — the package root is a symlink, so installing would replace it.
 *   5. **Our own npm install** — a real directory under a writable npm prefix, which is the one case this app may
 *      replace.
 *
 * ## What is NOT decided here
 *
 * Whether an update is *available*, and whether it is safe to stop the child. Those are `update-decide.ts` and
 * `updater.ts`. This module answers one question — "may this app replace this installation?" — because getting it
 * wrong in either direction is expensive.
 */
import { lstatSync, readlinkSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve, sep } from "node:path";

/**
 * How an installation is managed, as far as this app can tell.
 *
 * `undefined` means "could not tell", which is deliberately distinct from `"unknown-manager"`: the first is a probe
 * that failed, the second is a probe that succeeded and found nothing recognisable. Both refuse, and they say different
 * things.
 */
export type InstallationOwner =
  /** A Homebrew formula or keg. `brew upgrade` owns the version. */
  | { kind: "homebrew"; reason: string; formula?: string | undefined }
  /** A node version manager's store (nvm, volta, asdf, fnm). The reader's shell owns the version. */
  | { kind: "version-manager"; reason: string; manager: string }
  /** An npm global prefix owned by this user — the one case the app may replace. */
  | { kind: "npm-global"; reason: string; prefix: string }
  /** A linked working copy: installing would replace the link and orphan the checkout. */
  | { kind: "linked"; reason: string; target?: string | undefined }
  /** Present, but not writable by this user. */
  | { kind: "not-writable"; reason: string }
  /** Nothing recognisable was found at the path. */
  | { kind: "unknown-manager"; reason: string }
  /** The probe could not run, so nothing is known. */
  | { kind: "undetermined"; reason: string };

/** What `decideOwner` may consult. Assembled by `main.ts`, which is the only part that can touch the filesystem. */
export interface OwnerEvidence {
  /** The package root the shell resolved and would launch (`PackageRoot.root`). */
  packageRoot: string;
  /** The `npm` the app would run — resolved beside the node it launches, not from a login shell. */
  npmPath: string | undefined;
  /** `npm prefix -g`'s answer, when it could be read. */
  npmPrefix: string | undefined;
  /** Whether the package root is a symlink (`lstat`, not `stat`). */
  packageRootIsSymlink: boolean;
  /** Where a symlinked package root points, for the message. */
  packageRootLinkTarget: string | undefined;
  /** Whether the user can write to the directory npm would install into. */
  installTargetWritable: boolean | undefined;
  /** A Homebrew formula name, when `brew` knows one. `undefined` when `brew` is absent or does not know it. */
  brewFormula: string | undefined;
  /** Whether a Homebrew Cellar or keg appears in the package root's path. */
  looksLikeCellar: boolean;
}

/**
 * Homebrew's own directory names, matched as path SEGMENTS so `…/Cellar-like-project/…` does not count.
 *
 * **`opt` is deliberately NOT in this list**, and the first version of this module had it there. `/opt` is an ordinary
 * POSIX directory: `/opt/homebrew` on Apple Silicon is Homebrew's root, but a package under `/opt/something-else` is
 * not Homebrew's — and on this machine `…/opt/homebrew/lib/node_modules/pi-central` was reported as a Homebrew install
 * on the strength of the `opt` segment alone. That is the wrong direction to be wrong in: refusing a self-managed
 * install is recoverable, while a reader following `brew upgrade` for a package Homebrew has never heard of is not.
 *
 * The real signals are `Cellar` (where Homebrew unpacks a version) and `<root>/opt/<name>` (a keg symlink, covered by
 * `HOMEBREW_ROOTS` below, because `opt` on its own is POSIX).
 *
 * **`keg` was in this list too, and it is not a directory name.** A keg is Homebrew's word for one versioned directory
 * inside `Cellar` — there is no `…/keg/…` in the layout (`ls /opt/homebrew` has `Cellar` and `opt`, not `keg`). Listing
 * it meant any directory that happened to be called `keg` anywhere on disk was classified as a Homebrew install, which
 * is how a test that built its tree under `…/keg/…` caught it. A segment list is only as good as the assertion behind
 * it that the segment exists.
 */
const CELLAR_SEGMENTS = ["Cellar"] as const;

/**
 * Homebrew roots, for the `opt/<formula>` form.
 *
 * `/opt/homebrew/opt/pi-central` and `/usr/local/opt/pi-central` are keg symlinks. The root is checked as a PREFIX
 * (segment-aware, via `isInside`) and `opt` only counted when it directly follows it — so `/opt/homebrew/lib/…` is not
 * treated as a keg while `/opt/homebrew/opt/…` is.
 */
const HOMEBREW_ROOTS = ["/opt/homebrew", "/usr/local", "/home/linuxbrew/.linuxbrew"] as const;

/** Whether `path` is a Homebrew keg symlink: `<root>/opt/<name>`. */
function looksLikeKeg(path: string): boolean {
  return HOMEBREW_ROOTS.some((root) => {
    const prefix = `${root}/opt/`;
    return path.startsWith(prefix) && path.length > prefix.length;
  });
}

/** Version-manager directories, matched as segments anywhere in the path. */
const VERSION_MANAGER_MARKERS: { manager: string; segments: string[] }[] = [
  { manager: "nvm", segments: [".nvm"] },
  { manager: "volta", segments: [".volta"] },
  { manager: "asdf", segments: [".asdf"] },
  { manager: "fnm", segments: [".fnm", "fnm_multishells", "fnm"] },
  { manager: "nodenv", segments: [".nodenv"] },
  { manager: "n", segments: [".n"] },
];

/** Whether `path` contains `segment` as a whole segment. A bare `includes` would match `Cellar-like`. */
function hasSegment(path: string, segment: string): boolean {
  return path.split(sep).includes(segment);
}

/**
 * Decide who owns the installation.
 *
 * The order matters: a Homebrew Cellar path that is also unwritable must be reported as **Homebrew**, because that is
 * the sentence with the actual fix (`brew upgrade pi-central`), while "not writable" would send the reader to `sudo`
 * — which cannot fix a formula.
 */
export function decideOwner(evidence: OwnerEvidence): InstallationOwner {
  const root = resolve(evidence.packageRoot);

  // 1. Homebrew, by formula or by path. Either is enough: `brew` may be absent from a GUI launch's PATH while the
  //    Cellar path is still conclusive.
  if (evidence.brewFormula !== undefined && evidence.brewFormula !== "") {
    return {
      kind: "homebrew",
      formula: evidence.brewFormula,
      reason: `${root} is installed by the Homebrew formula ${evidence.brewFormula}, so Homebrew owns this version`,
    };
  }
  if (evidence.looksLikeCellar || CELLAR_SEGMENTS.some((segment) => hasSegment(root, segment)) || looksLikeKeg(root)) {
    return {
      kind: "homebrew",
      reason: `${root} is inside a Homebrew Cellar or keg, so Homebrew owns this version`,
    };
  }

  // 2. A node version manager. Checked before writability, because the reader whose install is under `~/.nvm` usually
  //    CAN write it — and writing it would install into a Node version that their shell may not even be using.
  for (const { manager, segments } of VERSION_MANAGER_MARKERS) {
    if (segments.some((segment) => hasSegment(root, segment))) {
      return {
        kind: "version-manager",
        manager,
        reason: `${root} is inside ${manager}'s directory, so the version you get depends on your shell rather than on this app`,
      };
    }
  }

  // 3. A linked working copy. `npm install -g` over a link replaces the link with a real directory, orphaning the
  //    checkout the reader was working in.
  if (evidence.packageRootIsSymlink) {
    const target = evidence.packageRootLinkTarget === undefined ? "" : ` (it points at ${evidence.packageRootLinkTarget})`;
    return {
      kind: "linked",
      reason: `${root} is a symlink${target}, so it is a linked working copy rather than an installed package`,
      ...(evidence.packageRootLinkTarget === undefined ? {} : { target: evidence.packageRootLinkTarget }),
    };
  }

  // 4. Not writable. Reported with the sentence that actually fixes it.
  if (evidence.installTargetWritable === false) {
    return {
      kind: "not-writable",
      reason:
        `${root} is not writable by this user, so npm would fail with EACCES — a global prefix under ` +
        `${evidence.npmPrefix ?? "a system directory"} usually needs sudo, which an app must not do for you`,
    };
  }

  // 5. A probe that could not run at all.
  if (evidence.installTargetWritable === undefined) {
    return { kind: "undetermined", reason: `could not tell whether ${root} can be written` };
  }

  // 6. Our own npm global install.
  if (evidence.npmPrefix === undefined || evidence.npmPrefix === "") {
    return {
      kind: "undetermined",
      reason: `npm's global prefix could not be read, so this installation's shape is unknown`,
    };
  }
  return {
    kind: "npm-global",
    prefix: evidence.npmPrefix,
    reason: `${root} is a plain npm global install under ${evidence.npmPrefix}, which this app may replace`,
  };
}

/** Whether this app may install over the installation — the whole point of the module. */
export function maySelfUpdate(owner: InstallationOwner): boolean {
  return owner.kind === "npm-global";
}

/**
 * What to tell the reader instead of an update, when the app may not install one.
 *
 * ## Why this is a sentence rather than an error
 *
 * The reader did nothing wrong, and there is nothing to fix. What they need is *which* command updates their
 * installation — and that differs per manager, so the message names the exact one. This is the same rule the shell
 * follows for a missing executable: name the thing, do not describe the symptom.
 *
 * `kind` is carried so the caller can log a stable identifier while the prose stays free to improve.
 */
export function ownerRefusal(owner: InstallationOwner): { kind: string; message: string } {
  switch (owner.kind) {
    case "homebrew":
      return {
        kind: "homebrew",
        message:
          `Pi Central was installed by Homebrew${owner.formula === undefined ? "" : ` (${owner.formula})`}, so Homebrew ` +
          `decides which version is installed. Update it with:\n\n  brew upgrade ${owner.formula ?? "pi-central"}\n\n` +
          `This app will not install over a package Homebrew owns.`,
      };
    case "version-manager":
      return {
        kind: "version-manager",
        message:
          `Pi Central is installed inside ${owner.manager}'s directory, so which version you get depends on your shell. ` +
          `Update it the way you installed it:\n\n  npm install -g pi-central@latest\n\n` +
          `This app will not guess which Node version your shell is using.`,
      };
    case "linked":
      /*
       * The target is named in the message, not only in `reason`, because it is the one fact that identifies WHICH
       * threads this reader is holding: someone with two checkouts needs to know which one this app is running, and a
       * symlink whose target they forgot is the state that makes `npm unlink` feel like a gamble.
       */
      return {
        kind: "linked",
        message:
          `This Pi Central is a linked working copy, not an installed package` +
          (owner.target === undefined ? "" : ` — the link points at ${owner.target}`) +
          `. Updating it would replace the link and leave that directory untouched.\n\n` +
          `To move to a released version:  npm unlink -g pi-central && npm install -g pi-central@latest\n` +
          `To keep working from the checkout:  git pull && npm install && npm run build:package`,
      };
    case "not-writable":
      return {
        kind: "not-writable",
        message:
          `This Pi Central lives somewhere this app cannot write, so it cannot replace it.\n\n${owner.reason}\n\n` +
          `Update it from a terminal, with the permissions that directory needs.`,
      };
    case "npm-global":
      return { kind: "npm-global", message: owner.reason };
    case "unknown-manager":
    case "undetermined":
      return {
        kind: owner.kind,
        message:
          `This app could not establish how Pi Central was installed, so it will not replace it.\n\n${owner.reason}\n\n` +
          `Update it from a terminal:  npm install -g pi-central@latest`,
      };
  }
}

/**
 * The `npm` this app must use: the one beside the node it launches.
 *
 * ## Why not the PATH's npm
 *
 * Measured: `/opt/homebrew/bin/npm` is a symlink to `../Cellar/node/26.13.0_2/bin/npm`, and the app resolves `node` to
 * that same Cellar directory. With a version manager in play the two can differ — a login shell may find
 * `~/.nvm/versions/node/v22/bin/npm` while the app launches `/opt/homebrew/bin/node` — and then "install the update"
 * writes into a prefix belonging to a Node the app is not running. The installed version would be verified against the
 * wrong tree, and the update would report a mismatch on a completely healthy install.
 *
 * So `npm` is derived from the resolved `node`'s directory, with npm-cli.js as the fallback that makes it work under nvm
 * (where `npm` is a shell script rather than a sibling binary).
 */
export function npmBesideNode(nodePath: string | undefined): { path: string } | undefined {
  if (nodePath === undefined || nodePath === "") return undefined;
  const bin = dirname(nodePath);
  // `<prefix>/bin/node` → `<prefix>/bin/npm`, and `<prefix>/lib/node_modules/npm/bin/npm-cli.js`.
  const sibling = join(bin, "npm");
  const npmCli = join(dirname(bin), "lib", "node_modules", "npm", "bin", "npm-cli.js");
  return { path: sibling === "" ? npmCli : sibling };
}

/**
 * Whether `path` is at or under `parent`, by SEGMENT.
 *
 * `/opt/homebrew-other` must not satisfy a boundary of `/opt/homebrew` — the same comparison `places.ts` and
 * `static-ui.ts` make for the same reason.
 */
export function isInside(parent: string, path: string): boolean {
  const normalisedParent = resolve(parent);
  const normalisedPath = resolve(path);
  if (normalisedPath === normalisedParent) return true;
  return normalisedPath.startsWith(normalisedParent.endsWith(sep) ? normalisedParent : normalisedParent + sep);
}

/**
 * Read the facts `decideOwner` needs, from the filesystem.
 *
 * Separated from the decision so every case of `decideOwner` is testable with a plain object, and this — the part that
 * can fail in ways nobody predicted — is small enough to read. Every probe here swallows its own failure into
 * `undefined`, because "I could not tell" must reach the decision as its own answer rather than as a `false`.
 *
 * `PATH` is used only for the `brew` lookup, which is a *secondary* signal: the Cellar-path check does not need it, so a
 * GUI launch with no `brew` on `PATH` still recognises a Homebrew install.
 */
export function readOwnerEvidence(input: {
  packageRoot: string;
  nodePath: string | undefined;
  npmPrefix: string | undefined;
  env: NodeJS.ProcessEnv;
  /** Injected so the filesystem questions are assertable; defaults to the real `node:fs`. */
  lstat?: (path: string) => { isSymbolicLink(): boolean };
  readlink?: (path: string) => string;
  isWritable?: (path: string) => boolean | undefined;
  findBrewFormula?: (root: string) => string | undefined;
}): OwnerEvidence {
  const lstat = input.lstat ?? ((path: string) => lstatSync(path));
  const readlink = input.readlink ?? ((path: string) => readlinkSync(path));
  const isWritable = input.isWritable ?? (() => undefined);
  const findBrewFormula = input.findBrewFormula ?? (() => undefined);

  let packageRootIsSymlink = false;
  let packageRootLinkTarget: string | undefined;
  try {
    const stats = lstat(input.packageRoot);
    packageRootIsSymlink = stats.isSymbolicLink();
    if (packageRootIsSymlink) packageRootLinkTarget = readlink(input.packageRoot);
  } catch {
    // Not readable: leave both as "not a symlink", so the decision reports an unwritable or undetermined owner rather
    // than inventing one.
  }

  // `npm`'s install target for a global package: `<prefix>/lib/node_modules` on Unix.
  const installTarget =
    input.npmPrefix === undefined ? undefined : join(input.npmPrefix, "lib", "node_modules");
  const installTargetWritable = installTarget === undefined ? undefined : isWritable(installTarget);

  return {
    packageRoot: input.packageRoot,
    npmPath: npmBesideNode(input.nodePath)?.path,
    npmPrefix: input.npmPrefix,
    packageRootIsSymlink,
    packageRootLinkTarget,
    installTargetWritable,
    brewFormula: findBrewFormula(input.packageRoot),
    looksLikeCellar: CELLAR_SEGMENTS.some((segment) => hasSegment(input.packageRoot, segment)) || looksLikeKeg(input.packageRoot),
  };
}

/** Every directory a `brew` on `PATH` could be in, for the lookup that is allowed to fail. */
export function brewLookupDirectories(env: NodeJS.ProcessEnv): string[] {
  return (env["PATH"] ?? "").split(delimiter).filter((entry) => entry !== "");
}

/** A `brew` path if one is on `PATH`, for the injected lookup. Deliberately not `spawnSync`: `brew` is slow. */
export function findBrew(env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string | undefined {
  for (const directory of brewLookupDirectories(env)) {
    const candidate = join(directory, "brew");
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/** Re-exported so a caller does not need `node:fs` to describe a writability failure. */
export function describeWritability(error: unknown): string {
  return (error as Error).message;
}

/** Whether `statSync` says this is a directory (used by `main.ts`'s evidence reader). */
export function isDirectory(path: string): boolean | undefined {
  try {
    return statSync(path).isDirectory();
  } catch {
    return undefined;
  }
}
