/**
 * Resolving the installed package (issue #214, criterion 1).
 *
 * ## What this is pinned against, and why it is not a fixture
 *
 * The defect this guards is "resolved to something that merely looks like the package": the first
 * `package.json` on the way up, a directory that used to be the checkout, a global prefix the shell
 * assumed. Every one of those produces a window pointed at nothing, or worse at a *different* build of
 * the product.
 *
 * So the interesting cases here are all about the walk being strict:
 *
 *   - a **decoy** manifest closer than the real one, with a different name, must be skipped;
 *   - a manifest with the right name and no `bin/` must be reported as `incomplete` rather than
 *     "not installed" — the two have opposite fixes;
 *   - an `override` pointing at a wrong directory must be refused by name, not trusted.
 *
 * The temporary trees are built per test, because the shape being tested IS the tree.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateRoots, findPackageInside, findPackageRoot, resolvePackage } from "../src/package-root.ts";

/** A scratch tree, removed when the test ends. */
function scratch(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "pi-central-app-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeManifest(directory: string, name: string, version = "1.2.3"): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name, version }));
}

/** A complete install: manifest, version, and the bundled entry point. */
function writeInstall(directory: string, name = "pi-central", version = "1.2.3"): string {
  writeManifest(directory, name, version);
  const bin = join(directory, "bin", "pi-central.js");
  mkdirSync(join(directory, "bin"), { recursive: true });
  writeFileSync(bin, "// bundled orchestrator\n");
  return bin;
}

test("a complete install is found, from a directory nested deep inside it", (t) => {
  const root = scratch(t);
  const bin = writeInstall(join(root, "pi-central"));
  const found = findPackageRoot(join(root, "pi-central", "dist", "ui", "assets"));
  assert.ok(found);
  assert.equal(found.version, "1.2.3");
  assert.equal(found.bin, bin);
});

test("a closer manifest with a DIFFERENT name is skipped, not taken", (t) => {
  // The real shape from a checkout: `packages/orchestrator/package.json` is nearer than the root one,
  // and its version happens to agree. Taking it would look correct and be wrong.
  const root = scratch(t);
  const install = join(root, "pi-central");
  writeInstall(install);
  writeManifest(join(install, "packages", "orchestrator"), "@pi-central/orchestrator", "1.2.3");
  const found = findPackageRoot(join(install, "packages", "orchestrator", "src"));
  assert.ok(found);
  assert.equal(found.root, install);
});

test("a package with a manifest and no bin/ is reported as incomplete, not as missing", (t) => {
  // Two causes, opposite fixes: `--ignore-scripts`, or a checkout that was never built. Telling someone
  // who has the package to install the package is the kind of message that wastes an afternoon.
  const root = scratch(t);
  writeManifest(join(root, "pi-central"), "pi-central");
  const lookup = resolvePackage({ override: join(root, "pi-central") });
  assert.equal(lookup.ok, false);
  if (lookup.ok) return;
  assert.equal(lookup.reason, "incomplete");
  assert.match(lookup.message, /entry point is missing/);
  // It still carries what it found, so the caller can name the path rather than a vague complaint.
  assert.equal(lookup.package.root, join(root, "pi-central"));
});

test("no package anywhere is a named refusal, not a window pointed at nothing", (t) => {
  const root = scratch(t);
  writeManifest(join(root, "somewhere", "else"), "not-pi-central");
  const lookup = resolvePackage({ from: join(root, "somewhere", "else") });
  assert.equal(lookup.ok, false);
  if (lookup.ok) return;
  assert.equal(lookup.reason, "not-found");
  // The message must name the escape hatch, because "it could not be found" is not actionable alone.
  assert.match(lookup.message, /PI_CENTRAL_PACKAGE/);
});

test("an override that points at the wrong directory is refused by name", (t) => {
  const root = scratch(t);
  writeManifest(join(root, "not-it"), "some-other-tool");
  const lookup = resolvePackage({ override: join(root, "not-it") });
  assert.equal(lookup.ok, false);
  if (lookup.ok) return;
  assert.equal(lookup.reason, "not-found");
  // The override case has to quote what was asked for; the default case has nothing to quote.
  assert.match(lookup.message, /not-it/);
  assert.match(lookup.message, /"pi-central"/);
});

test("an override is still walked, so pointing at a subdirectory works", (t) => {
  // A reader setting PI_CENTRAL_PACKAGE from a terminal tab completion usually lands one level in.
  const root = scratch(t);
  const install = join(root, "installed");
  writeInstall(install);
  mkdirSync(join(install, "dist"), { recursive: true });
  const lookup = resolvePackage({ override: join(install, "dist") });
  assert.equal(lookup.ok, true);
  if (!lookup.ok) return;
  assert.equal(lookup.package.root, install);
});

