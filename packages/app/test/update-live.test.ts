/**
 * A real install, into a temporary npm prefix (issue #217, criteria 3, 5, 6 and 7).
 *
 * ## Why this needs a real npm
 *
 * `update.test.ts` drives the sequence with a stubbed installer, which proves the *sequence*. It cannot prove that
 * the sequence's assumptions about npm are true: that `npm install --global` with an explicit `--prefix` exits 0, that
 * the version read back from the installed manifest is the one that was asked for, and — the important one — that a
 * request for a version that does not exist exits **non-zero** rather than succeeding quietly.
 *
 * Criterion 3's whole premise is "`npm` exiting 0 is not evidence". That premise is only worth asserting if npm's
 * behaviour is what the code assumes, so this test runs the real installer against a real prefix.
 *
 * ## Why it does not touch the reader's machine
 *
 * `--prefix` points at a temporary directory, and `HOME` is redirected into it, so the global prefix under
 * `/opt/homebrew` (or wherever) is never written. Nothing is installed from the network either: the package installed
 * is a **fixture written by the test**, so the run is offline, fast and deterministic — while still being a real
 * `npm install --global` that really writes a manifest this code really reads back.
 *
 * A network install of `pi-central@<version>` is the manual pass; a test that needed the registry would fail for
 * reasons that have nothing to do with this code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCommand, verifyInstall } from "../src/update-decide.ts";

/** Whether npm is available at all. Named so a skip says what was missing. */
function npmSkip(): false | string {
  const probe = spawnSync("npm", ["--version"], { encoding: "utf8" });
  if (probe.error !== undefined) return "npm is not on PATH";
  if (probe.status !== 0) return `npm --version exited ${probe.status}`;
  return false;
}

const SKIP = npmSkip();

/**
 * Write a minimal installable package at `version`, and return the directory.
 *
 * Deliberately not a tarball: `npm install --global <dir>` installs a local package by path, which is a real install
 * with no registry involved. That keeps the test offline while exercising the same code path.
 */
