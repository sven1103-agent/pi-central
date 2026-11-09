/**
 * What the app build may and may not produce (issue #218, criteria 1, 3, 5, 6, 7, 8).
 *
 * ## Why these are assertions rather than a procedure
 *
 * Six of this slice's criteria are prohibitions or invariants, and a procedure cannot test one: the failure is *a line
 * appearing* in a config, a bundle, or a document. Each would ship silently and usefully-looking — a `.dmg` target makes
 * the build produce a second artifact that cannot be notarized, and the discovery is a release pipeline that cannot
 * complete.
 *
 * The rules live in `scripts/app-build/rules.mjs` so they are plain JS (the build script runs under `node`, not through
 * the TypeScript build) and can be asserted here without building anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FORBIDDEN_CONFIG_KEYS,
  FORBIDDEN_DEPENDENCIES,
  GATEKEEPER_BYPASS_PATTERNS,
  buildConfig,
  bundleProblems,
  chooseSigning,
  configProblems,
  gatekeeperAdviceProblems,
  helperApps,
  identityProblems,
  installPath,
  requiresAdmin,
  setDirectoryLister,
  signArguments,
  signingOrder,
} from "../../../scripts/app-build/rules.mjs";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** The configuration the build script actually uses, from the module both call. */
function shippedConfig(): Record<string, unknown> {
  return buildConfig({ electronVersion: "45.2.3", electronDist: "/x/electron/dist", output: "/x/out" });
}

// -----------------------------------------------------------------------------------------------------------
// Criterion 3 — no dmg, no notarization, no updater.
// -----------------------------------------------------------------------------------------------------------

test("the shipped configuration passes its own audit", () => {
  // The negative control for everything below: if `configProblems` refused everything, all the absence assertions
  // would pass while the build could never run.
  assert.deepEqual(configProblems(shippedConfig()), []);
});

test("a dmg target is refused, because it cannot be notarized and would be a second distributable", () => {
  for (const target of ["dmg", "pkg", "zip", "mas"]) {
    const problems = configProblems({ electronVersion: "45.2.3", mac: { target } });
    assert.equal(problems.length > 0, true, `${target} must be refused`);
    assert.match(problems.join("\n"), /only "dir" is allowed|App-Sandboxed|distributed/);
  }
});

test("an ABSENT target is refused, because electron-builder defaults to dmg", () => {
  // The subtle version: not setting `target` looks like "no opinion" and means "dmg and zip", which is the exact thing
  // criterion 3 forbids. A test that only checked for an explicit `dmg` would pass.
  const problems = configProblems({ electronVersion: "45.2.3", mac: {} });
  assert.match(problems.join("\n"), /would default to "dmg"/);
});

test("notarize and publish are refused at either level", () => {
  for (const key of FORBIDDEN_CONFIG_KEYS) {
    const inMac = configProblems({ electronVersion: "45.2.3", mac: { target: "dir", [key]: {} } });
    assert.equal(inMac.length > 0, true, `mac.${key} must be refused`);
    const atRoot = configProblems({ electronVersion: "45.2.3", mac: { target: "dir" }, [key]: {} });
    assert.equal(atRoot.length > 0, true, `${key} at the root must be refused`);
  }
});

test("a version RANGE is refused, which is the failure measured against electron-builder", () => {
  // Measured: `"electron": "^45.2.3"` in the manifest produces "Electron version ^45.2.3 is a range, not a fixed
  // version" and no build at all. The script passes the INSTALLED version for this reason.
  for (const range of ["^45.2.3", "~45.2.3", "45.x", ">=45", "*"]) {
    const problems = configProblems({ electronVersion: range, mac: { target: "dir" } });
    assert.match(problems.join("\n"), /range|not set/, `${range} must be refused`);
  }
  assert.deepEqual(configProblems({ electronVersion: "45.2.3", mac: { target: "dir" } }), []);
  // And an absent version is its own refusal, because electron-builder cannot package without one.
  assert.match(configProblems({ mac: { target: "dir" } }).join("\n"), /electronVersion is not set/);
});

