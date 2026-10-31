# Releasing

How a release happens, why each step exists, and how to undo one. A release is a single, reviewable
act ([issue #53](https://github.com/sven1103-agent/pi-central/issues/53)); nothing here is improvised
at the moment of shipping.

## One version, declared once

The version lives in **`package.json`** and nowhere else. `README.md` and `CHANGELOG.md` used to
claim it too, which made three places to disagree, and `0.1.0` had in fact already been claimed twice
— once as the package version and once as the name of Increment 1.

Three rules are enforced by `npm run check:version` (`scripts/check-version.mjs`, run as part of
`npm run verify`, so every pull request and every commit to `main`):

1. **Every manifest agrees, and so does the lockfile.** The root manifest declares; the three
   private workspace manifests and `package-lock.json` must match. None of the workspaces is
   published, so agreement is the whole requirement.
2. **No prose states the current version.** Older versions are fine — documents record what shipped
   when, and that is history rather than a claim about today.
3. **No README states any version at all**, Pi Central's or a third party's. A stale number in the
   document a stranger reads first is the most expensive kind, and "verified against Pi 1.4.0" is
   wrong the moment Pi ships. Point at [CONSTRAINTS.md](CONSTRAINTS.md), which tracks it.

The lockfile records the version a fourth time, and **`npm ci` compares it with the manifests** — so
a version bumped without regenerating the lock breaks the build on the next machine, not on the
author's, whose `node_modules` is already installed.

Bump with the workspace flag, then regenerate the lockfile:

```bash
npm version <x.y.z> --workspaces --include-workspace-root
npm install --package-lock-only --ignore-scripts
```

`--package-lock-only` rewrites the lockfile without touching `node_modules`, and
`--ignore-scripts` keeps an install step from running in what is meant to be a metadata edit.

## The first release is different, and it is the only manual one

`release.yml` publishes over OIDC, which needs a **trusted publisher** — and a trusted publisher is
configured *from an existing package's settings page*. `npm help trust` says so directly:

```
Prerequisites
  • Package must exist: The package you're configuring must already exist on the npm registry.
  • 2FA enabled on account
```

So the workflow **cannot** perform the first publish: there is no package on which to configure the
trust. This is a genuine bootstrap, not an oversight in the workflow, and it is worth doing correctly
because **npm never allows republishing a version**. A final version published by hand could never be
published again, so it could never carry a provenance attestation — the first release would be
permanently the one artifact nobody can verify.

Hence: the bootstrap is a **pre-release**, published under the `next` tag, and the real release
follows through the workflow with provenance. Do this once, on a throwaway branch that is never
merged:

```bash
# 1. A pre-release version. `scripts/bootstrap-publish.mjs` refuses a final one and says why, and
#    `npm version` updates all four manifests AND the lockfile, so they cannot drift.
npm version <x.y.z>-rc.1 --no-git-tag-version --workspaces --include-workspace-root

# 2. Authenticate. 2FA is required at the account level.
npm login

# 3. Rehearse, then publish. Verify, build and `--tag next` are inside the script.
node scripts/bootstrap-publish.mjs --dry-run
node scripts/bootstrap-publish.mjs

# 4. Configure the trust, so every later release uses OIDC. Real flags are from
#    `npm trust github --help` on your npm (needs npm >= 11.15).
npm trust github pi-central --file release.yml --repo sven1103-agent/pi-central --allow-publish
npm trust list pi-central          # confirm
npm view pi-central versions --json
```

Then throw the branch away, restore the real version, and release it normally — the steps below:

```bash
git switch main && git branch -D <bootstrap-branch>
npm version <x.y.z> --no-git-tag-version --workspaces --include-workspace-root
git commit -am 'release: <x.y.z>' && git tag v<x.y.z> && git push origin v<x.y.z>
```

Four things about this that are deliberate rather than incidental:

- **No throwaway CHANGELOG section.** A pre-release is documented by its BASE release:
  `<x.y.z>-rc.1` is a candidate for `<x.y.z>`, so `## [<x.y.z>]` is where its notes live, and
  `release-notes.mjs` says so in a preamble on the GitHub Release. Requiring a `## [<x.y.z>-rc.1]`
  heading would mean hand-editing the changelog to publish something it will never mention again —
  friction in exchange for nothing. The rule is a tested pure function (`releaseNotesRefusal`), not a
  sentence in this document. (Placeholders, not a real number, because this file must not state the
  current version — see the rule below.)
- **The notes are prepared before the publish, not after.** `release.yml` writes `release-notes.md`
  while the failure is still free: a version with no CHANGELOG section stops the run *before* the
  irreversible step, instead of leaving an artifact on the registry with no Release and a red build.
- **The bootstrap version will not become `latest` *because we asked* — which is not the same as it
  not happening.** `scripts/bootstrap-publish.mjs` hard-codes `--tag next`, and the publish request
  carries only that tag: **measured 2026-10-27** against a local registry stub, which received
  `"dist-tags":{"next":"…"}` and nothing else, and did not include `latest` even on a second probe
  where one already existed to preserve. So the client never *asks* for `latest`, which means the
  **registry** decides — and the registry once set `latest` to the throwaway, so `npm install
  pi-central` resolved to an artifact with no attestation until the real release landed. This
  document previously called the hard-coded tag a *structural* guarantee. It was not one, and the
  claim is what stopped anyone checking (issue #66). The script now verifies the dist-tags after
  publishing and prints the correction; what survives is *check, do not assume*.
- **The bootstrap has no provenance attestation, and cannot have one.** The attestation is built from
  the CI provider's OIDC identity, so no local invocation produces one however it is spelled. That is
  exactly why the *real* release must not be the manual one.
- **`<x.y.z>-rc.1` is not a released version.** It stays on the `next` dist-tag. The workflow's
  release sets `latest`.

This step is **`verified/manual`**: no part of it runs in CI, because no part of it can.

## Cutting a release

1. **Promote the changelog.** Move everything under `## [Unreleased]` into a new
   `## [<x.y.z>] — <date>` section. Development is allowed to carry unreleased entries; a tag is not.
2. **Bump the version** with the command above.
3. **Verify.** `npm run verify` must be green. It runs the version rules, the docs-reference check,
   and both test suites.
4. **Confirm the release gate** — `node scripts/check-version.mjs --release`. This is the strict mode:
   it adds "`## [Unreleased]` is empty" to rules 1–3, which is only true at tag time, which is why it
   is not part of every commit.
5. **Tag and push:**

   ```bash
   git tag v<x.y.z>
   git push origin v<x.y.z>
   ```

6. **Watch `.github/workflows/release.yml`.** It re-runs every gate on the tagged commit, refuses if
   the tag and the manifest disagree, builds the artifact, **stages** it with a provenance
   attestation, and creates a **draft** GitHub Release.

7. **Approve the staged version.** This is the step that makes a release a human decision:

   ```bash
   npm stage list                    # the staged versions, with their ids
   npm stage view <stage-id>         # what is in it, and its dist-tag
   npm stage approve <stage-id>      # promotes it to the registry — prompts for 2FA
   npm stage reject <stage-id>       # discard it instead
   ```

   The same actions are available from the package's *Staged Packages* tab on npm. **Approval can
   fail until npm's malware scan completes** — staged packages are not approvable before it does.

8. **Publish the draft GitHub Release**, which already carries the notes. If the stage was rejected,
   **delete the draft** instead; it claims a version that does not exist.

9. **Verify the dist-tags.** This is the last step, and it is a step rather than a recollection:

   ```bash
   npm view pi-central dist-tags
   ```

   `latest` must be the version just released. A release whose tags were never checked is a release
   whose tags are unknown — and the registry has moved `latest` on its own once already (issue #66),
   so this is the check that would have caught it in seconds instead of by accident.

Nothing here is published from a laptop. The one exception in the whole process is the bootstrap
above, which exists precisely because it cannot go through CI — and which is a throwaway pre-release
under `next`, never a version anyone is meant to install.

## What the release workflow refuses to do

- **Publish a tag that disagrees with `package.json`.** A tag that disagrees with the artifact is how
  the two start lying about what shipped. It fails rather than helpfully publishing one under the
  other.
- **Release with an empty `## [Unreleased]`.** This is `--release` mode, and it is what stops a
  release shipping undocumented changes.
- **Publish a version with no CHANGELOG section.** `scripts/release-notes.mjs` exits non-zero rather
  than attaching an empty body — a release with blank notes goes unnoticed.
- **Publish at all.** It stages. Going live requires a maintainer with 2FA, and the registry rejects a
  direct publish from this workflow whether or not it tried.

## Publishing uses OIDC, not a stored token — and staging, enforced by the registry

Two mechanisms, and the second is the one that actually constrains anything.

**OIDC, not a stored token.** The workflow declares `id-token: write` and references **no GitHub
Actions secret at all**. The runner mints a short-lived OIDC token, and npm exchanges it for a stage
credential under a **trusted publisher** configured on the package's npm page. A stored token is a
credential that has to be rotated, can be exfiltrated by a compromised dependency, and outlives
whoever created it; `scripts/release-workflow.test.mjs` fails if one is reintroduced.

**Stage-only, which is the control.** Staging is *not* a property of the workflow. A workflow that
merely chose to stage would be decoration, because anything able to influence it could publish
directly instead. What makes it real is a setting on the trusted-publisher configuration: with
**stage-only** on, the registry **rejects a direct publish** from this workflow and accepts only a
staged one. So the workflow cooperates with a rule the registry enforces, rather than relying on its
own restraint.

**Configure it once, after the bootstrap publish above** — from the package's settings page on npm
(GitHub Actions, repository `sven1103-agent/pi-central`, workflow `release.yml`), or from the terminal
with `npm trust`:

| Setting | Value | Why |
|---|---|---|
| Direct publishing | **off** | This is what makes staging a control rather than a convention |
| Allow npm dist-tag | **off** | CI cannot move `latest`, `next` or `beta` on its own; the approver confirms the tag |
| Stage-only | **on** | A direct publish from the workflow is rejected outright |

Restricting **traditional token access** as well covers the other direction: stage-only binds the
*trusted publisher*, so it constrains publishes that authenticate as this workflow. A maintainer's
token is a different identity, and it can still publish directly unless token access is restricted
too. Be precise about which of the two you are relying on — the CI threat is the one that motivated
this, and stage-only is the setting that addresses it.

Staging needs **no 2FA** ("`npm stage publish` never requires a 2FA prompt, regardless of token
type"), so nothing about CI becomes interactive. The second factor moves to *approval*, which is
where the decision is.

Leave any publish token out of the repository's secrets; there is deliberately nothing to add.

### `0.0.0-stage` is not a stray version

The first time a version is staged, npm publishes a placeholder:

```
$ npm view pi-central@0.0.0-stage description
Temporary package placeholder for staged publishing
```

It is ~332 bytes, publicly available, and **managed by the registry** — npm's docs say the placeholder
is public while the staged version and its contents are not. So seeing `0.0.0-stage` in
`npm view pi-central versions` is expected once staging has been used, and it is not something to
"clean up" or deprecate.

Its presence is also a useful signal: it means a staged publish has happened on this package at some
point, so **check the queue for anything left over** (`npm stage list`). A staged version nobody
approves is a release nobody is tracking.

The workflow installs a current npm because both trusted publishing and staging need a recent CLI —
staging specifically **npm ≥ 11.15.0 on Node ≥ 22.14.0**, and the package must already exist on the
registry (which the bootstrap above is for).

### Why the GitHub Release is a draft

A Release is a claim that a version exists for people to use. A staged version is not installable, so
creating a live Release at that point would announce something nobody can install — and if the stage
is then rejected, the Release would have to be withdrawn. The draft holds the notes so the approver
has the material in one place, and publishing it is a deliberate act after approval.

## Provenance, and checking it

`npm stage publish --provenance` attaches a signed attestation tying the tarball to the commit and
workflow run that produced it, and the attestation survives approval. To check an installed version:

```bash
npm audit signatures
```

This is the difference between "the maintainer says this is the code" and "this can be verified".

### What it does not cover, stated plainly

Provenance is the answer to *"did the publisher produce this artifact?"*. It is **not** an answer to
anything else, and three gaps are worth naming because each has a real incident behind it:

**1. Nobody enforces it.** npm shows an attestation badge; it does not refuse an unattested tarball,
and neither does `npx`. Verification is a command the user has to know to run — which is why it is in
the README's install section and not only here. Evidence nobody checks is a claim, not a control.

**2. It cannot vouch for the publisher.** If the release identity were compromised, the attestation
would be *valid* and the artifact malicious. Provenance is only as trustworthy as the identity minting
it. On 2026-10-29 a trojanized `Anthropic.claude-code` 2.1.313 was served by the Cursor extension
marketplace for eleven hours and reached ~5,000 machines: the artefact was not produced by Anthropic
at all, and the marketplace had no way for a user to tell. That is the failure a transparency log and
*required* verified provenance exist to prevent — the two halves most publishing systems skip.

**3. It says nothing about what the code may DO.** The same incident is the illustration: even a
correctly signed extension ran unsandboxed and wrote `~/.ssh/authorized_keys`. Attestation is about
authenticity; confinement is about capability. Pi Central answers the second one for **sessions**
(the Safehouse profile) and not for **itself** — the orchestrator runs with the user's privileges by
design, because it is the thing that spawns the sandbox. A malicious release of Pi Central would not
need an exploit.

So the honest summary: provenance makes a **tampered** tarball detectable. It cannot make a
**genuinely malicious** release safe, and it is not checked unless someone asks.

## The changelog is a summary, not a transcript

Sections are **one line per change, with the issue number**. No rationale.

That rule arrived late and cost real rework: the Unreleased section had grown to 1,795 lines for 68 changes —
1,915 characters per entry — because every PR appended its reasoning to the changelog instead of leaving it in the
PR. *"Nobody will read that. Changelog needs to be scannable."*

The reasoning is not lost: it is in the commit messages, the PR bodies, and `DESIGN.md`. A changelog answers
*"what changed between these versions"*, which is a different question from *"why is it like this"*.

**A released section may be rewritten, but never extended.** `released-immutable.test.mjs` used to compare each
section byte-for-byte against its tag; it now asserts that no released section gains an **entry** or an **issue
reference**, with the shipped counts in `scripts/released-sections.json`. The narrower invariant is the one that
still matters — an entry added after a release describes code that is not in that tarball — and it leaves room for
the compression above, which rewrote published sections on purpose.

Note what that means: the **published GitHub Releases keep the full bodies** (0.2.0 is 35,000 characters), so the
timeline linked from this repository is now deliberately terser than what npm shipped. That is a documentation
choice, recorded here so it reads as one.

## Rolling back

Releases are append-only. `npm unpublish` is available only for a short window, breaks anyone who
already resolved the version, and is not the answer here.

1. **Mark the bad version so nobody installs it:**

   ```bash
   npm deprecate pi-central@<bad-version> "Broken: <what is wrong>. Use <good-version> instead."
   ```

   A deprecation warning is printed on install and does not remove the artifact, so existing installs
   keep working and new ones are warned.

2. **Revert the change and publish a patch**, following the steps above. The fix is the release; the
   deprecation only buys time.

3. **Record it.** `npm deprecate` also applies to a range, which is useful when several versions share
   a defect.

If a release is bad enough that a revert tag is needed, tag it and say so in the release notes rather
than deleting anything — the history of a mistake is more useful than a tidy release list.

## What is not automated, and not claimed

- **The artifact is not run.** CI dry-runs the publish so the tarball's file list is reviewed on every
  pull request, but "the right files are in the box" is not "the box works". Installing the published
  version and using it is `verified/manual`, tracked on the packaging and update issues.
- **No release is signed with a hardware key.** The git tag is whatever the repository's signing rules
  require; the *artifact's* integrity comes from the npm provenance attestation, which is the
  mechanism that actually covers the tarball.
