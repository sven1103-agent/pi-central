/**
 * The version policy's decisions (issue #53).
 *
 * These are the assertions that matter, because each one is a way the policy could stop policing
 * without anyone noticing — a guard that has quietly become permissive reads exactly like a guard
 * that works. The two failure modes with the worst consequences:
 *
 *   - **Too broad**, so it fires on `127.0.0.1`, on Pi's version, and on Safehouse's. A check that
 *     cries wolf gets a blanket exemption, and then it protects nothing. This was the actual first
 *     draft: it reported 37 claims, 35 of them innocent.
 *   - **Too narrow**, so it misses the case it exists for. The original defect was `README.md`
 *     saying "Status: v0.1.0" and `CHANGELOG.md` opening a second `## [0.1.0]`; a policy that did not
 *     catch those two would be decoration.
 *
 * Every test therefore uses text that either must or must not be flagged, and the "must not" cases
 * are the interesting half.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  baseVersion,
  bootstrapRefusal,
  changelogReleases,
  currentVersionClaims,
  isChangelog,
  isReadme,
  latestPointerProblem,
  lockfileDisagreements,
  manifestDisagreements,
  readmeVersionClaims,
  releaseNotesRefusal,
  unreleasedBody,
  unreleasedEntries,
  versionsIn,
} from "./version-policy.mjs";

const file = (path, text) => ({ path, text });

// --- What counts as a version literal --------------------------------------------------------------

test("an IPv4 address is not a version, however much it looks like one", () => {
  // The first draft's bug, in one line. `\d+\.\d+\.\d+` matches "127.0.0" inside "127.0.0.1", so
  // every documented loopback URL became a version claim. Four dotted parts are an address.
  assert.deepEqual(versionsIn("open http://127.0.0.1:8787 and bind 127.0.0.1 only"), []);
  // The same for a longer address and for one with a port attached.
  assert.deepEqual(versionsIn("10.20.30.40 and 192.168.100.200:8080"), []);
});

test("a three-part version is a version, with or without a leading v", () => {
  assert.deepEqual(versionsIn("package.json is 0.2.0"), ["0.2.0"]);
  assert.deepEqual(versionsIn("Delivered as v0.1.0"), ["0.1.0"]);
  // Pre-release suffixes are part of the version, not a separate token.
  assert.deepEqual(versionsIn("shipped 1.2.3-rc.1 today"), ["1.2.3-rc.1"]);
});

test("several versions on one line are all found", () => {
  assert.deepEqual(versionsIn("Pi 1.4.0 and Safehouse 0.12.0"), ["1.4.0", "0.12.0"]);
});

// --- Rule: prose may not state the CURRENT version -------------------------------------------------

test("the current version in prose is a claim", () => {
  const claims = currentVersionClaims(file("docs/NOTES.md", "We just shipped 0.2.0.\n"), "0.2.0");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].path, "docs/NOTES.md");
  assert.equal(claims[0].line, 1);
  assert.equal(claims[0].version, "0.2.0");
});

test("an OLDER version in prose is history, and is allowed", () => {
  // The distinction the policy turns on. `spikes/phase-0/RESULT.md` says the spike was retired at
  // v0.1.0; `docs/INCREMENTS.md` says Increment 1 was delivered as v0.1.0. Both are true records,
  // and rewriting them to satisfy a linter would destroy the history the project deliberately keeps.
  const claims = currentVersionClaims(
    file("docs/INCREMENTS.md", "**Delivered as v0.1.0.** The premise is proven.\n"),
    "0.2.0",
  );
  assert.deepEqual(claims, []);
});

test("a third-party version in prose is not ours, and is allowed", () => {
  const claims = currentVersionClaims(
    file("docs/CONSTRAINTS.md", "Verified against Pi `1.4.0` and Safehouse `0.12.0`.\n"),
    "0.2.0",
  );
  assert.deepEqual(claims, []);
});

test("CHANGELOG.md is exempt, because that is where the current version belongs", () => {
  // Its `## [0.2.0]` heading IS the release. Flagging it would demand the notes not name the thing
  // they are notes about.
  const claims = currentVersionClaims(
    file("CHANGELOG.md", "## [0.2.0] — 2026-10-26\n\n### Added\n"),
    "0.2.0",
  );
  assert.deepEqual(claims, []);
  // A nested copy is still the changelog, because the exemption is about the document's job.
  assert.deepEqual(
    currentVersionClaims(file("packages/x/CHANGELOG.md", "## [0.2.0]\n"), "0.2.0"),
    [],
  );
});

test("an IP address in prose is not a version claim", () => {
  const claims = currentVersionClaims(
    file("README.md", "Then open <http://127.0.0.1:8787>.\n"),
    "0.2.0",
  );
  assert.deepEqual(claims, []);
});

// --- Rule: a README may state no version at all ----------------------------------------------------

test("a README stating the current version is refused", () => {
  // The original defect verbatim: "**Status: v0.1.0 — works end to end, verified.**"
  const claims = readmeVersionClaims(file("README.md", "**Status: v0.1.0 — works end to end.**\n"));
  assert.equal(claims.length, 1);
  assert.equal(claims[0].version, "0.1.0");
});

test("a README stating a THIRD-PARTY version is refused too", () => {
  // Stricter than the prose rule, deliberately. "Verified against Pi 1.4.0" in a README is wrong as
  // soon as Pi ships, and the README is what a stranger reads first — so the honest phrasing points
  // at docs/CONSTRAINTS.md, which is where the verification actually lives.
  const claims = readmeVersionClaims(
    file("docs/decisions/README.md", "verified against Pi `1.4.0` and Safehouse `0.12.0`\n"),
  );
  assert.deepEqual(
    claims.map((c) => c.version),
    ["1.4.0", "0.12.0"],
  );
});

test("a README's IP addresses and ports are not versions", () => {
  const claims = readmeVersionClaims(
    file("README.md", "Then open <http://127.0.0.1:8787> — the URL the server prints.\n"),
  );
  assert.deepEqual(claims, []);
});

test("a non-README Markdown file is not subject to the README rule", () => {
  assert.deepEqual(readmeVersionClaims(file("docs/CONSTRAINTS.md", "Pi `1.4.0`\n")), []);
  // The basename decides, so a README in a subdirectory is still a README.
  assert.equal(readmeVersionClaims(file("packages/ui/README.md", "v0.1.0\n")).length, 1);
});

test("a commented-out version in a README is not prose a reader sees", () => {
  assert.deepEqual(readmeVersionClaims(file("README.md", "<!-- v0.1.0 was the first -->\n")), []);
});

test("README and CHANGELOG are recognised by basename, not by full path", () => {
  assert.ok(isReadme("packages/ui/README.md"));
  assert.ok(!isReadme("packages/ui/README.mdx"));
  assert.ok(isChangelog("CHANGELOG.md"));
  assert.ok(!isChangelog("docs/CHANGELOG.md.bak"));
});

// --- The CHANGELOG structure -----------------------------------------------------------------------

const CHANGELOG = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "### Added",
  "",
  "- a thing nobody has released yet",
  "",
  "## [0.2.0] — 2026-10-26",
  "",
  "### Added",
  "",
  "- the first published release",
  "",
  "## [0.1.0] — first iteration",
  "",
  "The premise is proven.",
  "",
].join("\n");

test("releases are found newest first, and Unreleased is not one of them", () => {
  // If Unreleased counted as a release, "the newest release matches package.json" would pass during
  // development against an empty Unreleased — which is precisely when the version is not released.
  assert.deepEqual(
    changelogReleases(CHANGELOG).map((r) => r.version),
    ["0.2.0", "0.1.0"],
  );
});

test("each release carries its own body and no more", () => {
  const [, older] = changelogReleases(CHANGELOG);
  assert.match(older.body, /The premise is proven/);
  assert.doesNotMatch(older.body, /first published release/, "a section must not run into the next");
});

test("the Unreleased body is found, and its scaffolding is not an entry", () => {
  const body = unreleasedBody(CHANGELOG);
  assert.ok(body !== undefined);
  // `### Added` is structure; the bullet under it is a real change that would ship undocumented.
  assert.deepEqual(unreleasedEntries(body), ["- a thing nobody has released yet"]);
});

test("an absent Unreleased section is absent, not empty", () => {
  // Different defects, different fixes: absent means there is nowhere to record the next change.
  assert.equal(unreleasedBody("# Changelog\n\n## [0.2.0]\n"), undefined);
});

test("an empty Unreleased section yields no entries", () => {
  const body = unreleasedBody("## [Unreleased]\n\nNothing yet.\n\n## [0.2.0]\n");
  // "Nothing yet." IS prose, so it counts. The section must be genuinely empty, not merely cheerful.
  assert.deepEqual(unreleasedEntries(body ?? ""), ["Nothing yet."]);
});

// --- Manifests -------------------------------------------------------------------------------------

test("a workspace manifest that disagrees is named", () => {
  const disagreements = manifestDisagreements(
    [
      file("package.json", JSON.stringify({ version: "0.2.0" })),
      file("packages/ui/package.json", JSON.stringify({ version: "0.1.0" })),
    ],
    "0.2.0",
  );
  assert.equal(disagreements.length, 1);
  assert.match(disagreements[0], /packages\/ui\/package\.json declares "0\.1\.0"/);
});

test("a malformed manifest is skipped, so npm's own error is not masked", () => {
  const disagreements = manifestDisagreements(
    [file("packages/x/package.json", "{ not json")],
    "0.2.0",
  );
  assert.deepEqual(disagreements, []);
});

test("agreeing manifests produce no output at all", () => {
  const manifests = ["package.json", "packages/ui/package.json", "packages/protocol/package.json"].map(
    (path) => file(path, JSON.stringify({ version: "0.2.0" })),
  );
  assert.deepEqual(manifestDisagreements(manifests, "0.2.0"), []);
});

// --- The lockfile ----------------------------------------------------------------------------------

/** A lockfile shape with npm's own duplication of the root version. */
function lockfile({ root = "0.2.0", workspaces = {}, deps = {} } = {}) {
  return JSON.stringify({
    name: "pi-central",
    version: root,
    lockfileVersion: 3,
    packages: {
      "": { name: "pi-central", version: root },
      ...Object.fromEntries(Object.entries(workspaces).map(([p, v]) => [p, { version: v }])),
      ...Object.fromEntries(Object.entries(deps).map(([p, v]) => [`node_modules/${p}`, { version: v }])),
    },
  });
}

