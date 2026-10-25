# Increments and slices

How work is organised in Pi Central.

An **increment** is a shippable slice of product value — a state of the tool that is coherent on
its own, plus the documentation and verification that make it trustworthy. Increments are GitHub
**milestones**.

A **slice** is one unit of work inside an increment: sized to land in a single pull request, and
verifiable without waiting for anything else in the increment. Slices are GitHub **issues**.

The point of the split is that work can proceed programmatically — pick an issue, do it, and know
when it is done — without re-deriving scope each time.

The live tracker: <https://github.com/sven1103-agent/pi-central/milestones> — increments are
milestones and slices are issues. The label taxonomy and the initial backlog are defined in
`scripts/setup-github.mjs`, which is a bootstrap (it creates what is missing and skips what
exists) rather than a sync: once an issue is open it belongs to whoever is working on it.

## What makes a good slice

1. **It has acceptance criteria that can fail.** "Improve the rail" cannot fail; "the rail shows
   `ctx 82% full` rather than `ctx 82%` at 80% and above" can. A criterion that nothing could
   falsify is not a criterion.
2. **It names its evidence.** A test, a rendered-markup assertion, a measured number, or a
   screenshot. Where a claim cannot be verified in CI (sandbox behaviour, for instance), the issue
   says so explicitly rather than leaving it implied.
3. **It carries its constraint.** If a slice touches isolation, credentials, or rendering, the
   issue links the constraint (C1–C14) or ADR that governs it. These are the places where a
   locally reasonable change is globally wrong.
4. **It is one writer.** Slices that edit the same module in parallel are sequenced, not merged
   into one oversized change.

## Verification vocabulary

Issues use these labels so that "done" is not ambiguous:

| Label | Meaning |
|---|---|
| `verified/auto` | Enforced by the test suite; CI fails if it regresses |
| `verified/manual` | Needs a plain terminal or a browser; a human must confirm and paste evidence |
| `verified/measured` | The issue states a number that must be reproduced (a count, a duration, a ratio) |

`verified/manual` is not a weakness to hide. Several of this project's most valuable findings came
from looking at a screenshot after every automated check had passed — the misleading counts, the
misplaced tool calls, the mislabelled session id. An increment is not done until its manual slices
have been looked at.

## Increment 1 — Verified foundation ✅

**Delivered as v0.1.0.** The premise is proven and the first three layers exist.

| Slice | State |
|---|---|
| Prove the isolation premise (no nested Seatbelt; per-session profiles) | ✅ 12/12 checks |
| Orchestrator core: registry, policy composition, supervisor, RPC framing | ✅ |
| Agent-scoped credentials: identity denied, provider keys as a capability | ✅ live-verified |
| WebSocket transport with a sandbox guard | ✅ |
| UI: scratch-first rail, transcript reconstruction, approval dock, tool trace, history | ✅ 39/39 + live |
| Untrusted-rendering pipeline with a single audited insertion point | ✅ enforced by test |

Two things were deliberately left open and are the first slices of Increment 2: nothing has been
captured visually in the repository (the author's environment cannot run a browser — C1), and the
model/thinking pickers are read-only.

## Increment 2 — Drive a session from the UI

**Goal:** everything a person does to a running session can be done from the dashboard, without
falling back to Pi's terminal UI.

This is the increment where the dashboard stops being a *viewer* and becomes a *control surface*.
It is ordered after Increment 1 because the controls are only meaningful once the session state
they act on is trustworthy.

Slices: model and thinking-level pickers driven by `get_available_*`; syntax highlighting;
compaction and retry banners; `steer`, which needs a protocol addition first; screenshot capture
for the README.

## Increment 3 — Files alongside the session

**Goal:** see and touch the files a session is working on, without leaving the dashboard, and
without weakening the sandbox.

Constrained by [ADR-0007](decisions/0007-filesystem-access-model.md): browsing happens at the
orchestrator's UID, confined to the session's `cwd`, canonicalized with `realpath` so a symlink
cannot escape. Destructive operations are explicit and confirmed.

## Increment 4 — Fleet ergonomics

**Goal:** a fleet of ten sessions is no harder to run than one.

Ordering, grouping, filtering, bulk state, crash surfacing, export. The rail already orders by
attention; this increment makes that scale.

## Increment 5 — Hardening

**Goal:** the isolation claims are demonstrated, not asserted, against a session that is actively
trying to escape.

Fuzzing the policy composer, testing the boundary with adversarial content, and turning each
finding into an invariant test.

## Out of scope

Recorded in [ROADMAP.md](ROADMAP.md#explicitly-out-of-scope) rather than as issues, so that the
backlog stays honest about what it intends to do.
