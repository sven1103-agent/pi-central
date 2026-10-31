/**
 * Finding the owning package, and locating the built UI in both layouts (issue #52).
 *
 * These two functions decide whether the *published* artifact works, and both were wrong in a way
 * that the workspace could not reveal:
 *
 *   - `resolveUiDistDir` derived the UI path from THIS MODULE's URL. Correct in a checkout
 *     (`packages/orchestrator/src/` → `packages/ui/dist`) and wrong once bundled into `bin/`, where
 *     the same relative expression resolves to `<parent-of-package>/ui/dist` — outside the installed
 *     package, and therefore a path that can match a directory belonging to the consumer.
 *   - `--version` needs the version of the package it was shipped in. "Take the nearest
 *     `package.json`" gives `@pi-central/orchestrator`'s when run from source: a *different package*,
 *     whose version merely happens to agree today.
 *
 * So the tests build both layouts on disk rather than mocking a path join. A mocked join would pass
 * while the real one walked to the wrong file, which is exactly the failure being guarded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { VERIFY_INSTALL_HINT, findOwnPackage, PACKAGE_NAME } from "../src/package-meta.ts";
import { resolveUiDistDir } from "../src/static-ui.ts";

/** A directory that is removed at the end of the test that made it. */
function tempTree(prefix: string): { root: string; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

function writePackageJson(directory: string, name: string, version: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name, version }));
}

/** Mark a directory as containing a built UI. */
function writeBuiltUi(directory: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "index.html"), "<!doctype html><title>stub</title>");
}

test("findOwnPackage skips a nearer package.json that is a DIFFERENT package", () => {
  // The failure this prevents: run from source, the nearest package.json is
  // `packages/orchestrator/package.json`. Accepting it would report the orchestrator's version as
  // the app's — and both are 0.1.0 today, so the bug would be invisible until they diverged.
  const tree = tempTree("pi-central-pkgmeta-");
  try {
    const orchestrator = join(tree.root, "packages", "orchestrator");
    writePackageJson(orchestrator, "@pi-central/orchestrator", "0.1.0");
    writePackageJson(tree.root, PACKAGE_NAME, "9.9.9");

    const found = findOwnPackage(pathToFileURL(join(orchestrator, "src", "server.ts")).href);
    assert.ok(found, "the root package must be found through the inner one");
    assert.equal(found.version, "9.9.9", "must not stop at the inner package's version");
    assert.equal(found.root, tree.root);
  } finally {
    tree.done();
  }
});

test("findOwnPackage finds the package one level up in the PACKAGED layout", () => {
  const tree = tempTree("pi-central-pkgmeta-");
  try {
    writePackageJson(join(tree.root, "node_modules", "pi-central"), PACKAGE_NAME, "1.2.3");
    const from = join(tree.root, "node_modules", "pi-central", "bin", "pi-central.js");
    mkdirSync(join(tree.root, "node_modules", "pi-central", "bin"), { recursive: true });
    writeFileSync(from, "");

    const found = findOwnPackage(pathToFileURL(from).href);
    assert.equal(found?.version, "1.2.3");
    assert.equal(found?.root, join(tree.root, "node_modules", "pi-central"));
  } finally {
    tree.done();
  }
});

test("findOwnPackage returns undefined rather than throwing when there is no package", () => {
  // The callers have different right answers for "not found" — `--version` says it cannot tell and
  // the UI resolution falls back — so a throw here would turn a missing file into a crash.
  const tree = tempTree("pi-central-pkgmeta-");
  try {
    assert.equal(findOwnPackage(pathToFileURL(join(tree.root, "bin", "x.js")).href), undefined);
  } finally {
    tree.done();
  }
});

test("resolveUiDistDir finds dist/ui from the PACKAGED layout", () => {
  const tree = tempTree("pi-central-uidist-");
  try {
    const pkgRoot = join(tree.root, "node_modules", "pi-central");
    writePackageJson(pkgRoot, PACKAGE_NAME, "1.0.0");
    writeBuiltUi(join(pkgRoot, "dist", "ui"));
    mkdirSync(join(pkgRoot, "bin"), { recursive: true });
    const from = join(pkgRoot, "bin", "pi-central.js");

    assert.equal(resolveUiDistDir({}, pathToFileURL(from).href), join(pkgRoot, "dist", "ui"));
  } finally {
    tree.done();
  }
});