test("no dependency makes the app an update target", () => {
  // A config scan cannot see a transitive dependency, so the manifest is checked too.
  const app = JSON.parse(readFileSync(join(ROOT, "packages", "app", "package.json"), "utf8")) as Record<string, unknown>;
  const all = { ...(app["dependencies"] ?? {}), ...(app["devDependencies"] ?? {}) } as Record<string, unknown>;
  for (const forbidden of FORBIDDEN_DEPENDENCIES) {
    assert.equal(forbidden in all, false, `${forbidden} must not be a dependency of the app`);
  }
  // electron-builder is a devDependency of the ROOT (it builds the app), never of the app itself — an app that depends
  // on its own packager is a bundle that could try to rebuild itself.
  assert.equal("electron-builder" in all, false, "the packager is the root's devDependency, not the app's");
});

// -----------------------------------------------------------------------------------------------------------
// Criterion 5 — no product code in the bundle.
// -----------------------------------------------------------------------------------------------------------

test("a bundle carrying the orchestrator or the UI is refused", () => {
  // The failure this prevents is the shell becoming a second distributable (ADR-0013 §1) — a second copy of the product
  // with its own version that can drift from the one `npm install -g` installed.
  for (const forbidden of ["bin/pi-central.js", "dist/ui", "dist/ui/assets/index-abc.js"]) {
    const problems = bundleProblems(["app.asar", "package.json", forbidden]);
    assert.equal(problems.length > 0, true, `${forbidden} must be refused`);
    assert.match(problems.join("\n"), /product code/);
  }
});

test("`files` globs that would ship product code are refused BEFORE the build", () => {
  /*
   * The gap the falsification found: `bundleProblems` audits the artifact, so a `files` entry naming `bin/` only failed
   * AFTER a successful build. Catching it in the config means the build never runs — same statement, one step earlier.
   */
  for (const entry of ["bin", "bin/pi-central.js", "dist", "dist/ui", "./dist/ui"]) {
    const problems = configProblems({
      electronVersion: "45.2.3",
      mac: { target: "dir" },
      files: ["main.js", entry],
    });
    assert.equal(problems.length > 0, true, `files including "${entry}" must be refused`);
    assert.match(problems.join("\n"), /product code/);
  }
  // And the shipped globs pass.
  assert.deepEqual(configProblems(shippedConfig()), []);
});

test("a bundle of the shell alone is accepted", () => {
  // The control: the real bundle holds `app.asar`, `default_app.asar` and the icon. `node_modules/ws` is INSIDE the
  // asar and is a runtime dependency of the shell (it opens the socket that asks which sessions are live), not product
  // code.
  assert.deepEqual(bundleProblems(["app.asar", "default_app.asar", "electron.icns"]), []);
});

// -----------------------------------------------------------------------------------------------------------
// Criterion 6 — the app's version has exactly one answer.
// -----------------------------------------------------------------------------------------------------------

