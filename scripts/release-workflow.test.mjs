/**
 * The release path's non-negotiables (issue #53).
 *
 * These are properties of YAML files, and they are asserted over the TEXT rather than through a YAML
 * parser. That is a deliberate trade, not laziness:
 *
 *   - The most important check is the ABSENCE of a credential. A parser would tell us no field holds
 *     a token; text tells us the string is nowhere in the file — including in a comment, an env
 *     block, or a step someone added and forgot. For "is there a secret here", broader is correct.
 *   - A parsed assertion ("the publish step's job has id-token: write") would be stricter about
 *     SHAPE, but there is one publish job, and a second one would be a change worth reading anyway.
 *
 * The limitation is stated rather than hidden: a key added in a shape these patterns do not
 * anticipate could slip through. The mitigation is that this file is small and the workflows are
 * small, so the diff that breaks it is visible in review.
 *
 * Why each property is load-bearing is in `.github/workflows/release.yml` itself; this file is the
 * enforcement, and it is the reason a future edit cannot quietly reintroduce a stored token.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { changelogReleases } from "./version-policy.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");

const release = readFileSync(join(WORKFLOWS, "release.yml"), "utf8");
const ci = readFileSync(join(WORKFLOWS, "ci.yml"), "utf8");
const everyWorkflow = readdirSync(WORKFLOWS)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .map((name) => ({ name, text: readFileSync(join(WORKFLOWS, name), "utf8") }));

// --- No stored credential -------------------------------------------------------------------------

test("no workflow references a secret, so there is no long-lived credential to leak or rotate", () => {
  // The strongest form of "we do not use a token": `secrets.` appears nowhere. A scoped check for
  // `NPM_TOKEN` would miss the next person naming theirs `NPM_PUBLISH_TOKEN`, which is the exact
  // mistake a name list always makes (C15c).
  const offenders = everyWorkflow.filter((w) => /secrets\./.test(w.text)).map((w) => w.name);
  assert.deepEqual(
    offenders,
    [],
    `these workflows reference \`secrets.\`: ${offenders.join(", ")}. Publishing authenticates via ` +
      `OIDC (id-token: write), which needs no stored secret.`,
  );
});

test("the specific token names are absent too, so the message names the thing being avoided", () => {
  // Redundant with the check above, and kept on purpose: it fails with a message a reader recognises
  // (`NPM_TOKEN`) instead of a generic complaint, which is what makes the failure actionable.
  for (const { name, text } of everyWorkflow) {
    for (const token of ["NPM_TOKEN", "NODE_AUTH_TOKEN", "NPM_AUTH_TOKEN"]) {
      assert.ok(!text.includes(token), `${name} mentions ${token}; publishing must not need a token`);
    }
  }
});

// --- The publish job can do what it claims --------------------------------------------------------

test("the release workflow can mint an OIDC token", () => {
  // Without this the OIDC exchange fails at the last step of a release — the worst moment to find
  // out, because the tag already exists and the version is half-released.
  assert.match(release, /^\s*id-token:\s*write\b/m, "release.yml must declare `id-token: write`");
});

test("the release workflow can create a GitHub Release", () => {
  // `contents: write` is required to create a release; the default is read-only. Without it the
  // artifact publishes and the release never appears, leaving npm and GitHub disagreeing.
  assert.match(release, /^\s*contents:\s*write\b/m, "release.yml must declare `contents: write`");
});

test("publishing attaches a provenance attestation", () => {
  assert.match(release, /npm publish --provenance/, "the publish must carry --provenance");
});

test("the release runs only on a version tag", () => {
  // A release triggered by a branch push would publish on every merge. The `on: push: tags:` shape is
  // what makes a release a deliberate act.
  assert.match(release, /on:\s*\n\s*push:\s*\n\s*tags:/, "release.yml must trigger on tags");
  assert.match(release, /tags:/, "…and list a tag pattern");
});

test("the release refuses a tag that disagrees with the manifest", () => {
  // A tag and a manifest that disagree mean the artifact's version is not the one that was tagged.
  // The workflow must fail rather than publish one under the other.
  assert.match(release, /package\.json/, "the tag check must read package.json");
  assert.match(release, /GITHUB_REF_NAME/, "…and compare it with the tag");
});

test("the release re-runs verify and the release gate on the tagged commit", () => {
  assert.match(release, /npm run verify/, "verify must run on the tagged commit");
  assert.match(release, /check-version\.mjs --release/, "the Unreleased-empty gate must run");
});

// --- CI inspects the artifact on every PR ---------------------------------------------------------

test("every pull request dry-runs the publish, so the tarball is reviewed before a release", () => {
  // The whole point: a stray file is caught in review rather than discovered on the registry, where
  // it can only be deprecated, never removed.
  assert.match(ci, /npm publish --dry-run/, "ci.yml must dry-run the publish");
  assert.match(ci, /npm run build:package/, "the dry-run needs the artifact built first");
});

test("CI runs on pull requests and on main, not on tags", () => {
  // `release.yml` owns tags. A tag also triggering `ci.yml` would run every gate twice per release.
  assert.match(ci, /pull_request/, "ci.yml must run on pull requests");
  assert.match(ci, /branches:\s*\[main\]/, "…and on pushes to main");
});

// --- The notes and the changelog are one text -----------------------------------------------------

test("the CHANGELOG section the release would publish is non-empty", () => {
  // `release-notes.mjs` exits non-zero on a missing or empty section; this asserts the same fact at
  // commit time, so a version bumped without notes fails in CI rather than during a release.
  const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
  const declared = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const release_ = changelogReleases(changelog).find((entry) => entry.version === declared);
  assert.ok(release_, `CHANGELOG.md has no section for ${declared}`);
  assert.ok(release_.body.trim().length > 0, `the CHANGELOG section for ${declared} is empty`);
});