test("an agreeing lockfile produces no complaint, and the duplicated root field is not double-counted", () => {
  // npm writes the root version twice (`version` and `packages[""].version`). Reporting both would
  // make one mistake look like two, which is how a failure message stops being read.
  const lock = lockfile({
    workspaces: { "packages/ui": "0.2.0", "packages/protocol": "0.2.0" },
    deps: { ws: "8.22.0", react: "19.3.1" },
  });
  assert.deepEqual(lockfileDisagreements(lock, "0.2.0"), []);
});

test("dependency versions are NOT ours and must not be flagged", () => {
  // The bug the first version of this check had: `packages` maps every installed package, so it is
  // full of versions that belong to `ws`, `react`, `typescript` and several hundred others. A check
  // that demanded they all equal ours reported ~300 false failures — the same "too broad" mistake
  // as the version-literal regex, one layer down.
  const lock = lockfile({ deps: { ws: "8.22.0", "@earendil-works/pi-coding-agent": "1.4.0", typescript: "5.9.3" } });
  assert.deepEqual(lockfileDisagreements(lock, "0.2.0"), []);
});

test("a stale root version in the lockfile is reported once", () => {
  const mismatches = lockfileDisagreements(lockfile({ root: "0.1.0" }), "0.2.0");
  assert.equal(mismatches.length, 1);
  assert.match(mismatches[0], /top level/);
  assert.match(mismatches[0], /"0\.1\.0"/);
});

