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
model/thinking pickers were read-only. The model picker is now real (issue #1); the thinking-level
picker follows.

## Increment 2 — Drive a session from the UI

**Goal:** everything a person does to a running session can be done from the dashboard, without
falling back to Pi's terminal UI.

This is the increment where the dashboard stops being a *viewer* and becomes a *control surface*.
It is ordered after Increment 1 because the controls are only meaningful once the session state
they act on is trustworthy.

Slices: model and thinking-level pickers driven by `get_available_*` (done — issues #1, #2);
syntax highlighting (done — issue #4); compaction and retry banners; `steer` and `clear_queue`
(done — issue #3); screenshot capture for the README.

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

## Increment 6 — Ship it: installable and updatable

**Goal:** Pi Central is a thing you install and update, not only a checkout you run.

Everything so far has been run from a git checkout, with the UI built by hand and the orchestrator
loading TypeScript off disk. That is why the product has been able to improve quickly — and it is
also why there is no artifact, no way to say which version is running, and a manual `git pull` in the
loop when the tool is used to build the tool.

Slices: the distributable artifact (issue #52, **done**); a Settings surface showing the running
build and where it keeps things (#58, **done**); the release workflow — one version source,
a tag, a GitHub Release, a provenance-attested publish (#53); prerequisite checks for `pi` and
`safehouse` (#54); update detection that is off unless enabled (#55); and applying an update — one
explicit action, integrity-verified, refusing while sessions run (#56). The trust model is
[ADR-0011](decisions/0011-distribution-and-update.md); the measured findings behind it — TypeScript
cannot be loaded from `node_modules`, and the product has had zero outbound network calls until now
— are recorded there rather than re-derived per slice.

## Increment 7 — A window you open from the dock

**Goal:** Pi Central has a desktop surface — a dock icon, an application menu, a native folder dialog —
without becoming a second distributable.

Two closures of #184 were possible, and this increment takes the second only after the first ships.
#213 gives a stale page the ability to reload itself when it returns to view, which needs no app and
closes the reload half. What it cannot do is **restart the thing behind the page**: a browser tab has no
way to stop an orchestrator, install a version, respawn it and reload, and "quit the app and reopen"
stays an instruction. A shell can, and it brings the desktop surface with it.

The constraint that decides the shape is that this machine has **no Apple Developer account**. An
ad-hoc signature is free and sufficient to run; notarization is what is lost, and `electron-updater`
refuses to update an unsigned app. So the shell is a **launcher over the installed npm package** and
never the update target, and the npm artifact keeps every property [ADR-0011](decisions/0011-distribution-and-update.md)
gave it. The record is [ADR-0013](decisions/0013-application-shell.md).

| Slice | State |
|---|---|
| A window returning to view re-checks, with a draft guard (#213) | ✅ PR #219 |
| ADR-0013: the shell is a launcher, never the update target (#212) | ✅ this slice |
| A returning window asks for install facts, not a discovery (#220) | open — 356 ms per focus today |
| The shell runs the installed artifact as a supervised child (#214) | ✅ this slice |
| The renderer is locked to the loopback document (#215) | open |
| Close hides, `⌘Q` keeps sessions, the next launch reattaches (#216) | open |
| The shell applies an update: stop, install, verify, respawn, reload (#217) | open |
| `npm run install-app` produces a locally signed app (#218) | open |

Non-goals of the whole increment, stated once: a `.dmg`, notarization, `electron-updater`, a stored
credential in CI, and x64.

## Increment 8 — Configurable: the paths a reader chooses

**Goal:** every setting Pi Central reads can be seen, changed and explained from the app — and on a
machine where the defaults do not work, the app says so instead of failing.

Increment 7 produced three live failures in a row, and none was a coding slip: `HOME is not set`, then
`env: …/node_modules/.bin/pi: Operation not permitted`. Each was **an environment question disguised as a
bug**, each was found by the reader rather than by the build, and each was diagnosable only from a
terminal log. The honest reading is that the app had no surface for the question it was being asked.

Measured gap, at the time this increment was opened: every knob is an environment variable read once by
`config.ts`, and there is **no configuration file anywhere**. A GUI launch has no environment, so the dock
icon is unusable for anyone whose `pi`, `safehouse`, agent root or sessions root differs from the default —
which is most people with a version manager or a non-default Homebrew prefix.

The record will be an ADR for the precedence rule (file, environment, flag, default) and for what the file
may **not** do: widen the sandbox, carry credentials, or touch the reader's Pi environment.

| Slice | State |
|---|---|
| A configuration file with stated precedence, validated once (#223) | open — the decision, first |
| `--check-config`: every path, its value and its source (#224) | open |
| Settings gains a Configuration section (#225) | open |
| First run opens a setup panel that names the fix (#226) | open — absorbs #54 |
| A configuration change states what it invalidates (#227) | open |
| Credential findings become guided repairs (#228) | open |
| Safehouse options and the composed policy become visible (#229) | open |

Non-goals of the whole increment, stated once: writing into a reader's Pi environment (principle 9), any
configuration value that can widen the sandbox past `FORBIDDEN_ENABLE`, and hot-reloading a policy into a
running process — Pi Central cannot change a Seatbelt profile of a live `safehouse` invocation, so
"restart" is the honest answer and the slices say so.

## Out of scope

Recorded in [ROADMAP.md](ROADMAP.md#explicitly-out-of-scope) rather than as issues, so that the
backlog stays honest about what it intends to do.
