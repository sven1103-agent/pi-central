# Phase 0 — isolation verification result

**Status:** ✅ **PASSED** — 12/12 checks
**Date:** 2026-06-25
**Environment:** macOS, Pi `1.4.0`, Agent Safehouse `0.12.0`, `node v26.12.1`
**Harness:** the Phase 0 spike script (retired at v0.1.0; superseded by
`packages/orchestrator/verify-three.ts`), run from a plain (unsandboxed) terminal

## Why this mattered

This was the single claim the whole architecture rests on
([ADR-0001](../../docs/decisions/0001-out-of-process-orchestration.md),
[ADR-0002](../../docs/decisions/0002-per-session-sandbox.md)). If two sessions could reach
each other's working directories, "one sandbox per session" would be a fiction and Pi
Central would have no reason to exist in its current shape.

## What was tested

Two real sessions, in two working directories, spawned exactly as production would:

```
safehouse --workdir <fixture>/repo-a -- pi --mode rpc --no-session
safehouse --workdir <fixture>/repo-b -- pi --mode rpc --no-session
```

Each probe was issued **through the model-facing `bash` tool inside the sandbox** — the
same path a model-generated command takes — not by the orchestrator. `composePolicy` was
reused from the prototype's policy module (kept in git history; the product now lives in
`packages/orchestrator/src/policy.ts`), so the policy under test is the policy the product
will use.

## Results

| Check | A | B |
|---|---|---|
| reads its OWN working directory | PASS | PASS |
| reads the OTHER working directory | PASS (denied) | PASS (denied) |
| writes its OWN working directory | PASS | PASS |
| writes the OTHER working directory | PASS (denied) | PASS (denied) |
| lists the OTHER working directory | PASS (denied) | PASS (denied) |
| **no file appeared in the other workdir** (verified from outside the sandbox) | PASS | PASS |

The last row matters: a `touch` can report failure while still creating a file. Confirming
absence from outside the sandbox is the check that cannot be fooled.

## Incidental findings

**1. Ancestor directories are listable, by design.** Safehouse emits `file-read*` on
*literal ancestors* of the workdir up to `(literal "/")`. Its source explains why:

> Agents (notably Claude Code) call readdir() on every ancestor of the working directory
> during startup. If only file-read-metadata (stat) is granted, the agent cannot list
> directory contents, which causes it to blank PATH and break. Using `literal` (not
> `subpath`) keeps this safe: it grants read access to the directory entry itself (i.e.
> listing its immediate children), but does NOT grant recursive read access to files or
> subdirectories under it.

So the fixture root can be listed from either session, but its other children cannot be
read. The harness now distinguishes these: ancestor listing is an `INFO` line, while
reading a **non-ancestor sibling's contents** is an asserted check. Conflating the two
would have produced a false failure.

**2. The trailing `NEST` probe confirms C1 from inside a real session.** Running
`sandbox-exec` from within a sandboxed session fails, which is the mechanism that makes
"one sandbox per session" necessary rather than merely convenient. This is now reported as
`INFO`, and would flag loudly if it ever started succeeding — that would mean C1 had
changed and a simpler architecture might be possible.

**3. Fixture placement was load-bearing.** The base profile grants `/tmp` and
`/var/folders` globally. Fixtures placed there would have been mutually readable *for
reasons unrelated to the workdir grant* — a false pass that would have looked like a
catastrophe. The harness therefore uses `$HOME` and refuses to run under those paths.

## Reproducing

```bash
# from a plain terminal — NOT inside Safehouse, NOT from inside Pi
cd pi-central
node packages/orchestrator/verify-three.ts   # the supported harness, a superset of this one
```

The harness refuses to run when `sandbox-exec` cannot apply a policy, because every check
would be meaningless (C1). It cleans up its fixtures unless given `--keep`.

## Consequence

Phase 0 passes, so Phase 1 may proceed. The architecture is not merely plausible: each
session is confined to its own working directory, enforced by the OS, verified through the
model-facing tool path.

This verifies **isolation**. It does not verify the wider product: `contextUsage`, resume
behavior, and the UI remain untested. Those gaps were recorded in the prototype's README, which
was removed once the product replaced it; the open items now live in `docs/ROADMAP.md`.
