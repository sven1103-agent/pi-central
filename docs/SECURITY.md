# Dependency vulnerability management

How Pi Central finds out that something it ships has a known vulnerability, where that shows up, and
what a red result means.

Driven by [`.github/workflows/dependency-vulnerability-scan.yml`](../.github/workflows/dependency-vulnerability-scan.yml).

## What is scanned, and what deliberately is not

**The release tree only.** Pi Central ships a bundled orchestrator (`bin/pi-central.js`) and a built UI
(`dist/ui`), and both are audited as the packages that end up in them:

| Ships as | What is in it |
|---|---|
| `bin/pi-central.js` | the orchestrator, plus exactly one external dependency, `ws` |
| `dist/ui/assets/*.js` | Vite's bundles of `react`, `shiki`, `markdown-it`, `dompurify` |

**Development dependencies are excluded, and that is the point.** Pi and TypeScript are
devDependencies (ADR-0005): Pi is `import type` only, and `scripts/build-package.mjs` produces the
bundle without it. Every vulnerability this repository has had was in that toolchain — `undici` and
`minimatch`, reached through `pi-coding-agent` — and none of it ships. A scan over the whole install
would report real CVEs in code no user runs, on the branch a release is cut from. That is noise with a
security badge on it: a gate people route around, and a badge that says 9 when the answer is 0.

**The inventory is built from `package-lock.json`, not from `npm sbom --omit=dev`.** That command was
measured to omit `ws` — the only external in the shipped bundle — because a dev-only package also
requires it. `scripts/production-sbom.mjs` derives the set from the lockfile's `dev` flags instead, so
it cannot inherit that omission. Its header records the measurement.

### What a green result does not mean

It does not mean the code is free of vulnerabilities. It means the **package inventory** of the
shipped tree matches no known advisory. A CVE inside `dist/ui/assets/index-*.js` is invisible to a
package scanner, because Vite has flattened the library into a bundle. That question belongs to CodeQL,
and the report says so on every run rather than leaving it to be assumed.

### The development toolchain is watched by Dependabot, not by the gate

Excluding devDependencies is correct — they do not ship — and it leaves a hole worth naming: the gate
says nothing about a CVE in Pi's own dependency tree, and when this scan was added the full install had
**9 fixable findings**, all `undici`/`minimatch` under `pi-coding-agent`.

That hole is covered by [`.github/dependabot.yml`](../.github/dependabot.yml), which raises weekly
upgrade PRs for `npm` and `github-actions`. Two limits, stated rather than implied:

- **Version updates are not CVE reports.** Dependabot opens a PR when a newer version exists, not when
  an advisory is published against the version already installed. CVE detection needs **Settings →
  Code security → Dependabot alerts**, which is a repository setting and cannot be enabled from a file.
- **A Pi update is not a routine merge.** `pi-coding-agent` is pinned exactly because the RPC surface is
  verified against one version (see `docs/CONSTRAINTS.md`); a bump needs a typecheck, a re-check of the
  constraints measured against it, and a real sandboxed session, which CI cannot run (C10).

## Where the results appear

| Surface | What it shows |
|---|---|
| **Actions → dependency-vulnerability-scan → Summary** | Severity counts and the findings table, with the fixed version for each |
| **Security → Code scanning** (filter: `dependency-scan`) | Per-finding SARIF alerts, triageable in GitHub |
| **Workflow artifacts** | `grype.json`, `grype.sarif`, `dependency-vulnerability-report.md`, `pi-central-sbom.json` |
| **README badge** | current total, and whether any are critical or high |

## The gate

`scripts/vulnerability-gate.mjs` fails on **`main` only**, on findings at or above **High** — and only
when a **fixed version exists**.

- On a **pull request** the scan reports, uploads SARIF and writes the summary, and does not fail. A new
  advisory against an unrelated dependency must not block a documentation fix; the badge and the
  Security tab are what make it visible.
- On **`main`** it fails, because `main` is the branch the badge describes and the branch a release is
  cut from.
- A finding with **no fix** never blocks, at any threshold. No pull request could clear it, so failing
  would block the repository until upstream ships a patch — the fastest way to get a gate switched off.
  It is still reported, with its `fix state`.

A daily scheduled run exists because advisories are published against versions that are already in the
lockfile: without it, a clean tree is only known-clean until somebody pushes.

## Fixing a finding, or accepting it

1. **Upgrade.** For the shipped tree that is `ws` (root `package.json`) or a UI library
   (`packages/ui/package.json`). Raise the range, run `npm install` to regenerate the lockfile, and
   re-run the scan.
2. **If the fix is transitive,** add an `overrides` entry for the offending package in the root
   manifest rather than pinning a dependency of a dependency by hand. Measured: `overrides` for
   `undici` and `minimatch` cleared all nine findings that Pi 1.4.0's toolchain carried, and the suite
   stayed green.
3. **Accept the risk** only when upgrading is the wrong call right now, and record it in
   [`.github/grype.yaml`](../.github/grype.yaml) with a reason, a ticket reference and `exp:YYYY-MM-DD`.
   Never lower the threshold to make a result pass — the threshold is what the badge means.

An accepted risk still appears in the report under **Accepted risks**, because a suppression nobody can
see is indistinguishable from a finding nobody made.

## Why the badge is a branch and not a gist

The badge is a shields.io *endpoint* badge reading a JSON file. The common arrangement writes that file
into a GitHub Gist with a personal access token; this repository publishes it to a data-only `badges`
branch instead, using the workflow's own `GITHUB_TOKEN`.

The reason is the same one that shapes the release workflow: a classic PAT with `gist` scope is a
long-lived credential that can write to an account outside this repository, and it must be rotated and
can be exfiltrated. `scripts/release-workflow.test.mjs` forbids a stored-credential reference in **any**
workflow, and this pipeline keeps that invariant rather than weakening it. A branch push with
`contents: write` is scoped to this repository and expires with the run.

That write permission lives in a **separate `badge` job**, not in the scanner. The first version put
the push inside the scan job, which declares `contents: read`, and the first run on `main` failed with a
403: a job-level `permissions:` block *replaces* the workflow-level one, so the push got the read-only
token. The fix was not to widen the scanner — it runs `npm ci` and a third-party action — but to move
the one step that writes into a job that installs nothing and executes no third-party code.
`scripts/vulnerability-workflow.test.mjs` asserts both halves: the badge job can write, and the scan job
cannot.

The badge updates from `main` only, and never from a pull request: it describes `main`, so a PR writing
it would make the default branch's README report a branch that does not exist.

### What it cannot show

The badge update is the **last** step, and it runs only when the gate passes. A run that fails the gate
leaves the badge at its previous value, so a red badge is a state that has to be *reached* — the badge
is not a live alert. The Security tab and the workflow summary are the authoritative surfaces; the badge
is a convenience that says "as of the last clean run on `main`".