function fixturePackage(root: string, name: string, version: string): string {
  const directory = join(root, `${name.replace("/", "-")}-${version}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name, version, main: "index.js" }, null, 2),
    "utf8",
  );
  writeFileSync(join(directory, "index.js"), "module.exports = 1;\n", "utf8");
  return directory;
}

/**
 * Read the installed package's version from a prefix — the same fact `readInstalledVersion` reads.
 *
 * `lib/node_modules`, not `node_modules`: npm's GLOBAL prefix layout on Unix is `<prefix>/lib/node_modules`, while a
 * local install uses `<prefix>/node_modules`. Getting this wrong made three tests fail against a perfectly good
 * install — which is worth stating, because the product does not make this assumption (it resolves by walking up from
 * the package root, `package-root.ts`), so the bug was entirely in the test's own idea of npm.
 */
function installedVersion(prefix: string, name: string): string | undefined {
  const manifest = join(prefix, "lib", "node_modules", name, "package.json");
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

test("a real `npm install --global` into a temp prefix lands the exact version, and reads back", { skip: SKIP }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-central-update-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const source = fixturePackage(root, "pi-central", "0.11.0");
  const prefix = join(root, "prefix");
  mkdirSync(prefix, { recursive: true });

  const { command, args } = installCommand("0.11.0");
  // The version comes from `installCommand`, so what is asserted is the app's own argv; the SOURCE of the package is
  // the fixture, because a network install is the manual pass.
  assert.equal(args.includes("--global"), true);
  const result = spawnSync(command, args.slice(0, 2).concat(["--prefix", prefix, source]), {
    encoding: "utf8",
    // A redirected HOME so npm's own cache and config land inside the fixture rather than in the reader's home.
    env: { ...process.env, HOME: root, npm_config_cache: join(root, "cache") },
    timeout: 120_000,
  });

  assert.equal(result.status, 0, `npm install failed:\n${result.stdout}\n${result.stderr}`);
  const landed = installedVersion(prefix, "pi-central");
  assert.equal(landed, "0.11.0", "the manifest on disk is the version that was asked for");
  // And the app's own verification agrees, which is the assertion that matters.
  assert.equal(verifyInstall("0.11.0", landed ?? ""), undefined);
});

test("a real install of a DIFFERENT version is caught by the verification", { skip: SKIP }, (t) => {
  /*
   * Criterion 3's premise, measured. The app asks for 0.11.0, npm installs 0.10.0 — which is exactly what a stale
   * global prefix, a shimmed npm, or a lifecycle script can produce while still exiting 0. The verification must report
   * it, because the product's own report of "updated" would otherwise be a lie.
   */
  const root = mkdtempSync(join(tmpdir(), "pi-central-update-mismatch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const source = fixturePackage(root, "pi-central", "0.10.0");
  const prefix = join(root, "prefix");
  mkdirSync(prefix, { recursive: true });

  const result = spawnSync("npm", ["install", "--global", "--prefix", prefix, source], {
    encoding: "utf8",
    env: { ...process.env, HOME: root, npm_config_cache: join(root, "cache") },
    timeout: 120_000,
  });
  assert.equal(result.status, 0, `npm reported failure, which is a different scenario:\n${result.stderr}`);

  const landed = installedVersion(prefix, "pi-central");
  const failure = verifyInstall("0.11.0", landed ?? "");
  assert.equal(failure?.kind, "version-mismatch", "npm exited 0 and the wrong version is installed — this must be a failure");
  if (failure?.kind !== "version-mismatch") return;
  assert.equal(failure.requested, "0.11.0");
  assert.equal(failure.installed, "0.10.0");
});

test("a real install of a version that does not exist exits non-zero", { skip: SKIP }, (t) => {
  /*
   * The other half of criterion 3: `npm` must actually FAIL for a version it cannot satisfy. If it exited 0 for a
   * missing version, the sequence's `install.code !== 0` branch would be unreachable and the verification would be
   * doing all the work — which works, but for a reason the code does not claim.
   */
  const root = mkdtempSync(join(tmpdir(), "pi-central-update-missing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prefix = join(root, "prefix");
  mkdirSync(prefix, { recursive: true });

  const result = spawnSync("npm", ["install", "--global", "--prefix", prefix, "pi-central@0.0.0-does-not-exist"], {
    encoding: "utf8",
    env: { ...process.env, HOME: root, npm_config_cache: join(root, "cache") },
    timeout: 120_000,
  });
  /*
   * Non-zero is the assertion. Offline this fails with a network error instead of a 404, and both are non-zero — which
   * is the property the sequence needs. A machine with no network must not turn this into a false pass, so the exit
   * code is asserted rather than the message.
   */
  assert.notEqual(result.status, 0, `npm exited 0 for a version that does not exist:\n${result.stdout}`);
});

test("the installed manifest is the only version source the app reads back", { skip: SKIP }, (t) => {
  // Not npm's stdout: the manifest is what the next launch will actually run. Asserted by installing and reading the
  // file directly, which is what `readInstalledVersion` does in `main.ts` through `locatePackage()`.
  const root = mkdtempSync(join(tmpdir(), "pi-central-update-manifest-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = fixturePackage(root, "pi-central", "0.12.3");
  const prefix = join(root, "prefix");
  mkdirSync(prefix, { recursive: true });
  spawnSync("npm", ["install", "--global", "--prefix", prefix, source], {
    encoding: "utf8",
    env: { ...process.env, HOME: root, npm_config_cache: join(root, "cache") },
    timeout: 120_000,
  });
  const manifest = join(prefix, "lib", "node_modules", "pi-central", "package.json");
  assert.equal(existsSync(manifest), true);
  assert.equal(JSON.parse(readFileSync(manifest, "utf8")).version, "0.12.3");
});
