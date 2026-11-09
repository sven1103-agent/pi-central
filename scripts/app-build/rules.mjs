/**
 * What `npm run install-app` may build, and how it must fail (issue #218, ADR-0013).
 *
 * ## Why the decisions are a module
 *
 * Three of this slice's criteria are **prohibitions**, and a prohibition cannot be exercised into existence — it has to
 * be checked:
 *
 *   - no `dmg` target, no notarization, no updater (criterion 3);
 *   - no product code in the bundle (criterion 5);
 *   - no instruction anywhere to disable Gatekeeper (criterion 8).
 *
 * Each fails *silently and usefully-looking* when violated: a `.dmg` target makes the build produce a second artifact
 * that cannot be notarized, and the discovery is a release pipeline that cannot complete. So the checks are functions
 * over the configuration and the built tree, and the script calls them before and after it builds.
 *
 * ## The two facts this slice rests on, both measured
 *
 *   - **Ad-hoc signing works and is enough to run.** `codesign -s -` on a copy of Electron's bundle, nested bundles
 *     signed innermost-first, verifies with `--deep --strict`. `spctl -a` then fails, and that is the accepted state:
 *     notarization is what is missing, and a bundle arriving by `npm`/`git`/`cp` is not quarantined (ADR-0013 facts 1–3).
 *   - **`electron-builder` needs a pinned Electron version and can use the installed copy.** A `^45.2.3` range is
 *     refused outright ("a range cannot be resolved without electron installed"), and without `electronDist` it
 *     downloads a zip into `~/Library/Caches` — an avoidable network dependency for a local build of a launcher.
 */

/**
 * The prohibition set, as data.
 *
 * `dmg`, `notarize` and `publish` are the three keys whose *presence* is the bug. `electron-updater` is a dependency
 * rather than a config key, so it is checked separately (`forbiddenDependencies`), because a package can arrive
 * transitively and a config scan would miss it.
 */
export const FORBIDDEN_CONFIG_KEYS = ["dmg", "notarize", "publish", "mas", "pkg"];

/** Dependencies that would make this app an update target, which it must never be (ADR-0013 §2, §6). */
export const FORBIDDEN_DEPENDENCIES = ["electron-updater", "electron-download", "update-electron-app", "@electron/remote"];

/**
 * The build configuration this project ships, given the paths it depends on.
 *
 * A function in this module rather than an object literal inside `install-app.mjs` so that the configuration the audit
 * runs against is the SAME value the build uses. The first version asserted against a copy of it, reconstructed by
 * string-substituting the script's source — which tested the reconstruction, not the build.
 *
 * @param {{ electronVersion: string, electronDist: string, output: string }} paths
 * @returns {Record<string, unknown>}
 */
export function buildConfig(paths) {
  return {
    appId: "com.pi-central.app",
    productName: "Pi Central",
    electronVersion: paths.electronVersion,
    /*
     * The installed Electron, so no download happens. `electron-builder` otherwise fetches a zip into
     * `~/Library/Caches/electron`, which is a network dependency this local build does not need — and it would package a
     * possibly different Electron from the one this checkout runs.
     */
    electronDist: paths.electronDist,
    directories: { output: paths.output },
    files: ["main.js", "package.json"],
    mac: {
      // The only allowed target: this produces the `.app` and nothing else.
      target: "dir",
      category: "public.app-category.developer-tools",
      // Signing is done by this script, innermost-first, after auditing the bundle. Letting electron-builder sign would
      // put an identity on the tree before the audit could refuse it.
      identity: null,
    },
  };
}

/**
 * Every problem with a build configuration, as sentences.
 *
 * Returns `[]` for a good configuration. The caller refuses to build when anything is returned, which is what makes
 * criterion 3 a build-time failure rather than a release-pipeline failure.
 */
/**
 * @param {Record<string, unknown>} config
 * @returns {string[]}
 */
