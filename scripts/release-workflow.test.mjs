/**
 * The release path's non-negotiables (issues #53, #61).
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
import { baseVersion, changelogReleases, releaseNotesRefusal } from "./version-policy.mjs";

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

test("the release notes are generated BEFORE the publish, not after", () => {
  // Ordering is the safety property. Generating the notes afterwards would mean a version with no
  // CHANGELOG section reaches the registry and *then* fails, leaving an artifact that cannot be
  // re-published with a red build and no Release. Asserted by position rather than by presence,
  // because both steps exist either way — only their order decides which failure you get.
  const notes = release.indexOf("release-notes.mjs");
  const stage = release.indexOf("npm stage publish");
  assert.ok(notes >= 0, "the workflow must generate release notes");
  assert.ok(stage >= 0, "the workflow must stage the release");
  assert.ok(
    notes < stage,
    "release-notes.mjs must run before the stage, so a missing CHANGELOG section fails while the " +
      "failure is still free",
  );
});

test("the workflow STAGES and never publishes directly", () => {
  // The security property, and it is deliberately an ABSENCE check.
  //
  // Staging is only a control because the registry rejects a direct publish from this workflow: the
  // trusted publisher is configured stage-only. A workflow that merely chose not to call
  // `npm publish` would be decoration — anything able to influence this workflow could call it
  // instead. So the assertion is that the command does not appear at all, which is the state that
  // cooperates with the registry-side rule rather than depending on our own restraint.
  //
  // `npm stage publish` does not contain the substring `npm publish`, so this cannot pass by
  // accident. Asserted explicitly rather than assumed, because a guard built on a substring that
  // happens to overlap is a guard that silently stops working.
  assert.ok(
    !release.includes("npm publish"),
    "release.yml must not contain a direct `npm publish`; stage-only publishing means the registry " +
      "would reject it anyway, and its absence is what makes that true here too",
  );
  assert.match(release, /npm stage publish/, "release.yml must stage");
});

test("the GitHub Release is a DRAFT, because a staged version is not installable yet", () => {
  // A Release is a claim that a version exists for people to use. Creating a live one for a staged
  // version would announce something nobody can install — and if the stage is then REJECTED, the
  // Release would have to be withdrawn. `--draft` is what keeps the notes in one place without
  // making that false claim.
  assert.match(release, /gh release create/, "the workflow must create the Release with gh");
  assert.match(release, /--draft/, "the Release must be created as a draft, not published");
});

test("the run tells the maintainer how to approve, rather than assuming they know", () => {
  // The workflow ends in a state only a human can finish. An operator should not have to read the
  // workflow to find out what that is, and the two things they cannot guess — that 2FA is required
  // and that approval can be blocked by a malware scan — are exactly what the run must say.
  assert.match(release, /npm stage approve/, "the run must name the approval command");
  assert.match(release, /npm stage reject/, "…and how to discard it");
  assert.match(release, /2FA/i, "…and that approval requires 2FA");
  assert.match(release, /malware scan/i, "…and that scanning can block approval");
});

test("publishing attaches a provenance attestation", () => {
  assert.match(release, /npm stage publish --provenance/, "the stage must carry --provenance");
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

test("the CHANGELOG documents the version being released, and not with an empty section", () => {
  // **The rule is not re-implemented here, and that is the whole lesson of this test.**
  //
  // It used to find the section with an exact `version === declared` match — a second copy of a rule
  // that also lives in `release-notes.mjs`. It passed for a final version and broke the instant a
  // pre-release appeared: with `0.2.0-rc.1`, the correct behaviour is to document it by its BASE
  // release, `release-notes.mjs` did exactly that, and this test failed for the right change. A test
  // that disagrees with the code it tests is worse than no test, because the failure points at the
  // code instead of at itself.
  //
  // So it calls the shared rule, and only asserts the part that is genuinely this test's business:
  // that whatever DOES document the version is not blank. `release-notes.mjs` exits non-zero on an
  // empty body; this catches the same thing at commit time rather than during a release.
  const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
  const declared = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const releases = changelogReleases(changelog);

  assert.equal(
    releaseNotesRefusal(
      releases.map((release) => release.version),
      declared,
    ),
    undefined,
    `the CHANGELOG does not document ${declared}`,
  );

  // The section that documents it — itself, or its base when it is a pre-release.
  const documenting =
    releases.find((release) => release.version === declared) ??
    releases.find((release) => release.version === baseVersion(declared));
  assert.ok(documenting, `no section documents ${declared}`);
  assert.ok(
    documenting.body.trim().length > 0,
    `the CHANGELOG section for ${documenting.version} is empty`,
  );
});

// --- The bootstrap publish (issue #61) ------------------------------------------------------------

const bootstrap = readFileSync(join(ROOT, "scripts", "bootstrap-publish.mjs"), "utf8");

test("the bootstrap publish can never target `latest`", () => {
  // Structural, not validated: the tag is a constant, so there is no branch in which an un-attested
  // first artifact becomes what `npm install pi-central` resolves to. Asserted on the constant rather
  // than by grepping for the word "latest", which appears legitimately in the script's own output
  // telling the reader that the bootstrap must NOT become it.
  assert.match(
    bootstrap,
    /const TAG = "next";/,
    "the bootstrap tag must be `next`; `latest` would put an un-attested artifact in front of every install",
  );
});

test("the bootstrap publish is gated by the tested refusal, not by prose", () => {
  // If this import disappears, the script would publish whatever version it is handed — which is the
  // irreversible mistake (npm never allows republishing a version).
  assert.match(bootstrap, /import \{[^}]*bootstrapRefusal[^}]*\} from "\.\/version-policy\.mjs"/);
  assert.match(bootstrap, /bootstrapRefusal\(version\)/);
});

test("the bootstrap publish is not part of any workflow, because it cannot be", () => {
  // It needs an interactive `npm login` and it must run once. A workflow that called it would be a
  // workflow that publishes an un-attested artifact on a schedule.
  const offenders = everyWorkflow.filter((w) => w.text.includes("bootstrap-publish")).map((w) => w.name);
  assert.deepEqual(offenders, [], `these workflows call the manual bootstrap: ${offenders.join(", ")}`);
});