test("resolveUiDistDir finds packages/ui/dist from the WORKSPACE layout", () => {
  const tree = tempTree("pi-central-uidist-");
  try {
    writePackageJson(tree.root, PACKAGE_NAME, "1.0.0");
    writeBuiltUi(join(tree.root, "packages", "ui", "dist"));
    const from = join(tree.root, "packages", "orchestrator", "src", "static-ui.ts");
    mkdirSync(join(tree.root, "packages", "orchestrator", "src"), { recursive: true });

    assert.equal(
      resolveUiDistDir({}, pathToFileURL(from).href),
      join(tree.root, "packages", "ui", "dist"),
    );
  } finally {
    tree.done();
  }
});

test("a stray UI directory OUTSIDE the package is never chosen", () => {
  // The specific hazard the old single candidate created: from `bin/`, `../../ui/dist` is the
  // consumer's directory, not ours. Both candidates are now anchored to the package root, so a
  // built UI sitting beside the package must not be picked up as if it were ours.
  const tree = tempTree("pi-central-uidist-");
  try {
    const pkgRoot = join(tree.root, "node_modules", "pi-central");
    writePackageJson(pkgRoot, PACKAGE_NAME, "1.0.0");
    mkdirSync(join(pkgRoot, "bin"), { recursive: true });
    const from = join(pkgRoot, "bin", "pi-central.js");
    // `<root>/ui/dist` is what `../../ui/dist` resolves to from `bin/`. It must be ignored.
    writeBuiltUi(join(tree.root, "ui", "dist"));

    const resolved = resolveUiDistDir({}, pathToFileURL(from).href);
    assert.notEqual(resolved, join(tree.root, "ui", "dist"), "must not adopt the consumer's tree");
    assert.equal(resolved, join(pkgRoot, "dist", "ui"));
  } finally {
    tree.done();
  }
});

test("when BOTH layouts exist, the one this module was loaded from wins", () => {
  // Both directories really can exist at once: run `npm run build:package` in a checkout and you have
  // `dist/ui` (the packaged copy) alongside `packages/ui/dist` (fresh `vite build` output). A fixed
  // preference would serve the wrong one, and the symptom is the worst kind — a developer edits a
  // component, rebuilds, and sees no change because a stale copy has been served all along. So the
  // preference is decided by where this module was loaded from.
  const tree = tempTree("pi-central-uidist-");
  try {
    writePackageJson(tree.root, PACKAGE_NAME, "1.0.0");
    writeBuiltUi(join(tree.root, "dist", "ui"));
    writeBuiltUi(join(tree.root, "packages", "ui", "dist"));

    const fromSource = join(tree.root, "packages", "orchestrator", "src", "static-ui.ts");
    mkdirSync(join(tree.root, "packages", "orchestrator", "src"), { recursive: true });
    assert.equal(
      resolveUiDistDir({}, pathToFileURL(fromSource).href),
      join(tree.root, "packages", "ui", "dist"),
      "from source, the fresh workspace build must win — not a stale packaged copy",
    );

    const fromBundle = join(tree.root, "bin", "pi-central.js");
    mkdirSync(join(tree.root, "bin"), { recursive: true });
    assert.equal(
      resolveUiDistDir({}, pathToFileURL(fromBundle).href),
      join(tree.root, "dist", "ui"),
      "from the bundle, the packaged UI must win",
    );
  } finally {
    tree.done();
  }
});

// --- The manifest's own claims (issue #52) -------------------------------------------------------
//
// These assert the SHAPE of the published package from `package.json`. A drift guard rather than a
// packaging test: `npm pack` is the real check (and issue #53 will run it in CI), but these catch the
// changes that would silently widen what ships, at the cost of reading one JSON file.

