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
   the tag and the manifest disagree, builds the artifact, publishes it, and creates the GitHub
   Release.

Nothing is published from a laptop. A local `npm publish` would produce an artifact with no
attestation and no CI record of where it came from.

## What the release workflow refuses to do

- **Publish a tag that disagrees with `package.json`.** A tag that disagrees with the artifact is how
  the two start lying about what shipped. It fails rather than helpfully publishing one under the
  other.
- **Release with an empty `## [Unreleased]`.** This is `--release` mode, and it is what stops a
  release shipping undocumented changes.
- **Publish a version with no CHANGELOG section.** `scripts/release-notes.mjs` exits non-zero rather
  than attaching an empty body — a release with blank notes goes unnoticed.

## Publishing uses OIDC, not a stored token

The workflow declares `id-token: write` and references **no GitHub Actions secret at all**. The
runner mints a short-lived OIDC token, and npm exchanges it for a publish credential under a
**trusted publisher** configured on the package's npm page. A stored token is a credential that has
to be rotated, can be exfiltrated by a compromised dependency, and outlives whoever created it;
`scripts/release-workflow.test.mjs` fails if one is reintroduced.

**One-time setup, by a maintainer, before the first release:**

1. Claim the package name on npm, or create it with the first publish.
2. On the package's settings page, add a **trusted publisher**: GitHub Actions, repository
   `sven1103-agent/pi-central`, workflow `release.yml`.
3. Leave any publish token out of the repository's secrets. There is deliberately nothing to add.

The workflow installs a current npm because trusted publishing needs **npm ≥ 11.5.1** and the runner's
bundled version is older.

## Provenance, and checking it

`npm publish --provenance` attaches a signed attestation tying the tarball to the commit and workflow
run that produced it. To check an installed version:

```bash
npm audit signatures
```

This is the difference between "the maintainer says this is the code" and "this can be verified".

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