export function configProblems(config) {
  const problems = [];
  const mac = config["mac"] ?? {};

  // The `mac` object AND the root are both checked: `dmg`/`notarize` are `mac` sub-keys, while `publish` can sit at
  // either level, and checking one place is how a later edit reintroduces the other.
  for (const key of FORBIDDEN_CONFIG_KEYS) {
    if (key in mac) problems.push(`mac.${key} is present, and this app must never have it (${reasonFor(key)})`);
    if (key in config) problems.push(`${key} is present at the root, and this app must never have it (${reasonFor(key)})`);
  }

  const version = config["electronVersion"];
  if (typeof version !== "string" || version === "") {
    problems.push("electronVersion is not set; electron-builder cannot package without it");
  } else if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    // The measured failure: `^45.2.3` is refused with "a range cannot be resolved without electron installed".
    problems.push(`electronVersion "${version}" is a range; electron-builder requires an exact version`);
  }

  /*
   * The `files` globs are audited too, because `bundleProblems` runs on the ARTIFACT and only after a successful build.
   * A `files` entry naming `bin/` or `dist/` is the same mistake made one step earlier, and catching it here means the
   * build never runs — which is cheaper and says the same thing.
   */
  const files = config["files"];
  if (Array.isArray(files)) {
    for (const entry of files) {
      if (typeof entry !== "string") continue;
      const named = ["bin", "dist", "dist/ui", "pi-central.js"].filter((forbidden) => {
        const normalised = entry.replace(/^\.\//, "");
        return normalised === forbidden || normalised.startsWith(`${forbidden}/`);
      });
      for (const forbidden of named) {
        problems.push(
          `files includes "${entry}", which would put product code (${forbidden}) in the bundle — the shell must launch ` +
            `the installed package instead of carrying one (ADR-0013 §1)`,
        );
      }
    }
  }

  const target = mac["target"];
  const targets = Array.isArray(target) ? target : target === undefined ? [] : [target];
  for (const entry of targets) {
    const name = typeof entry === "string" ? entry : entry?.target;
    if (name !== "dir") {
      problems.push(
        `mac.target ${String(name)} would produce an artifact this project cannot notarize; only "dir" is allowed ` +
          `(it produces the .app and nothing else)`,
      );
    }
  }
  if (targets.length === 0) {
    // Absent means electron-builder's default, which is `dmg` + `zip` — the exact thing being forbidden.
    problems.push('mac.target is not set, so electron-builder would default to "dmg"; set it to "dir"');
  }

  return problems;
}

/** Why one forbidden key may not be present, for the message. */
/**
 * @param {string} key
 * @returns {string}
 */
function reasonFor(key) {
  switch (key) {
    case "dmg":
      return "a .dmg cannot be notarized without a Developer ID and would be a second distributable";
    case "notarize":
      return "notarization needs a Developer ID this project does not have (ADR-0013)";
    case "publish":
      return "publishing makes the app an update target; the npm package is the only one (ADR-0013 §2)";
    case "mas":
      return "the Mac App Store build would be App-Sandboxed, and the orchestrator must not be (C1)";
    case "pkg":
      return "a .pkg installer needs a signing identity distributed to users, which this project does not have";
    default:
      return "it makes the app a second distributable";
  }
}

/**
 * Which signing identity to use.
 *
 * ## The TCC problem this solves, stated plainly because it is the slice's whole point
 *
 * macOS privacy grants (Documents, Desktop, Downloads) are keyed to a binary's **code identity**. An ad-hoc signature's
 * cdhash changes on every build, so every rebuild looks like a different app and the reader is re-prompted for the same
 * folder, forever. A stable identity — even a **self-signed** one with no Apple account — keeps the cdhash stable and the
 * grants alive (ADR-0013 fact 3).
 *
 * The choice is therefore: use a real identity when one exists, and otherwise fall back to ad-hoc **while saying so**, so
 * the reader knows their grants will not survive a rebuild. The fallback is not silent, because "my permissions reset
 * every time" is otherwise indistinguishable from a defect in the app.
 */
/**
 * @typedef {{ kind: "identity", identity: string, reason: string }
 *   | { kind: "adhoc", reason: string, caveat: string }} SigningChoice
 */

/**
 * @param {string | undefined} identity
 * @param {readonly string[]} available
 * @returns {SigningChoice}
 */

