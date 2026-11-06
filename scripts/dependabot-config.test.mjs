/**
 * The development toolchain must be watched by SOMETHING (`.github/dependabot.yml`).
 *
 * ## Why this file exists
 *
 * The vulnerability scan deliberately reads only the RELEASE TREE. That is right — devDependencies do
 * not ship, and a gate over Pi's own toolchain would fail `main` for code no user runs. Measured when
 * the scan was added: 9 fixable findings in the full install, 0 in the shipped tree, all nine
 * `undici`/`minimatch` under `pi-coding-agent`.
 *
 * The exclusion is correct and it creates a blind spot. This asserts the blind spot is covered, in the
 * manner of `release-workflow.test.mjs`: over the TEXT, because the properties are "a file exists and
 * says these things", and a YAML parse would only restate the fields.
 *
 * ## The property that cannot be asserted here, and is stated instead
 *
 * Dependabot **alerts** (CVE detection) are a repository setting, not a file. `dependabot.yml` only
 * raises version updates, which is a different question: a PR appears when a newer version exists, not
 * when an advisory is published against the version installed. So this file cannot prove dev
 * dependencies are CVE-watched; it proves the upgrade channel exists and says, in `docs/SECURITY.md`,
 * which switch still has to be turned on by hand.
 *
 * ## Falsification
 *
 * Delete `.github/dependabot.yml`: every test here fails on the missing file. Remove the `npm` entry:
 * "npm is watched, not only actions" fails. Remove `docs/SECURITY.md`'s pointer: the doc test fails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url);
const CONFIG_PATH = new URL(".github/dependabot.yml", ROOT);
const SECURITY_DOC = new URL("docs/SECURITY.md", ROOT);

test("a Dependabot config exists, so the dev toolchain is not unwatched", () => {
  assert.ok(
    existsSync(CONFIG_PATH),
    "no .github/dependabot.yml — nothing watches the devDependencies the vulnerability scan excludes",
  );
});

const config = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : "";

test("npm is watched, not only GitHub Actions", () => {
  // Actions alone would be the plausible-but-wrong version of this file: it looks like supply-chain
  // coverage while the 9 known findings sit in npm packages and are never offered an upgrade.
  assert.match(config, /package-ecosystem:\s*"?npm"?/, "npm must be watched");
  assert.match(config, /directory:\s*"?\/"?/, "…from the root, where the lockfile is");
});

test("GitHub Actions are watched too, because a workflow's actions are dependencies", () => {
  assert.match(config, /package-ecosystem:\s*"?github-actions"?/);
});

test("the config says it is not the vulnerability report", () => {
  // The failure this prevents: someone reads `dependabot.yml` as CVE coverage and drops the scanner,
  // or reads the scanner's green badge as covering dev dependencies. The two are different questions
  // and the file has to say so where the next person will be looking.
  assert.match(config, /vulnerability/i, "the config must name the relation to the scan");
  assert.match(
    config,
    /dependency-vulnerability-scan\.yml/,
    "…by pointing at the workflow that does the CVE reporting",
  );
});

test("the config records that Dependabot ALERTS are a settings step, not a file", () => {
  // The honest limit. Without this sentence the file reads as full coverage of the dev tree, which it
  // is not: version updates and advisory alerts are different features.
  assert.match(config, /Dependabot alerts/i, "the config must name the setting it depends on");
});

test("a Pi bump is flagged as needing more than a green build", () => {
  // `@earendil-works/pi-coding-agent` is pinned EXACTLY (1.4.0), so Dependabot will offer every
  // release. Merging one on a green CI run is the mistake worth preventing: CI cannot start a
  // sandboxed session at all (C10), so a Pi bump is `verified/manual` by construction.
  assert.match(config, /pi-coding-agent/);
  assert.match(config, /CONSTRAINTS\.md/, "…pointing at where the verified version is recorded");
});

test("the security doc says where dev-dependency coverage lives", () => {
  const doc = readFileSync(SECURITY_DOC, "utf8");
  assert.match(doc, /dependabot\.yml/, "docs/SECURITY.md must point at the dev-dependency watch");
  // And the limit, because the doc is what a reader consults to find out what IS covered.
  assert.match(doc, /Dependabot alerts/i, "…including the setting that detection depends on");
});
