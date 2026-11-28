# Increment 9 — Portable: a sandbox backend, and the two platforms it must serve

**Goal:** a person on Linux can run Pi Central with per-session confinement and an agent-owned
credential identity, and a person on macOS keeps exactly what they have today.

**Milestone:** `Increment 9 — Portable` · **Opened from:** [#303](https://github.com/sven1103-agent/pi-central/issues/303),
[spikes/platform-independence/](../spikes/platform-independence/README.md) · **Status:** proposed — not
started, and the first slice is a decision rather than code.

> **Lost?** [PLATFORM-INDEPENDENCE.html](PLATFORM-INDEPENDENCE.html) is a single page that explains
> this whole increment with diagrams — what is measured, what is planned, what is still unproven — for
> reading when the pieces have drifted apart. Open it in a browser.

## Why this is an increment and not a task

The spike settles the question in the *title* of #303 — is the dependency the sandbox backend or the
product? — and answers it: **the product is portable, and the boundary is a backend decision.** Five
findings, each measured, each with a runnable check under
`spikes/platform-independence/harness/` (33 assertions across five scripts, all passing):

| Finding | Consequence |
|---|---|
| Our deny set has a kernel-enforced equivalent on Linux through a **mount view**, not a policy rule | a port does not weaken the boundary — it changes where a deny is written |
| Dogwood is a **policy engine behind** a kernel boundary; SBPL **is** the boundary | the two are not substitutes, so "policy language" was never the cost |
| Box drives `sandbox_init` on macOS — **the same kernel primitive Safehouse uses** | a port keeps Seatbelt on macOS; nothing is traded away there |
| Box has **no keychain source**, and does not route the `gh` token for `git push` | the keychain is *deleted*, in a specific order, not ported |
| The "`pi` doesn't run on Linux" line predates the fix it describes | the last blocker is a **command**, not a design question |

What the spike did **not** settle, and will not pretend to: whether `pi` starts in a box on Linux,
whether a started box confines a unix socket, and whether Box keeps `pi`'s stdio byte-clean for JSONL
framing. Those are slices 9-2, 9-3 and 9-4, and **no ADR can be written honestly until 9-2 answers** —
which is why 9-1 is a decision *owned* early but *closed* last, after the evidence it needs exists.

## The property this increment must not lose

Stated once, because every slice is measured against it. From [PRINCIPLES.md](PRINCIPLES.md) 1 and
[ADR-0002](decisions/0002-per-session-sandbox.md):

- **Deny by default.** Not "deny the list we thought of".
- **One sandbox per session**, never a union of workdirs.
- **The agent acts as itself**: its own credentials, the host's denied.
- **A deny that binds the agent's own file tools**, not only a shell it starts. This is the property
  the Linux design relocates rather than removes, and it is the one a port is most likely to lose
  silently.

The last row is the increment's real risk. Box's `policy.dw` rules bind the box's shell and Python;
the agent's own file tools follow the profile's filesystem lists. A port that wrote denies only in
`policy.dw` would look migrated and be open. That is [C15c](../docs/CONSTRAINTS.md) reproduced by a port.

## Slices

Each is one pull request, and each can fail. Ordered so that no slice depends on an unmeasured claim.
The `verified/*` column is the repository's own vocabulary ([INCREMENTS.md](INCREMENTS.md)) and says
how "done" will be demonstrated — because "done" is otherwise ambiguous.

**9-1 is the decision, and it is the only slice that is first and last.** It is opened first because
writing the interface down is what keeps the following slices from each inventing one, and closed last
because an ADR that names a backend must cite 9-2's and 9-3's measurements. Its *status* moves from
"proposed" to accepted in one direction only — an ADR cannot be half-accepted, which is why the row
says "opened first, closed last" rather than "first".

| # | Slice | Evidence | How it is verified | State |
|---|---|---|---|---|
| 9-1 | **Is a second backend worth defining?** An ADR that either defines the boundary or declines the port with a reason | [ADR-0020](decisions/0020-a-sandbox-is-a-defined-boundary.md), citing this increment and the spike | `kind/decision` — reviewed, not tested | **Accepted** — both blocking measurements reported |
| 9-2 | **Does `pi` start in a box on Linux?** The probe, run on a hosted ARM64 runner | a workflow run with its exit status and both stdio files | `verified/measured` — an exit status | proposed |
| 9-3 | **Does a started box confine a unix socket?** The one deny with no rule-shaped counterpart | a probe that reports `REFUSED`, beside a control that connects | `verified/manual` — needs a Linux host | proposed |
| 9-4 | **Does Box keep `pi`'s stdio byte-clean?** One JSONL frame in, one parseable line out (C7) | a parse assertion, not a screenshot | `verified/auto` once scripted | proposed |
| 9-5 | **The backend interface**: argv, an order-independent policy, and what the policy covers | a type and an invariant test that a second backend satisfies | `verified/auto` — a test that a weak backend fails | proposed |
| 9-6 | **The keychain is retired in the right order**: command-keys removed, then `keychain.ts` deleted | C13's warning gone, and a session that still reaches a model | `verified/auto` + `manual` (a live model call) | proposed |
| 9-7 | **The Linux backend, behind the interface** | a session on Linux confined, with a deny proven against a live session | `verified/manual` — a plain terminal on Linux | proposed |
| 9-8 | **`capabilities.ts` survives its subject**: the two-way diagnosis without a keychain | the same tests, keychain finding removed, five findings intact | `verified/auto` | proposed |
| 9-9 | **A Linux machine says what it is running**: `--check-config` states the backend and its limits | the output, on both platforms | `verified/manual` — two hosts | proposed |
| 9-10 | **The GitHub identity survives the port**: the `gh` token and signing still work, or say why not | a commit pushed as the agent against the real remote | `verified/manual` — needs a real remote | proposed |
| 9-11 | **The policy is configurable, and only downward**: a shipped `solo` profile, an installation overlay that narrows freely, and a widening that is refused rather than merged | a test where an overlay that widens is **refused**, beside one where narrowing is accepted | `verified/auto` — a refusal is testable | proposed — [POLICY.md](POLICY.md) |

**Slice-to-story map**, so no story is left without work and no slice without a reason:

| Story | Slices |
|---|---|
| US-P1 — run on Linux with real confinement | 9-2, 9-3, 9-7 |
| US-P2 — the macOS boundary stays as strong | 9-5, 9-7 |
| US-P3 — the keychain stops being a gauntlet | 9-6 |
| US-P4 — the GitHub identity still works | 9-6, 9-10 |
| US-P5 — never surprised by which isolation I got | 9-9 |
| US-P7 — the policy is mine, and I may only tighten it | 9-11 |
| US-P6 — the decision is recorded | 9-1 |

9-11 exists because the plan was wrong about ownership: it treated the deny set as Pi Central's to
define, and an organisation that must route model traffic through its own gateway cannot adopt a product
whose policy it cannot change. The shipped profile is an **opinion**, named `solo`; the overlay is the
customer's; and a widening is refused rather than merged. [POLICY.md](POLICY.md) records the measurement
that decided a project file cannot be trusted with it.

9-10 exists because the map found it: US-P4 had no slice of its own, and the measured finding it rests
on — Box does not route the token for `git push` — is the opposite of what the spike first assumed. A
story with no slice is how a plan quietly drops a requirement.

**Which slices can be closed by a stranger on any machine.** 9-1, 9-5 and 9-8 are ordinary code and
review work. 9-2 and 9-4 need a hosted runner, which this repository already has. 9-3, 9-6, 9-7 and
9-9 need a **Linux host with a plain terminal**, which is the same class of evidence this project
already labels `verified/manual` and refuses to fake — the honest consequence being that the increment
cannot be closed by CI alone, and should not pretend otherwise.

## Non-goals of the whole increment

Stated once so no slice is argued about later.

- **Windows.** Not measured, not designed, and Box names it as neither backend. A port to Windows is a
  separate decision with its own spike.
- **Dropping macOS.** The macOS path keeps Seatbelt; a port that removed it would be a regression, and
  [BOUNDARY.md](../spikes/platform-independence/BOUNDARY.md) exists to make that non-negotiable.
- **Degraded mode as a default.** `direct` mode stays opt-in and stays labelled `NO ISOLATION` (#303
  option D is refused, in the ADR, with the reason).
- **A container as the answer.** Option C names a sandbox product; a container runtime is a *different*
  backend with a different credential story, and mixing the two in one increment is how neither gets
  finished.
- **Feature parity on day one.** A Linux backend may ship with the file and network grants and *without*
  the sidecar, the OS action, or the icon. Those are named as absent, not silently missing.
- **A GUI on Linux.** The orchestrator and the browser UI; the desktop shell is ADR-0013's concern and
  is not required for a Linux session to run.

## The risk, and the regression pin

**The risk is a port that looks confined and is not.** Two shapes, both observed in this repository's
history: a deny written where nothing reads it (C15c), and a deny that binds the shell but not the
agent's own tools.

**The pin is a negative test.** Every slice that touches confinement must add a probe that *fails* on a
permissive configuration before it passes on a strict one — the same shape as the existing
`fragment.test.ts` ("a deliberately broken fragment DOES report a syntax error") and
`spikes/ui-sidecar/RESULT.md`'s run 2. A confinement claim with no permissive run beside it is not
evidence.

## How this increment ends

Either:

- **an ADR that accepts a second backend**, and 9-6 → 9-9 delivered behind it, with a Linux session
  proven confined by a live probe; **or**
- **an ADR that declines the port**, with the measured reason and what would change it — in which case
  9-2 → 9-4 are still worth landing, because they answer "how bad is macOS-only?" with a number rather
  than an assumption, and the three checks in `spikes/platform-independence/harness/` become the
  repository's standing evidence.

What is **not** an acceptable ending: leaving #303 open with the spike's findings unactioned. The spike
was finished so the decision could be taken, not so it could be re-researched.
