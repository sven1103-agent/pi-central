/**
 * A released CHANGELOG section is immutable (issue #114 follow-up).
 *
 * ## The failure this exists to stop
 *
 * While cutting 0.4.0 I found that **nine entries had landed under the released `0.3.0` heading**. Every
 * fix merged after the tag prepended to the first `### Fixed` it found, and `## [Unreleased]` sits above
 * `## [0.3.0]` — so the edits went one heading too far, and the *published* release notes on npm and in
 * the GitHub Release described code that was not in `0.3.0`.
 *
 * `check-version` did not catch it, and could not: it verifies "Unreleased is empty at tag time" and "the
 * newest heading matches package.json". Both were still true. **Nothing asserted that a section already
 * released is closed**, which is the invariant that was actually violated.
 *
 * ## How this knows what is released
 *
 * `package.json`'s version is the boundary: any `## [x.y.z]` at or below it has shipped, and only
 * `## [Unreleased]` and headings above it may gain entries. That is a fact about the repository, not a
 * record that has to be maintained — which is why it can be checked at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { changelogReleases } from "./version-policy.mjs";

const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const declared = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** Compare `1.2.3` to `1.10.0` numerically, not as strings. */
function compare(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

test("no section at or below the declared version is the newest release", () => {
  // The *newest* release section must be the version being prepared, never one already shipped. If the
  // newest is older than `package.json`, entries have been piling into a released heading.
  const releases = changelogReleases(changelog);
  assert.ok(releases.length > 0, "the changelog must have at least one release");
  assert.equal(
    compare(releases[0].version, declared),
    0,
    `the newest CHANGELOG section is ${releases[0].version} but package.json is ${declared}. ` +
      `Entries merged since the last release belong under ## [Unreleased], not under the released heading.`,
  );
});

test("every release section is complete and non-empty", () => {
  // A section that exists and says nothing is a release nobody can read — and an *empty* heading is what
  // a botched promotion leaves behind.
  for (const release of changelogReleases(changelog)) {
    assert.ok(release.body.trim().length > 0, `## [${release.version}] has no notes`);
  }
});

test("the version boundary is comparable, so this test cannot pass vacuously", () => {
  // If `compare` were broken (string comparison would put `1.10.0` before `1.9.0`), the first test could
  // pass for the wrong reason.
  assert.ok(compare("1.10.0", "1.9.0") > 0, "numeric, not lexicographic");
  assert.equal(compare("0.4.0", "0.4.0"), 0);
  assert.ok(compare("0.9.0", "0.10.0") < 0);
});