test("a workspace that disagrees in the lockfile is named by its path", () => {
  // This is the real case: the manifests were bumped and the lockfile was not regenerated. `npm ci`
  // compares the two and fails, so the failure lands on the next machine, not the author's.
  const mismatches = lockfileDisagreements(
    lockfile({ workspaces: { "packages/ui": "0.1.0" } }),
    "0.2.0",
  );
  assert.equal(mismatches.length, 1);
  assert.match(mismatches[0], /packages\/ui/);
});

test("a malformed lockfile is skipped, so npm's own parse error is not masked", () => {
  assert.deepEqual(lockfileDisagreements("{ not json", "0.2.0"), []);
});

test("a lockfile with no packages map does not throw", () => {
  assert.deepEqual(lockfileDisagreements(JSON.stringify({ version: "0.2.0" }), "0.2.0"), []);
});

// --- The bootstrap publish (issue #61) --------------------------------------------------------------

test("a FINAL version may not be published by hand as the first release", () => {
  // The mistake this exists to prevent, and it is irreversible: npm never allows republishing a
  // version, so a hand-published 0.2.0 could never be published again and could never carry a
  // provenance attestation. The first release would be permanently the one unverifiable artifact.
  const refusal = bootstrapRefusal("0.2.0");
  assert.ok(refusal, "a final version must be refused");
  assert.match(refusal, /pre-release/);
  assert.match(refusal, /republishing a version/, "the reason must be the irreversibility");
});

test("a pre-release version may be published by hand", () => {
  // The throwaway that claims the package name at no cost, which is the whole point.
  assert.equal(bootstrapRefusal("0.2.0-rc.1"), undefined);
  assert.equal(bootstrapRefusal("0.2.0-next.1"), undefined);
  assert.equal(bootstrapRefusal("1.0.0-beta"), undefined);
  assert.equal(bootstrapRefusal("0.2.0-alpha.1.2"), undefined);
});

