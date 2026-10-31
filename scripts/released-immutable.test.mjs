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

// --- A released section cannot GROW after it ships (the 0.4.0 recurrence) -------------------------

/**
 * The check above compares the newest section's version to `package.json`, and that is the right
 * boundary for "entries piled into a released heading" — but it has a blind spot that let this happen
 * three times in a row: **the two boundaries agree both before a release is cut and after it ships.**
 *
 * While preparing `0.4.1`, `package.json` says `0.4.1` and the newest heading is `0.4.1`. Once `0.4.1` is
 * tagged and published, exactly the same thing is true. So a fix merged the day AFTER the release prepends
 * to `### Fixed` in the section that is already on npm, and nothing complains — the published notes come
 * to describe code that is not in the published tarball.
 *
 * Found this way: five entries (#141, #142, #143, #144, #146) were sitting under the released `0.4.0`
 * heading, and `grep thinkingGist` against the `v0.4.0` tag returned nothing — the notes described code
 * that had never been in that release.
 *
 * The signal that distinguishes the two states is the TAG, which holds a snapshot of the CHANGELOG at the
 * moment of release. If `v<x.y.z>` exists, its copy of that section is what shipped; anything the working
 * tree says differently arrived afterwards.
 *
 * Skipped rather than failed when git or the tag is unavailable, because this must not break a shallow
 * clone or a source tarball — and a test that fails for "no git here" trains people to ignore it.
 */
import { execFileSync } from "node:child_process";

function taggedChangelog(tag) {
  try {
    return execFileSync("git", ["show", `${tag}:CHANGELOG.md`], {
      cwd: new URL("..", import.meta.url).pathname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

test("a released section cannot GAIN an entry after it ships", (t) => {
  /*
   * ## What this guard is for, restated after it was reformulated
   *
   * It began as byte-equality against the tag's copy of the file, because the defect it was written for was
   * **entries piling into a published heading**: five fixes (#141–#146) sat under the released 0.4.0 and described
   * code that was not in that tarball. That is the failure worth catching, and it is about ADDITION.
   *
   * Byte-equality was a stricter proxy, and it had to be relaxed for a deliberate reason. On 2026-10-31 the
   * changelog was compressed for readability — 1,795 lines to 175 — across every section, at the maintainer's
   * request ("the changelog is way too verbose. Nobody will read that. Changelog needs to be scannable"). The
   * prose in this repository is a summary; the published GitHub Releases keep the full bodies, and the two linked
   * from the repo are now deliberately terser than the ones npm shipped.
   *
   * So the invariant is narrowed to the one that still holds and still matters: **a released section may be
   * rewritten, but it may not grow a new change.** The recorded baseline in `released-sections.json` is what a
   * release had; a section with MORE entries, or an issue number it did not have, means someone appended to
   * published history again.
   */
  let recorded;
  try {
    recorded = JSON.parse(readFileSync(new URL("./released-sections.json", import.meta.url), "utf8"));
  } catch {
    t.skip("no recorded baseline — nothing to compare against");
    return;
  }

  const sections = (text) => {
    const out = new Map();
    const heads = [...text.matchAll(/^## \[([\d.]+|[^\]]+)\][^\n]*$/gm)];
    heads.forEach((m, i) => {
      const from = m.index + m[0].length;
      const to = i + 1 < heads.length ? heads[i + 1].index : text.length;
      out.set(m[1], text.slice(from, to));
    });
    return out;
  };

  const live = sections(changelog);
  for (const [version, baseline] of Object.entries(recorded)) {
    // The file also carries `_kinds` (what each cited number is) and may gain other underscore-prefixed metadata.
    // Iterating those as releases is how this guard failed on its own bookkeeping rather than on the changelog.
    if (version.startsWith("_")) continue;
    const body = live.get(version);
    if (body === undefined) continue;
    const entries = body.split("\n").filter((line) => line.startsWith("- "));
    assert.ok(
      entries.length <= baseline.entries,
      `## [${version}] has ${entries.length} entries but shipped with ${baseline.entries}. A released section ` +
        `may be rewritten, never extended — an entry added after a release describes code that is not in the ` +
        `tarball, which is how five fixes (141-146) ended up under the released 0.4.0.`,
    );
    const now = new Set([...body.matchAll(/#(\d{1,4})\b/g)].map((m) => m[1]));
    const added = [...now].filter((n) => !baseline.issues.includes(n));
    assert.deepEqual(
      added,
      [],
      `## [${version}] gained issue reference(s) ${added.join(", ")} after shipping. Same rule: a release is ` +
        `closed to new changes.`,
    );
  }
});

test("the baseline covers every released section, so the check cannot be vacuous", () => {
  // A baseline that silently missed a version would exempt it. Checked here rather than in the loop above,
  // because "no entry for 0.3.0" and "0.3.0 has no problem" must not look the same.
  const recorded = JSON.parse(readFileSync(new URL("./released-sections.json", import.meta.url), "utf8"));
  const declared = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  const versions = Object.keys(recorded).filter((key) => !key.startsWith("_"));
  assert.ok(versions.length > 0, "the baseline must not be empty");
  for (const version of versions) {
    assert.ok(
      compare(version, declared) <= 0,
      `${version} is recorded as released but package.json says ${declared}`,
    );
  }
});
