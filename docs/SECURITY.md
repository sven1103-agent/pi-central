# Security

Two things worth knowing before reading the vulnerability process below: the one place Pi Central writes code that
another process executes, and why it does.

## Pi Central provisions one extension into the agent directory (ADR-0015)

A running session cannot re-read its resources — Pi discovers extensions, skills, prompt templates, themes and MCP
servers once, at startup — and Pi's only reload entry point is `/reload`, a **built-in TUI command** that Pi
excludes from `get_commands` because it would not execute if sent via `prompt`. An **extension-registered** command
is therefore the only route a subprocess RPC client can take to `ctx.reload()`, so Pi Central installs one.

**An extension runs inside the Pi process with Pi's own OS permissions.** Provisioning one is a trust decision, not a
convenience, and it is the only step in this product where Pi Central writes code that something else runs.

What bounds it:

| Property | Why |
|---|---|
| **One command, one call** | The file registers `pi-central:reload` and its handler is `await ctx.reload(); return;`. Nothing else — asserted by `reload-extension.test.ts`, which fails if a second `registerCommand` or any `import` appears. |
| **A constant, not anything derived** | The source is a string in `packages/orchestrator/src/reload-extension.ts`. No prompt, session, working directory or configuration value reaches it. |
| **Its own directory** | `<agentDir>/pi-central/extensions/reload.js`, so it cannot be confused with the reader's extensions, listed among them, or removed by an action meant for their own. |
| **0600 in a 0700 directory** | A world-writable directory above an executed file would let anything replace it. |
| **Namespaced** | `pi-central:reload`; Pi keeps the first registration, so a reader's own `/reload` command wins and this one never shadows it. |
| **Best-effort** | An agent tree Pi Central does not own (`external` ownership, ADR-0010 §5) is not written to. Provisioning then yields nothing, the session still starts, and the reload control reports that the command is not loaded — instead of reloading nothing and calling it success. |

**What it can do, stated plainly.** As an extension it could — if it were different code — inspect prompts, tool
calls, files, credentials and session history. The protection is that it is thirty lines of constant text with a test
that fails when it grows, not that Pi confines it. Read the file before trusting the reload control; that is the
whole of the assurance.

**When this should go away.** An RPC `reload` command in Pi would remove the installed file entirely. ADR-0015
records the trade-off and both routes, so a later reader does not re-litigate it — and so nobody builds the second
mechanism beside the first.

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