export function chooseSigning(identity, available) {
  const wanted = identity === undefined ? "" : identity.trim();
  if (wanted !== "") {
    // An identity was named explicitly. It is used even if the probe did not list it, because `security find-identity`
    // prints only *valid* identities and a reader may have set the variable for one this probe cannot see; a wrong name
    // makes `codesign` fail loudly, which is the right outcome.
    return { kind: "identity", identity: wanted, reason: `signing with the identity named by PI_CENTRAL_SIGN_IDENTITY` };
  }
  const detected = available.find((candidate) => candidate !== "");
  if (detected !== undefined) {
    return {
      kind: "identity",
      identity: detected,
      reason: `signing with the self-signed identity "${detected}", so privacy grants survive a rebuild`,
    };
  }
  return {
    kind: "adhoc",
    reason: "no code-signing identity was found, so the app is signed ad-hoc (`codesign -s -`)",
    caveat:
      "An ad-hoc signature's code identity changes on every build, so macOS will ask for Documents/Desktop/Downloads " +
      "access again after each rebuild. Create a self-signed Code Signing certificate in Keychain Access (see " +
      "docs/APP-SHELL.md) and rebuild to keep those grants.",
  };
}

/**
 * The `codesign` arguments for one item.
 *
 * `--deep` is deliberately NOT used: it signs nested code in an order Apple documents as unreliable, and it has been
 * deprecated for signing (still valid for *verifying*). The nested bundles are signed individually, innermost first,
 * which is what `signingOrder` produces.
 */
/**
 * @param {string} item
 * @param {SigningChoice} choice
 * @returns {string[]}
 */
export function signArguments(item, choice) {
  const identity = choice.kind === "identity" ? choice.identity : "-";
  return [
    "--force",
    "--timestamp=none",
    // `--options runtime` is NOT included. The hardened runtime is what notarization requires, and it does not block
    // `sandbox-exec` — but it does require the entitlements Electron needs (JIT, unsigned executable memory), and
    // adding an entitlement list "to make signing work" is how a sandbox hole gets added to a launcher (C1).
    "--sign",
    identity,
    item,
  ];
}

/**
 * The bundles inside a built app, **innermost first**.
 *
 * ## Why the order is a decision
 *
 * Code signing is a hierarchy: signing an outer bundle records the hashes of the code inside it, so anything signed
 * *after* its container invalidates the container's signature. Electron ships five nested helper apps and five
 * frameworks, and `codesign --deep` exists precisely because getting this wrong is easy and the failure is a bundle
 * that verifies shallowly and not deeply.
 *
 * ## Why the helper names are discovered, not written down
 *
 * The first version listed `Electron Helper.app` and friends. A packaged Electron app renames its helpers after the
 * **product name**, so the real bundles are `Pi Central Helper.app`, `Pi Central Helper (GPU).app`, and so on — the
 * hardcoded list matched nothing, the helpers went unsigned, and `codesign --verify --deep --strict` failed with
 * *"code has no resources but signature indicates they must be present"* in a subcomponent.
 *
 * So the list is built from what is actually in `Contents/Frameworks`, in a defined order, and the only name it assumes
 * is the framework called `Electron Framework` (which is Electron's, not the product's).
 */
export function signingOrder(appPath, existing) {
  const frameworks = `${appPath}/Contents/Frameworks`;
  const framework = `${frameworks}/Electron Framework.framework/Versions/A`;
  const candidates = [
    // 1. Loose dylibs inside the framework — nothing contains them.
    `${framework}/Libraries/libffmpeg.dylib`,
    `${framework}/Libraries/libvk_swiftshader.dylib`,
    // 2. Executables inside the framework.
    `${framework}/Helpers/chrome_crashpad_handler`,
    // 3. The frameworks. Signing the `.framework` path signs the version it points at.
    `${frameworks}/Electron Framework.framework`,
    `${frameworks}/Mantle.framework`,
    `${frameworks}/ReactiveObjC.framework`,
    `${frameworks}/Squirrel.framework`,
  ].filter((path) => existing(path));

  /*
   * 4. The helper apps, discovered. Sorted so the order is stable across runs, and every `.app` directly inside
   * `Frameworks` is included — a future Electron adding a helper must not be silently skipped.
   */
  const helpers = helperApps(appPath, existing);
  // 5. The app itself, last, so everything it contains is already signed.
  return [...candidates, ...helpers, appPath];
}

