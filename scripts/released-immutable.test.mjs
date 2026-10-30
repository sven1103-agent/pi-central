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

test("EVERY section that has a release tag is exactly as it shipped", (t) => {
  // Checking only `v<package.json>` would repeat the blind spot it exists to close: the version being
  // PREPARED is not the one that ships in the same commit, so entries piling into an OLDER released
  // section go unseen. Every tag that exists is checked, because every one is published.
  let tags = [];
  try {
    tags = execFileSync("git", ["tag", "--list", "v*"], {
      cwd: new URL("..", import.meta.url).pathname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((x) => x.trim())
      .filter((x) => /^v\d+\.\d+\.\d+$/.test(x));
  } catch {
    tags = [];
  }
  if (tags.length === 0) {
    t.skip("no release tags here — nothing to compare against");
    return;
  }

  const section = (text, version) => {
    const esc = version.replace(/\./g, "\\.");
    const m = new RegExp(`^## \\[${esc}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|$(?![\\s\\S]))`, "m").exec(text);
    return m?.[1]?.trim();
  };

  /*
   * The cut-off is not a loophole, it is a fact this guard has to state.
   *
   * Every release before 0.4.1 has entries that were appended AFTER its tag — measured: 0.1.0 by 49 lines,
   * 0.2.0 by 170, 0.3.0 by 97, 0.4.0 by 8. That is pre-existing corruption from before this check existed,
   * and rewriting published history to satisfy a new test would be the same lie in the other direction:
   * the notes for those releases are wrong BECAUSE they were edited, and re-editing them cannot make them
   * match what npm actually shipped.
   *
   * So the guard protects every release from **0.4.0** onwards: 0.4.0 and 0.4.1 are now correct (0.4.0 was
   * restored verbatim from its tag, with the five mistaken entries moved to Unreleased), and both are worth
   * protecting because a reader can still install either. Earlier releases stay out of scope because
   * re-editing them cannot undo the fact that npm already shipped the wrong notes.
   *
   * The cut-off is deliberately a CONSTANT rather than "the newest tag": a moving cut-off would silently
   * stop protecting the release immediately before the current one, which is exactly where mistakes land.
   */
  const IMMUTABLE_FROM = "0.4.0";
  const atLeast = (a, b) => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
    return 0;
  };

  let compared = 0;
  for (const tag of tags) {
    if (atLeast(tag.slice(1), IMMUTABLE_FROM) < 0) continue;
    const shipped = taggedChangelog(tag);
    if (shipped === undefined) continue;
    const version = tag.slice(1);
    const inTag = section(shipped, version);
    if (inTag === undefined) continue;
    compared += 1;
    assert.equal(
      section(changelog, version),
      inTag,
      `## [${version}] differs from what ${tag} published. Entries merged after a release belong under ` +
        `## [Unreleased] — anywhere else and the published notes describe code that is not in the tarball. ` +
        `This is how five entries (gate 141-146) ended up under the released 0.4.0.`,
    );
  }
  // Guard against a vacuous pass: the loop must actually have compared something.
  //
  // This cannot be falsified from a normal checkout — with tags present, `compared` is always > 0 — so it is
  // stated rather than demonstrated. It defends the case where `git tag` succeeds but returns nothing usable
  // (a shallow clone, a source tarball with a stray tag), which would otherwise make this test green while
  // checking nothing at all.
  assert.ok(compared > 0, "at least one release section must have been compared");
});
