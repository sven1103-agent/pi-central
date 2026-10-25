# Contributing

Pi Central is a local, single-user tool. Contributions should preserve its two invariants:
**per-session sandboxing** and **an orchestrator that holds no untrusted content**.

## Before you change anything

Read, in this order:

1. [docs/CONSTRAINTS.md](docs/CONSTRAINTS.md) — the hard limits (C1–C8). Most "obvious"
   designs are ruled out here.
2. [docs/decisions/](docs/decisions/) — why the architecture looks the way it does.
3. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — components and trust boundaries.

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
