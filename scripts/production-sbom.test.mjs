/**
 * The vulnerability scan must report on what SHIPS, and must be able to say "clean" only when it
 * actually looked at something (`scripts/production-sbom.mjs`).
 *
 * ## The defect these tests exist for
 *
 * The obvious way to build a production SBOM is `npm sbom --omit=dev`. **Measured** on this
 * repository, that command returns 60 components with **no `ws`** — and `ws` is the package's only
 * runtime dependency, declared in the root `dependencies` and shipped as the single external in the
 * orchestrator bundle. The cause is that `ws` is also required by a dev-only package
 * (`@google/genai`), and npm's omission pass drops the entry rather than deciding it by
 * reachability from the root.
 *
 * So the failure this guards is not "the scan crashed". It is **"the scan was green and blind"**:
 * a report of 0 vulnerabilities over a tree that was missing the one library the published
 * artifact loads. That is the worst shape a security report can take, because it is
 * indistinguishable from good news.
 *
 * ## Falsification
 *
 * Skip the `ws` entry when building the component list, as `npm sbom --omit=dev` does: "the one
 * external dependency of the shipped bundle is in the SBOM" fails, naming `ws`. That is the
 * assertion that would have caught the original mistake.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runSbom() {
  const out = join(mkdtempSync(join(tmpdir(), "pi-sbom-")), "sbom.json");
  execFileSync(process.execPath, [join(ROOT, "scripts", "production-sbom.mjs"), "--out", out], {
    stdio: "pipe",
  });
  return JSON.parse(readFileSync(out, "utf8"));
}

const bom = runSbom();
const names = new Set(bom.components.map((component) => component.name));
const lockfile = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));

/** The installed package name of a lockfile path (`node_modules/a/node_modules/b` → `b`). */
function nameFromPath(path) {
  const tail = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
  const parts = tail.split("/");
  return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

test("the SBOM is a CycloneDX document with the components in it", () => {
  // The shape Grype needs. Asserted rather than assumed because a schema change in the script would
  // otherwise surface as an empty scan, and Grype on a component-less BOM reports zero findings.
  assert.equal(bom.bomFormat, "CycloneDX");
  assert.equal(bom.specVersion, "1.5");
  assert.ok(bom.components.length > 0, "an SBOM with no components scans clean and means nothing");
  for (const component of bom.components) {
    assert.ok(component.purl?.startsWith("pkg:npm/"), `${component.name} has no npm purl`);
  }
});

test("the one external dependency of the shipped bundle is in the SBOM", () => {
  // `ws` is the ONLY entry in the root `dependencies` and the only external in the esbuild bundle
  // (`scripts/build-package.mjs`), i.e. the only library the published artifact loads at runtime.
  // `npm sbom --omit=dev` omits exactly this package — see the header.
  const runtimeDependencies = Object.keys(
    JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).dependencies ?? {},
  );
  assert.ok(runtimeDependencies.length > 0, "the root manifest must declare its runtime dependency");
  for (const dependency of runtimeDependencies) {
    assert.ok(
      names.has(dependency),
      `${dependency} is a runtime dependency of the published package but is absent from the SBOM — ` +
        "the scan would be green and blind (this is precisely what `npm sbom --omit=dev` does here)",
    );
  }
});

test("every runtime dependency of every workspace is in the SBOM", () => {
  // The same property one level down, expressed as a rule rather than a name list: the UI's vendored
  // libraries (`react`, `shiki`, `markdown-it`, `dompurify`) ship inside `dist/ui` and are invisible
  // to a scanner reading only the root manifest. `dompurify` in particular is the whole mitigation
  // in ADR-0006, so a scan that did not see it would miss the library that matters most.
  const workspaces = ["packages/protocol", "packages/orchestrator", "packages/ui"];
  const missing = [];
  for (const workspace of workspaces) {
    const manifest = JSON.parse(readFileSync(join(ROOT, workspace, "package.json"), "utf8"));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      // A workspace-internal dependency is a symlink, not a shipped library.
      if (dependency.startsWith("@pi-central/")) continue;
      if (!names.has(dependency)) missing.push(`${workspace}: ${dependency}`);
    }
  }
  assert.deepEqual(missing, [], "shipped dependencies missing from the SBOM");
});

test("no dev-only package is in the SBOM", () => {
  // The other direction, and the whole point of reporting what the release ships: the development
  // toolchain (Pi, TypeScript, esbuild, vite, jsdom) is where every finding on this repository came
  // from, and including it would bury a real one in shipped code.
  //
  // The comparison is on VERSIONS as well as names, because a package can exist in both trees at
  // different versions (`ws` is prod at 8.22.0; a dev-only package may require a different one).
  const shipped = new Set(bom.components.map((component) => `${component.name}@${component.version}`));

  const leaked = Object.entries(lockfile.packages)
    .filter(([path, entry]) => path.startsWith("node_modules/") && entry.dev === true && entry.version)
    .map(([path, entry]) => `${entry.name ?? nameFromPath(path)}@${entry.version}`)
    .filter((identity) => shipped.has(identity));

  assert.deepEqual([...new Set(leaked)], [], "dev-only packages leaked into the shipped SBOM");
});

test("the SBOM is much smaller than the full install, so the exclusion actually happened", () => {
  // A numbers check, because "no dev-only package is present" passes trivially if the exclusion is
  // broken in the other direction (everything skipped). Asserted as a bound rather than an equality,
  // so adding a dependency does not fail this.
  const all = Object.keys(lockfile.packages).filter((path) => path.startsWith("node_modules/"));
  assert.ok(all.length > bom.components.length, "the full install must be larger than the shipped set");
  assert.ok(
    bom.components.length < all.length / 2,
    `the shipped set (${bom.components.length}) should be a minority of the install (${all.length})`,
  );
});

test("the script FAILS rather than writing an empty SBOM", () => {
  // An empty SBOM is the silent-green failure. Simulated by pointing the script at a lockfile with no
  // installable entries — it must exit non-zero, not emit a component-less document.
  const dir = mkdtempSync(join(tmpdir(), "pi-sbom-empty-"));
  const copy = join(dir, "scripts");
  execFileSync("cp", ["-R", join(ROOT, "scripts"), copy]);
  execFileSync("cp", [join(ROOT, "package.json"), dir]);
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));

  const result = spawnSync(process.execPath, [join(copy, "production-sbom.mjs"), "--out", join(dir, "sbom.json")], {
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0, "the script exited 0 on an empty lockfile, so it would scan clean");
  assert.match(result.stderr, /no shipped components/, "the failure must name the reason");
});