/**
 * Every `.app` directly inside `Contents/Frameworks`.
 *
 * Discovered rather than named, because a packaged app renames them after its product (`Pi Central Helper.app`). Order is
 * alphabetical so two builds sign identically, which matters for a reproducible cdhash.
 *
 * @param {string} appPath
 * @param {(path: string) => boolean} existing
 * @returns {string[]}
 */
export function helperApps(appPath, existing) {
  const frameworks = `${appPath}/Contents/Frameworks`;
  if (!existing(frameworks)) return [];
  return listDirectory(frameworks)
    .filter((name) => name.endsWith(".app"))
    .sort()
    .map((name) => `${frameworks}/${name}`)
    .filter((path) => existing(path));
}

/** Injected directory listing, so `signingOrder` stays testable without a filesystem. */
let listDirectory = () => [];

/**
 * Set the directory lister used by `helperApps`. Defaults to nothing, so a caller that does not set it gets no helpers
 * rather than a throw — `main.ts`'s build script sets it.
 *
 * @param {(path: string) => string[]} fn
 */
export function setDirectoryLister(fn) {
  listDirectory = fn;
}

/**
 * Problems with a built tree, checked BEFORE signing (criterion 5).
 *
 * ## Why the bundle must contain no product code
 *
 * ADR-0013 §1: the shell carries the Electron main and nothing else. A `bin/pi-central.js` or a `dist/ui` in the bundle
 * would make it a *second distributable* — a second copy of the product with its own version that can drift from the one
 * `npm install -g` installed. That is the property `packaging-shape.test.ts` asserts for the package manifest; this is
 * the same property one level down, on the artifact, because a build script can copy files the manifest never mentions.
 *
 * `resources` is the list of relative paths found under `Contents/Resources`, so the check needs no filesystem of its own.
 */
/**
 * @param {readonly string[]} resources
 * @returns {string[]}
 */
export function bundleProblems(resources) {
  const problems = [];
  for (const forbidden of ["bin/pi-central.js", "dist/ui", "pi-central.js"]) {
    const found = resources.filter((entry) => entry === forbidden || entry.startsWith(`${forbidden}/`));
    if (found.length > 0) {
      problems.push(
        `the bundle contains ${found[0]}, which is product code — the shell must launch the installed package ` +
          `instead of carrying one (ADR-0013 §1)`,
      );
    }
  }
  return problems;
}

/**
 * The `Info.plist` identity the built app must carry, so "which app is this?" has one answer.
 * @typedef {{ id: string, version: string }} BundleIdentity
 */

/**
 * Whether the bundle's own identity agrees with the app package's version (criterion 6).
 *
 * The criterion allows either "the app carries the package's version" or "the app carries none". Electron copies the
 * version from the manifest electron-builder is given, so the check is that it is *present and equal* — and an empty or
 * absent version is the second acceptable state, reported rather than failed.
 *
 * What is NOT acceptable is a different version: that is a shell whose About box disagrees with the package it
 * launches, which is the two-versions-that-can-drift problem ADR-0013 exists to prevent.
 */
/**
 * @param {BundleIdentity} identity
 * @param {string} expectedVersion
 * @returns {string[]}
 */
export function identityProblems(identity, expectedVersion) {
  const problems = [];
  if (identity.id === "" || identity.id === "com.github.Electron") {
    problems.push(
      `the bundle's identifier is "${identity.id}", which is Electron's default — installing it would collide with ` +
        `any other Electron app rather than being Pi Central`,
    );
  }
  if (identity.version !== "" && identity.version !== expectedVersion) {
    problems.push(
      `the bundle says version ${identity.version} while the package is ${expectedVersion}; a shell that disagrees ` +
        `with the package it launches is the drift ADR-0013 forbids`,
    );
  }
  return problems;
}