test("BUILD metadata alone is not a pre-release, because npm treats it as the release", () => {
  // `0.2.0+build` sorts as 0.2.0 itself, so it would occupy the final version number and the mistake
  // would go through a check that only looked for a `-`.
  assert.ok(bootstrapRefusal("0.2.0+build"), "build metadata must not count as a pre-release");
});

test("a malformed or empty version is refused rather than assumed safe", () => {
  // Fail closed: the caller cannot be trusted to hand this a sensible string, and "allowed" here
  // means "publish irreversibly".
  assert.ok(bootstrapRefusal(""));
  assert.ok(bootstrapRefusal("0.2.0-"));
  assert.ok(bootstrapRefusal("rc.1"));
  assert.ok(bootstrapRefusal("v0.2.0-rc.1"), "a leading v is not a version npm will accept");
});

// --- What documents a pre-release (issue #61) -------------------------------------------------------

test("a version's base is itself, and a pre-release's base is the release it targets", () => {
  assert.equal(baseVersion("0.2.0"), "0.2.0");
  assert.equal(baseVersion("0.2.0-rc.1"), "0.2.0");
  assert.equal(baseVersion("0.2.0-next.1.2"), "0.2.0");
  // Build metadata has no dash, so it is its own base — npm orders it as the release itself.
  assert.equal(baseVersion("0.2.0+build"), "0.2.0+build");
});

test("a matching newest release satisfies the notes rule", () => {
  assert.equal(releaseNotesRefusal(["0.2.0", "0.1.0"], "0.2.0"), undefined);
});

test("a PRE-RELEASE is documented by its base release, so no throwaway section is needed", () => {
  // The friction this removes: without it, publishing `0.2.0-rc.1` required hand-adding a
  // `## [0.2.0-rc.1]` heading to a CHANGELOG that will never mention the version again.
  assert.equal(releaseNotesRefusal(["0.2.0", "0.1.0"], "0.2.0-rc.1"), undefined);
});

test("a pre-release whose BASE is not the newest release is still refused", () => {
  // The relaxation is narrow on purpose: an RC of an undocumented release has no notes to point at.
  const refusal = releaseNotesRefusal(["0.1.0"], "0.2.0-rc.1");
  assert.ok(refusal);
  assert.match(refusal, /newest CHANGELOG release is 0\.1\.0/);
});

test("a FINAL version is not satisfied by some other release's section", () => {
  // The relaxation must not weaken the rule it relaxes: `0.2.0` is documented only by `## [0.2.0]`.
  assert.ok(releaseNotesRefusal(["0.1.0"], "0.2.0"));
  assert.ok(releaseNotesRefusal(["0.3.0"], "0.2.0"));
});

test("an empty release list is refused by the notes rule", () => {
  assert.ok(releaseNotesRefusal([], "0.2.0"));
});

// --- `latest` after a bootstrap publish -------------------------------------------------------------

test("an un-attested bootstrap version on `latest` is a complaint with the fix in it", () => {
  // The real event, 2026-10-27: the registry set `latest` to the throwaway pre-release, so a plain
  // `npm install pi-central` got an artifact with no provenance attestation. The message has to
  // carry the correction, because the operator reading it is mid-release.
  const problem = latestPointerProblem({ latest: "0.2.0-rc.1", next: "0.2.0-rc.1" }, "0.2.0-rc.1");
  assert.ok(problem, "an un-attested `latest` must be reported");
  assert.match(problem, /npm deprecate pi-central@0\.2\.0-rc\.1/);
  assert.match(problem, /no provenance attestation/i);
  // It must say the thing that was previously believed impossible.
  assert.match(problem, /cannot be prevented/);
});

test("`latest` pointing anywhere else is not a complaint", () => {
  // The healthy case, and the one the release workflow produces: `latest` is the attested release.
  assert.equal(latestPointerProblem({ latest: "0.2.0", next: "0.2.0-rc.1" }, "0.2.0-rc.1"), undefined);
  // `next` alone, with no `latest` at all, is also fine — nothing installable is un-attested.
  assert.equal(latestPointerProblem({ next: "0.2.0-rc.1" }, "0.2.0-rc.1"), undefined);
});

test("an unreadable dist-tag response is not treated as a failure", () => {
  // The check runs after an irreversible publish, so it must never turn an offline `npm view` into a
  // scary non-answer. Absent input means "nothing to judge", not "something is wrong".
  assert.equal(latestPointerProblem(undefined, "0.2.0-rc.1"), undefined);
  assert.equal(latestPointerProblem(null, "0.2.0-rc.1"), undefined);
  assert.equal(latestPointerProblem({}, "0.2.0-rc.1"), undefined);
  assert.equal(latestPointerProblem({ latest: null }, "0.2.0-rc.1"), undefined);
});