test("the published package ships only generated JS and the built UI", () => {
  const own = findOwnPackage(import.meta.url);
  assert.ok(own, "this test must be able to find the root package");
  const manifest = JSON.parse(readFileSync(own.path, "utf8")) as {
    files?: string[];
    bin?: Record<string, string>;
    engines?: { node?: string };
    dependencies?: Record<string, string>;
  };

  // `files` is an allow-list, and it must not name a source directory. `dist` and `bin` are generated
  // (both gitignored); README and LICENSE are what a consumer expects to find.
  assert.deepEqual(
    [...(manifest.files ?? [])].sort(),
    ["LICENSE", "README.md", "bin", "dist"],
    "`files` must ship generated output and the licence, and nothing else",
  );
  for (const entry of manifest.files ?? []) {
    assert.ok(!entry.startsWith("packages"), `a source directory must never ship: ${entry}`);
  }

  // The binary must be the generated bundle. Pointing it at a `.ts` file would be unrunnable from
  // `node_modules` — the whole reason this slice exists.
  assert.deepEqual(manifest.bin, { "pi-central": "bin/pi-central.js" });

  // A version cannot be interpreted without knowing which Node it needs, and the floor is not
  // decorative: it is the version type stripping was unflagged in, which is what the sources rely on
  // when run from a checkout.
  assert.ok(manifest.engines?.node, "`engines.node` must be declared");
});

test("the runtime dependency surface is exactly `ws`, as ADR-0011 states", () => {
  // ADR-0011 claims a single runtime dependency. A claim like that decays silently: someone adds a
  // dependency for one call site, and the component that runs UNSANDBOXED grows a supply chain with
  // nobody deciding to. Pinned here so adding one is a deliberate act with a failing test attached.
  const own = findOwnPackage(import.meta.url);
  assert.ok(own);
  const manifest = JSON.parse(readFileSync(own.path, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.deepEqual(
    Object.keys(manifest.dependencies ?? {}).sort(),
    ["ws"],
    "a new runtime dependency needs ADR-0011 updated, not just this test",
  );
});

test("PI_CENTRAL_UI_DIST still overrides everything", () => {
  // The escape hatch has to keep working: it is what a test, an unusual install, or a packaged app
  // with the UI elsewhere relies on. Checked explicitly because the fallback logic now has more
  // branches that could shadow it.
  const explicit = join(tmpdir(), "somewhere-else");
  assert.equal(resolveUiDistDir({ PI_CENTRAL_UI_DIST: explicit }), resolve(explicit));
});

// --- The package must stay inert on install (the install-path verification depends on it) ---------

test("the published package declares NO install scripts", () => {
  // This is load-bearing for the verification recipe in the README:
  //
  //   npm install --global pi-central   # inert: no install scripts run
  //   npm audit signatures              # verify BEFORE the first run
  //   pi-central
  //
  // That ordering is only sound because `npm install` executes no package code. Add a `postinstall` and
  // the recipe becomes theatre: the package would run before anyone had a chance to check what it is.
  // A `postinstall` would also be the first install script this package has ever had, and it is skipped
  // entirely under `--ignore-scripts`, which many CI and enterprise setups use — so it would offer even
  // less than it appears to.
  // The ROOT manifest, not the workspace one: `scripts/build-package.mjs` publishes the root
  // `package.json` verbatim (it only reads it, never regenerates it), so the root file is what a user
  // actually installs. A first version of this test read `../package.json` — the orchestrator workspace —
  // and passed with a `postinstall` added to the real one, which is exactly the kind of guard that looks
  // present and checks nothing.
  const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const installScripts = ["preinstall", "install", "postinstall", "prepare", "prepublish"].filter(
    (name) => manifest.scripts?.[name] !== undefined,
  );
  assert.deepEqual(
    installScripts,
    [],
    `the package must run no code at install time, found: ${installScripts.join(", ")}`,
  );
});

test("the verify hint names the command the README gives", () => {
  // A banner naming a command nobody runs is the "claim nobody checks" failure in miniature. One constant,
  // used by the banner and asserted against the README, so the two cannot drift silently.
  assert.equal(VERIFY_INSTALL_HINT, "npm audit signatures");
  const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
  assert.ok(readme.includes(VERIFY_INSTALL_HINT), "the README's install section must give the same command");
});
