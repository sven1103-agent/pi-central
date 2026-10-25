# Contributing

Pi Central is a local, single-user tool. Contributions should preserve its two invariants:
**per-session sandboxing** and **an orchestrator that holds no untrusted content**.

## How work is organised

Work is **increments** (GitHub milestones) containing **slices** (issues). The full definition,
including what makes a slice finished, is in [docs/INCREMENTS.md](docs/INCREMENTS.md).

The short version:

1. Pick an issue. Check its **Governing constraints** section and read those first.
2. Its acceptance criteria are the contract. If one of them cannot fail, it is not a criterion —
   fix the issue before writing code.
3. Land it in one pull request, using the repository's PR template.
4. `npm run verify` must pass: typecheck, tests, and documentation references.
5. For a `verified/manual` slice, paste what you looked at. Automated checks passed on every
   defect this project shipped; looking at the result is not optional.

Labels carry the axes that matter: `kind/*` (slice, bug, decision), `area/*`, `verified/*`, and
`priority/*`. They are defined in `scripts/setup-github.mjs` so the taxonomy is reviewable rather
than remembered.

## Before you change anything

Read, in this order:

1. [docs/CONSTRAINTS.md](docs/CONSTRAINTS.md) — the hard limits (C1–C14). Most "obvious"
   designs are ruled out here.
2. [docs/decisions/](docs/decisions/) — why the architecture looks the way it does.
3. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — components and trust boundaries.

## Branch rules

`main` is protected by a **ruleset**, and **the rules apply to administrators too** — so a direct
push is refused by design, not by accident:

```
remote: - Changes must be made through a pull request.
remote: - 2 of 2 required status checks are expected.
remote: ! [remote rejected] main -> main (push declined due to repository rule violations)
```

Land changes through a pull request:

- A pull request is required; **no approving review is required**, because the repository has one
  maintainer and nobody can approve their own work. The gate is CI, not a second person.
- Both checks must pass: **`verify`** (typecheck, tests, documentation references) and
  **`docs-links`**.
- The branch must be **up to date with `main`** before merging, so what was tested is what lands.
- **Linear history**: squash or rebase, no merge commits.
- Force pushes and branch deletion are refused.
- Unresolved review comments block the merge.

The settings live in [.github/ruleset.json](.github/ruleset.json) and are applied by
`node scripts/setup-github.mjs`. That script refuses two silent failure modes: a required check
name no workflow produces (which blocks every merge forever without erroring), and an
`enforcement` of anything other than `active` (which reports as configured while enforcing
nothing).

To relax any of this, change the file and re-apply. It is recorded rather than clicked.

### Why a ruleset and not a classic branch-protection rule

Both are supported and they layer. The reason this repository uses a ruleset is specific:
`GET /repos/{owner}/{repo}/rules/branches/{branch}` — the modern way to ask "what protects this
branch?" — **does not report classic branch protection at all.** A correctly protected branch
therefore reads as *no rules* to anyone checking there, which is exactly the wrong conclusion to
hand someone.

Rulesets also support named bypass actors, should an emergency valve ever be wanted; today there
are none, so the rules bind administrators as well.

## Rules

- **Do not relax sandboxing.** Never pass `--allow-workdir-config-writes`,
  `--allow-profile-writes`, or `--enable=wide-read` for supervised sessions.
- **Never run untrusted content in the orchestrator.** No `eval`, no shell interpolation
  of transcript or file content, no `spawn` of anything not hard-coded. Model output is a
  string for display.
- **Never grant the orchestrator a union of workdirs.** See ADR-0002.
- **Verify constraints, don't assume them.** If you rely on C\\* being true, cite it and,
  where practical, add a test that fails loudly if it stops being true.
- **One live process per `(sessionPath, cwd)`.** See ADR-0004.

## Changing a decision

Do not edit an accepted ADR to say something new. Write a superseding ADR and mark the old
one `Superseded by ADR-NNNN`. Premises can expire: re-verify C1–C8 when Pi or Safehouse
is upgraded.

## Commits

Conventional-ish, imperative subject, lowercase after the type:

```
docs: add session identity ADR
spike: verify per-session profile independence
```

## Verification

Nothing about isolation should be asserted without a test. The Phase 0 harness in
[docs/SANDBOX.md](docs/SANDBOX.md#verification-harness) is the reference: two sessions,
two cwds, cross-access must fail.