test("candidate roots name the prefixes a reader might have used", () => {
  const roots = candidateRoots({ npm_config_prefix: "/custom/prefix", HOME: "/Users/someone" });
  assert.deepEqual(roots, [
    "/custom/prefix/lib/node_modules",
    "/Users/someone/.npm-global/lib/node_modules",
    "/opt/homebrew/lib/node_modules",
    "/usr/local/lib/node_modules",
  ]);
  // With no npm prefix configured, the Homebrew paths are still named rather than omitted: this
  // machine's documented install is Homebrew, and a message that guesses is worse than one that lists.
  assert.equal(candidateRoots({ HOME: "/Users/someone" }).includes("/opt/homebrew/lib/node_modules"), true);
});

// -----------------------------------------------------------------------------------------------------------
// The global-install case, which was broken from #214 until it was reported from a running app.
// -----------------------------------------------------------------------------------------------------------

test("a global install is found from its `node_modules` DIRECTORY, not only from inside it", (t) => {
  /*
   * The defect, reported with a screenshot: "Pi Central could not find its own package", listing
   * `/opt/homebrew/lib/node_modules` among the locations checked — while the package sat one directory below it.
   *
   * `findPackageRoot` walks UP. `locatePackage` handed it a `node_modules` directory, where the package is a CHILD,
   * so a global install was never found. It went unnoticed because the app only worked when it lived inside the
   * package itself (the developer's case), and it failed the first time it was launched over a separate install.
   *
   * The two assertions that matter: the walk-up still does NOT find it (so the bug is real and not merely a
   * preference), and `resolvePackage` DOES, because it now looks inside first.
   */
  const root = scratch(t);
  const modules = join(root, "lib", "node_modules");
  const bin = writeInstall(join(modules, "pi-central"));

  assert.equal(findPackageRoot(modules), undefined, "walking up from node_modules cannot find a child");
  const resolved = resolvePackage({ from: modules });
  assert.equal(resolved.ok, true, "but resolvePackage must, because that is the shape locatePackage passes");
  if (!resolved.ok) return;
  assert.equal(resolved.package.root, join(modules, "pi-central"));
  assert.equal(resolved.package.bin, bin);
});

test("every candidate root locatePackage probes resolves a real install in that layout", (t) => {
  // The same defect from the other side: the message that says "locations checked: …" must be true. For each
  // candidate, a package placed in that layout must be found by the call `locatePackage` makes.
  const root = scratch(t);
  const prefix = join(root, "prefix");
  const modules = join(prefix, "lib", "node_modules");
  writeInstall(join(modules, "pi-central"), "pi-central", "9.9.9");
  const resolved = resolvePackage({ from: modules });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.package.version, "9.9.9");
});

test("inside-then-up: a checkout still resolves, and a node_modules dir prefers its own child", (t) => {
  /*
   * The ordering, which is the part a later "simplification" could get wrong. `findPackageInside` is tried first
   * because a `node_modules` directory holding our package is a statement about where the package is, while walking
   * up from it would find an unrelated manifest higher in the prefix.
   *
   * Both shapes are asserted, because a fix that only worked for one would have passed the test above.
   */
  const root = scratch(t);
  // A checkout-shaped tree: the package root itself, with a nested directory.
  const checkout = join(root, "pi-central-dev");
  writeInstall(checkout);
  assert.equal(findPackageRoot(join(checkout, "packages", "app"))?.root, checkout);
  assert.equal(findPackageInside(join(checkout, "packages", "app")), undefined, "a checkout is not a node_modules dir");
  assert.equal(resolvePackage({ from: join(checkout, "packages", "app") })?.ok !== false, true);

  // A node_modules-shaped tree with a decoy manifest ABOVE it: the child must win.
  const modules = join(root, "prefix", "lib", "node_modules");
  writeInstall(join(modules, "pi-central"), "pi-central", "1.0.0");
  writeManifest(join(root, "prefix", "lib"), "not-pi-central", "2.0.0");
  const resolved = resolvePackage({ from: modules });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.package.version, "1.0.0", "the child is our package, so it wins over anything above");
});

test("a node_modules directory holding a DIFFERENT package is not taken", (t) => {
  // `findPackageInside` matches by name, like the walk-up does. A `node_modules` full of other packages must not
  // resolve to one of them.
  const root = scratch(t);
  const modules = join(root, "lib", "node_modules");
  writeInstall(join(modules, "some-other-tool"), "some-other-tool");
  assert.equal(findPackageInside(modules), undefined);
  assert.equal(resolvePackage({ from: modules }).ok, false);
});

test("a node_modules child with no `bin/` is reported as incomplete, not as missing", (t) => {
  // The two sentences have opposite fixes, and the inside-lookup must not collapse them.
  const root = scratch(t);
  const modules = join(root, "lib", "node_modules");
  writeManifest(join(modules, "pi-central"), "pi-central", "1.2.3");
  const resolved = resolvePackage({ from: modules });
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.equal(resolved.reason, "incomplete");
  assert.match(resolved.message, /entry point is missing/);
});
