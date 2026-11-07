/**
 * The shell must not become a second distributable (issue #214, criterion 6; ADR-0013 §1).
 *
 * ## The failure this prevents, which is a drift rather than a bug
 *
 * ADR-0013's whole argument is that the shell carries **no product code**: it launches the installed
 * package, so there is exactly one artifact, one version and one provenance chain. That property is not
 * enforced by anything until it is asserted — and it would be lost by an ordinary, well-meant change:
 * someone adds `"files": ["dist/ui"]` to the app package "so the window has something to show", and the
 * next release ships two copies of the UI that can disagree.
 *
 * So this reads the manifests and asserts the shape:
 *
 *   - the app package is `private` and declares no `bin`;
 *   - nothing in its `files`/layout references the orchestrator's bundle or the built UI;
 *   - the root package's publishable `files` do not include the app.
 *
 * It is a text/file assertion because the property IS about files. A runtime check would have to package
 * the app first, which CI does not do for a launcher that is never shipped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function manifest(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** One level of detail for the failure message: a reader needs to know WHICH key. */
function describeKeys(record: Record<string, unknown>): string {
  return Object.keys(record).join(", ");
}

test("the app package is private, and publishes nothing", () => {
  const app = manifest(join(APP_ROOT, "package.json"));
  assert.equal(app["private"], true, "a private package cannot be published by accident");
  // A `bin` in the app would make `npm install -g @pi-central/app` install a second `pi-central`
  // command, which is the two-versions-that-can-disagree problem in its worst form.
  assert.equal(app["bin"], undefined, "the shell must not install a command");
  assert.equal(app["files"], undefined, "the shell ships no files (it is not distributed)");
});

test("the app does not contain the orchestrator bundle or the built UI", () => {
  // Stronger than a `files` check, because it catches what is actually ON DISK: a copy left there by a
  // build script is exactly how an accidental inclusion starts.
  const app = manifest(join(APP_ROOT, "package.json"));
  const serialized = JSON.stringify(app);
  for (const forbidden of ["dist/ui", "bin/pi-central.js", "pi-central.js"]) {
    assert.equal(serialized.includes(forbidden), false, `the app manifest must not reference ${forbidden}`);
  }
  // And the app's own dependency list must not name the orchestrator: depending on it would let a build
  // resolve the source, and the shell would then be carrying a decomposable copy of the product.
  const dependencies = (app["dependencies"] ?? {}) as Record<string, unknown>;
  const devDependencies = (app["devDependencies"] ?? {}) as Record<string, unknown>;
  const all = { ...dependencies, ...devDependencies };
  for (const name of Object.keys(all)) {
    assert.notEqual(name, "@pi-central/orchestrator", "the shell must not depend on the orchestrator package");
    assert.notEqual(name, "@pi-central/ui", "the shell must not depend on the UI package");
    assert.notEqual(name, "@pi-central/protocol", "the shell speaks to the orchestrator over localhost, not over its types");
  }
  assert.equal(describeKeys(all).includes("pi-central\""), false);
});

test("the published root package does not include the app", () => {
  // The other direction, and the one that would ship the shell to npm: root `files` decides what the
  // tarball contains (ADR-0011 §1).
  const root = manifest(join(REPO_ROOT, "package.json"));
  const files = (root["files"] ?? []) as string[];
  assert.deepEqual(files, ["bin", "dist", "README.md", "LICENSE"]);
  assert.equal(files.some((entry) => entry.startsWith("packages")), false, "workspaces are not published");
});

test("the app is a workspace, so its dependency is installed and its tests run", () => {
  // Not cosmetic: a package outside `workspaces` gets no `node_modules`, so `tsc` cannot resolve
  // `electron` and the tests cannot be reached by `npm test`'s globs.
  const root = manifest(join(REPO_ROOT, "package.json"));
  assert.equal((root["workspaces"] as string[]).includes("packages/app"), true);
  // And `verify` must typecheck it, or the shell is the one package in the repo nothing checks.
  assert.match(String(root["scripts"] && (root["scripts"] as Record<string, string>)["typecheck"]), /packages\/app/);
});