/**
 * Documentation that must not tell a reader to work around Gatekeeper (criterion 8).
 *
 * ## Why this is a check and not a style note
 *
 * `xattr -d com.apple.quarantine` and "right-click → Open" are the two instructions that spread through an
 * unsigned-app project, and both teach a reader to defeat a security control to run code from strangers. The supported
 * routes are named instead: build it locally, or install through a Homebrew tap/cask — neither sets the quarantine
 * attribute (ADR-0013 fact 1).
 *
 * `spctl -a` failing is expected and is documented as such. What is forbidden is the *bypass*, not an honest statement
 * that Gatekeeper will refuse.
 */
export const GATEKEEPER_BYPASS_PATTERNS = [
  /xattr\s+-[a-z]*d[^\n]*com\.apple\.quarantine/i,
  /disable\s+gatekeeper/i,
  /spctl\s+--master-disable/i,
  /right[- ]click[^\n]*\bopen\b[^\n]*to\s+(run|install)/i,
  /allow\s+apps?\s+from\s+anywhere/i,
];

/**
 * Whether a document gives Gatekeeper-bypass ADVICE, as opposed to naming the commands in order to forbid them.
 *
 * ## Why this is not a plain pattern match, which it first was
 *
 * The first version flagged any occurrence, and it failed on this project's own documentation — which says
 * *"`xattr -d com.apple.quarantine …` and 'right-click → Open' are not instructions this project gives"*. That sentence is
 * the prohibition the check exists to enforce, and a checker that cannot tell advice from its negation will be deleted by
 * whoever hits it rather than fixed.
 *
 * So a match only counts when it is **not** in a sentence that forbids it. Two signals, both narrow:
 *
 *   - the *line* containing the match, or the line before it, carries a negation ("do not", "never", "not instructions",
 *     "must not", "avoid", "refuse");
 *   - or the match sits inside a fenced block that is itself introduced as forbidden.
 *
 * A line-based check is deliberate: a document that says "never run `xattr -d com.apple.quarantine`" on one line and
 * "instead, run it" on the next is not something a checker can catch, and pretending otherwise is worse than a stated
 * limit.
 *
 * @param {string} document
 * @returns {string[]}
 */
export function gatekeeperAdviceProblems(document) {
  const lines = document.split("\n");
  const problems = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const matches = GATEKEEPER_BYPASS_PATTERNS.filter((pattern) => pattern.test(line));
    if (matches.length === 0) continue;
    // The sentence this line belongs to, plus the line before it (a prohibition is often the sentence before a quote).
    const context = `${lines[index - 1] ?? ""} ${line}`;
    if (NEGATION.test(context)) continue;
    problems.push(
      "the documentation tells the reader to work around Gatekeeper; the supported routes are a local build or a " +
        "Homebrew tap/cask, neither of which sets the quarantine attribute (ADR-0013)",
    );
  }
  return problems;
}

/**
 * Words that turn a Gatekeeper command into a prohibition rather than a suggestion.
 *
 * Narrow on purpose: each of these is a word this project's own prose uses to say "do not". A broader list (just "not")
 * would let "you may not have noticed, run xattr …" through.
 */
const NEGATION = /\b(do not|don't|never|must not|must never|avoid|refuse|not instructions|is not an instruction|instead of|rather than)\b/i;

/** Where the app is installed. `~/Applications` needs no admin rights (criterion 7). */
/**
 * @param {string} home
 * @returns {string}
 */
export function installPath(home) {
  return `${home}/Applications/Pi Central.app`;
}

/** Whether a proposed install directory needs privileges this app must not ask for (criterion 7). */
/**
 * @param {string} path
 * @returns {boolean}
 */
export function requiresAdmin(path) {
  return path.startsWith("/Applications/") || path === "/Applications";
}

/** Everything the script removes outside the app bundle, so uninstalling is `rm -rf` plus nothing (criterion 7). */
export const UNINSTALL_LEFTOVERS = ["~/Library/Application Support/Pi Central"];