test("the bundle's identifier must not be Electron's default", () => {
  // Measured on the first hand-built bundle: `com.github.Electron` would collide with any other Electron app rather than
  // being Pi Central, and it is what you get when the identifier is not set.
  const problems = identityProblems({ id: "com.github.Electron", version: "0.10.0" }, "0.10.0");
  assert.match(problems.join("\n"), /Electron's default/);
  // And the shipped identifier is accepted.
  assert.deepEqual(identityProblems({ id: "com.pi-central.app", version: "0.10.0" }, "0.10.0"), []);
});

test("a bundle whose version disagrees with the package is refused, and one with no version is allowed", () => {
  // Criterion 6 allows either "the app carries the package's version" or "the app carries none"; what it forbids is a
  // shell that disagrees with the package it launches.
  assert.deepEqual(identityProblems({ id: "com.pi-central.app", version: "0.10.0" }, "0.10.0"), []);
  assert.deepEqual(identityProblems({ id: "com.pi-central.app", version: "" }, "0.10.0"), [], "carrying none is allowed");
  const drift = identityProblems({ id: "com.pi-central.app", version: "0.9.0" }, "0.10.0");
  assert.match(drift.join("\n"), /while the package is 0\.10\.0/);
});

// -----------------------------------------------------------------------------------------------------------
// Criterion 4 — signing identity and the TCC consequence.
// -----------------------------------------------------------------------------------------------------------

test("a named identity is used, so privacy grants survive a rebuild", () => {
  const choice = chooseSigning("Pi Central Dev", []);
  assert.equal(choice.kind, "identity");
  if (choice.kind !== "identity") return;
  assert.equal(choice.identity, "Pi Central Dev");
});

test("a detected self-signed identity is used when no variable names one", () => {
  const choice = chooseSigning(undefined, ["Pi Central Dev"]);
  assert.equal(choice.kind, "identity");
  if (choice.kind !== "identity") return;
  assert.equal(choice.identity, "Pi Central Dev");
  // The reason says WHY it matters, not just what happened.
  assert.match(choice.reason, /privacy grants survive a rebuild/);
});

test("with no identity, the fallback is ad-hoc AND says the grants will not survive", () => {
  // The caveat is the whole point: "my permissions reset after every rebuild" is otherwise indistinguishable from a
  // defect in the app, and the fix (a free self-signed certificate) is not something a reader guesses.
  const choice = chooseSigning(undefined, []);
  assert.equal(choice.kind, "adhoc");
  if (choice.kind !== "adhoc") return;
  assert.match(choice.reason, /ad-hoc/);
  assert.match(choice.caveat, /code identity changes on every build/);
  assert.match(choice.caveat, /Keychain Access/, "and it names the fix");
});

test("ad-hoc signing does not use --deep, and does not add the hardened runtime", () => {
  /*
   * Two deliberate omissions. `--deep` is deprecated for SIGNING (Apple's guidance, and the reason the nested list is
   * explicit); `--options runtime` is what notarization requires and it would mean adding Electron's JIT entitlements,
   * which is how an entitlement list becomes a sandbox hole in a launcher (C1, ADR-0013 §6).
   */
  const args = signArguments("/x/Pi Central.app", { kind: "adhoc", reason: "", caveat: "" });
  assert.equal(args.includes("--deep"), false, "--deep is for verifying, not signing");
  assert.equal(args.includes("runtime"), false, "the hardened runtime is not this project's to add");
  assert.deepEqual(args.slice(0, 4), ["--force", "--timestamp=none", "--sign", "-"]);
  // A named identity replaces the `-` and nothing else.
  const named = signArguments("/x/Pi Central.app", { kind: "identity", identity: "Pi Central Dev", reason: "" });
  assert.equal(named[named.length - 2], "Pi Central Dev");
});

test("the signing order puts the app last and every helper before it", () => {
  /*
   * Signing a container before its contents invalidates the container, so the order is load-bearing. The app MUST be
   * last: everything it contains has to be signed first.
   */
  setDirectoryLister(() => ["Pi Central Helper.app", "Pi Central Helper (GPU).app", "Pi Central Helper (Renderer).app"]);
  const order = signingOrder("/x/Pi Central.app", () => true);
  assert.equal(order.at(-1), "/x/Pi Central.app", "the app is signed last");
  assert.equal(order[0]?.includes("libffmpeg.dylib"), true, "dylibs first, because nothing contains them");
  // Every helper before the app.
  for (const helper of order.filter((path) => path.includes("Helper"))) {
    assert.ok(order.indexOf(helper) < order.indexOf("/x/Pi Central.app"));
  }
});

test("helper apps are DISCOVERED, because a packaged app renames them after the product", () => {
  /*
   * The bug this catches, which cost a full build cycle: the first version hardcoded `Electron Helper.app` and friends.
   * A packaged Electron renames them after the product, so the list matched nothing, the helpers went unsigned, and
   * `codesign --verify --deep --strict` failed with "code has no resources but signature indicates they must be present"
   * in a subcomponent.
   */
  setDirectoryLister(() => [
    "Pi Central Helper.app",
    "Pi Central Helper (GPU).app",
    "Electron Framework.framework",
    "not-an-app.txt",
  ]);
  const helpers = helperApps("/x/Pi Central.app", () => true);
  assert.deepEqual(helpers, [
    "/x/Pi Central.app/Contents/Frameworks/Pi Central Helper (GPU).app",
    "/x/Pi Central.app/Contents/Frameworks/Pi Central Helper.app",
  ]);
  // Deterministic order, so two builds of the same tree sign identically.
  assert.deepEqual(helpers, [...helpers].sort());
  // And a missing Frameworks directory yields nothing rather than throwing.
  assert.deepEqual(helperApps("/y/Pi Central.app", () => false), []);
});

test("a missing nested bundle is skipped, not fatal", () => {
  // A future Electron may not ship every dylib; a signer that fails on a missing file breaks on upgrade.
  setDirectoryLister(() => []);
  // Only the framework and the app "exist": the loose predicate used first (`includes("Electron Framework")`) also matched
  // the dylibs INSIDE the framework, so the test was asserting against a tree that had them.
  const present = new Set([
    "/x/Pi Central.app/Contents/Frameworks/Electron Framework.framework",
    "/x/Pi Central.app",
  ]);
  const order = signingOrder("/x/Pi Central.app", (path) => present.has(path));
  assert.deepEqual(order, [
    "/x/Pi Central.app/Contents/Frameworks/Electron Framework.framework",
    "/x/Pi Central.app",
  ]);
  assert.equal(order.at(-1), "/x/Pi Central.app", "the app is still last, which is what matters");
});

// -----------------------------------------------------------------------------------------------------------
// Criterion 7 — no admin rights, and `rm -rf` is enough.
// -----------------------------------------------------------------------------------------------------------

test("the app installs into ~/Applications, never /Applications", () => {
  const path = installPath("/Users/someone");
  assert.equal(path, "/Users/someone/Applications/Pi Central.app");
  assert.equal(requiresAdmin(path), false);
  // The control: a system-wide install is what would need sudo, and it is refused.
  assert.equal(requiresAdmin("/Applications/Pi Central.app"), true);
  assert.equal(requiresAdmin("/Applications"), true);
});

// -----------------------------------------------------------------------------------------------------------
// Criterion 8 — the documentation never teaches a Gatekeeper bypass.
// -----------------------------------------------------------------------------------------------------------

test("no document tells a reader to disable Gatekeeper or strip quarantine", () => {
  /*
   * The two instructions that spread through an unsigned-app project, and both teach a reader to defeat a security
   * control to run code from strangers. The assertion runs over the SHIPPED documents, including the one this slice adds,
   * because a README is what a stranger reads first.
   */
  const documents = ["docs/APP-SHELL.md", "README.md", "docs/DOGFOODING.md", "docs/BUNDLE.md"];
  for (const name of documents) {
    const text = readFileSync(join(ROOT, name), "utf8");
    assert.deepEqual(gatekeeperAdviceProblems(text), [], `${name} must not teach a Gatekeeper bypass`);
  }
});

test("the Gatekeeper patterns have teeth", () => {
  // The negative control for the test above: if the patterns matched nothing at all, that test would pass on any
  // document. Each of these is a sentence the docs must never contain.
  for (const forbidden of [
    "run: xattr -d com.apple.quarantine ~/Applications/Pi Central.app",
    "You may need to disable Gatekeeper first.",
    "sudo spctl --master-disable",
    "Right-click the app and choose Open to run it.",
    "Allow apps from anywhere in System Settings.",
  ]) {
    assert.equal(gatekeeperAdviceProblems(forbidden).length > 0, true, `"${forbidden}" must be caught`);
  }
  // And an honest statement about spctl failing is NOT a bypass.
  assert.deepEqual(gatekeeperAdviceProblems("spctl -a will fail, and that is the accepted state."), []);
});

test("the app shell document states the identity steps and the TCC consequence", () => {
  // Criterion 4 names this document explicitly: the Keychain Access → Create a Certificate → Code Signing steps, and why
  // ad-hoc signing loses the grants.
  const text = readFileSync(join(ROOT, "docs", "APP-SHELL.md"), "utf8");
  assert.match(text, /Keychain Access/);
  assert.match(text, /Self Signed Root/, "the identity type is named");
  assert.match(text, /Code Signing/, "the certificate type is named");
  assert.match(text, /PI_CENTRAL_SIGN_IDENTITY/);
  assert.match(text, /cdhash/, "and the mechanism is explained, not just the symptom");
  // The supported distribution routes, which is what replaces "disable Gatekeeper".
  assert.match(text, /Homebrew tap or cask/);
  assert.match(text, /build it there|build it locally/i);
});

test("the pattern list is exported, so a future document can be checked against it", () => {
  assert.equal(GATEKEEPER_BYPASS_PATTERNS.length >= 4, true);
});
