# ADR-0020 — A sandbox is a defined boundary, and macOS is merely where the only one runs

- **Status:** Proposed
- **Date:** 2026-11-28
- **Opened by:** issue [#303], slice [#304]
- **Depends on:** [#305] (does `pi` start in a box on Linux) and [#306] (does a started box confine a unix
  socket). Both are **open**, and this record is opened before them on purpose — see *Ordering* below.
- **Related:** ADR-0002 (one sandbox per session), ADR-0010 (the agent owns its credential), [C10]
  (Safehouse is macOS-only), [C13] (provider keys need a reachable keychain), [C15c] (a deny is only
  authoritative relative to the composition), issue [#303] itself
- **Spike:** [spikes/platform-independence](../../spikes/platform-independence/RESULT.md), with seven
  runnable checks under [harness/](../../spikes/platform-independence/harness)

## Context

[C10] records the coupling and names the wrong thing. It says *"Safehouse is macOS-only"*, which is
true of Safehouse and false of what Pi Central actually needs. `safehouse` hard-fails off Darwin
([C10]); that is a statement about **one implementation of a boundary**, not about the boundary.

The question a port turns on is therefore not *"is Safehouse macOS-only"* — it is *"is the thing we
depend on a launch-and-policy backend, or is it the product?"* Issue [#303] asked exactly that, and
the spike answered it: **the product is portable, and what stands between it and Linux is a backend
interface that does not exist yet.**

### What the coupling actually is, measured

This ADR had to correct the spike on its way here, and the correction matters because it changes the
sizing argument. The spike said the port's cost is "four `process.platform` checks across
`packages/`". That is a real measurement of the wrong thing — those checks are the *decisions*, and
the work is in the **mechanism**:

| Surface | Measured | What it is |
|---|---|---|
| `process.platform` in production code | **2** (`app/src/main.ts:1718`, `orchestrator/src/os-actions.ts:152-153`) | two `darwin`-or-quit gates |
| `process.platform` in tests | 3 | two `sandbox-exec` skips, one lifecycle check |
| Production modules naming `safehouse` | **14** | the launch path, the policy composition, the guard, the supervisor, the sidecar |
| Of which own the boundary | 5 files, **1{,}243 lines** (`policy.ts` 327, `fragment.ts` 350, `sidecar-policy.ts` 354, `sidecar-fragment.ts` 122, `sandbox-guard.ts` 90) plus the spawn site in `supervisor.ts` | **the swap** |

So the honest statement is: **two platform decisions, and one boundary implemented against one
backend across about twelve hundred lines of boundary code.** That is a backend swap of real size —
not two lines, and not a re-architecture. Two modules are not "the product is macOS-shaped"; they are where a
platform would be asked a question once it had two answers to distinguish.

### The three findings the decision rests on

Each is measured by a runnable check, because a claim in a design document is otherwise a quotation.

**1. A kernel-enforced equivalent exists on Linux, through a mount view rather than a rule.** Our
filesystem denies become a mount-view overmount, which is *stronger* than a policy rule and is why
the Linux half needs no path matching at all. (`harness/check-translation.sh`: 9 assertions. The
limits are exact-path-only entries, a path that must exist at launch, and no unix-socket action.)

**2. A policy engine is not a kernel boundary, and Box has both layers on both platforms.** This was
the spike's sharpest correction. Dogwood decides *requests* in a trusted process; SBPL *is* the kernel
boundary. They are not substitutes and never were, which retires the idea that "the policy language"
was ever the cost. Box drives `sandbox_init` on macOS — the same kernel primitive Safehouse uses —
so **a port does not trade Seatbelt away on macOS**. (`harness/check-layer-distinction.sh`: 6 arms,
including a binary-strings check for `sandbox_init`.)

**3. The credential model is simpler, not harder — and the keychain is deleted, not ported.** Box has
no keychain source. Provider keys become a route and are injected as the request leaves, which is
*closer* to ADR-0010 than the current design. The order matters and is measured: pi **prefers** a
configured `!security` command-key over a route's environment variable, so the configuration must
change **before** `keychain.ts` is deleted. (`harness/check-keychain-claim.sh`,
`harness/check-precedence.sh`: 3 precedence arms, A/B/C.)

### What is not measured, and therefore not decided

Whether `pi` starts inside a box on Linux ([#305]), whether a started box confines a unix socket
([#306]), and whether Box keeps `pi`'s stdio byte-clean for JSONL framing ([#307], [C7]). **No
amount of reading substitutes for the first one**, and this record does not pretend otherwise. The
"pi doesn't run on Linux" line in the pack README is *stale* — the executable-memory fix predates the
README's last edit (`harness/check-pi-linux-claim.sh`) — but *stale* is not *works*.

## Decision

**A second sandbox backend is worth defining, and Pi Central's isolation is defined as an interface
rather than as Safehouse's command line.**

The interface has **three** parts. The spike found three, not two, and the third is the one a port is
most likely to lose silently.

1. **An argv** — the concrete command that starts a session under the boundary.
2. **A policy whose `forbid` wins regardless of order** — an exception to a broad permit is a
   `forbid`, never a later `permit`. This is why "an appended fragment" is the wrong abstraction:
   `fragment.ts` exists to restate Safehouse's narrower grants at matching specificity because SBPL
   resolves conflicts by *last matching rule*. `forbid`-beats-`permit` is order- and
   specificity-independent, and a backend that cannot offer it must say so.
3. **A statement of which file operations its policy covers** — specifically, *whether a rule binds
   the agent's own file tools or only a shell the box starts.* This is the property this increment
   must not lose, and it is [C15c] reproduced by a port if the backend is silent about it. Box
   confines in two places, and a file rule in its policy "applies only to the box's shell and to
   Python in the box" — so a port that wrote denies only in the policy would look migrated and be
   open.

A backend that cannot deny a unix socket must **say so**, rather than accept a parameter named
`deny` and drop it. Today's two independent SSH-socket layers ([C11] plus the fragment) become one
under Box, via a sanitized environment; that is a real, stated reduction.

**And the ADR declines to name a backend.** It defines the boundary and sets the admission test; which
implementation passes it is [#305]'s and [#306]'s business. Naming one now would be deciding on
evidence that does not exist yet, which is the failure this record's own *Context* sections describe
twice.

### The admission test a backend must pass

Stated so a future backend is judged rather than argued about. Each row can fail.

| Requirement | Because |
|---|---|
| A deny binds the agent's own file tools, not only a shell | [C15c]; the increment's stated risk |
| `forbid` beats `permit` regardless of rule order | the SBPL last-match class of defect is not reintroduced |
| The backend states which file operations its policy covers | "looks migrated and is open" |
| An unsupported deny is **refused at configuration time**, not ignored at run time | `check-translation.sh` check 2: a validator that accepts a broken policy says nothing about a good one |
| Executable memory is available to the session (JIT runtimes) | `pi` is a V8 process; this is [#305] |
| The session's stdio is byte-clean for JSONL framing | [C7] |
| No credential is readable by the agent that ADR-0010 says it must not have | ADR-0010 |

### Ordering

**Opened first, closed last.** It is opened now because writing the interface down is what stops
[#305]–[#313] from each inventing one. It moves `Proposed` → `Accepted` **only** when [#305] and
[#306] report, and an ADR cannot be half-accepted, which is why this status is one word rather than a
list of completed criteria.

If [#305] fails, this record is **not** silently abandoned and does not become "proposed, pending more
research". It moves to `Rejected`, with the measured reason, by the rule below.

### What would change this decision

- **[#305] exits 133 with a V8 or `pkey_mprotect` abort** even after the executable-memory fix: then
  no backend on that platform can host `pi`, and the decision is *macOS-only, by measurement*. The
  specific observation that would reopen it: an upstream release whose behaviour document and whose
  runtime agree, demonstrated by the probe exiting 0.
- **[#306] reports that a started box cannot refuse a unix-socket connect** and no sanitized
  environment substitutes: then the port loses a deny we have today, and the decision becomes
  *macOS-only until that deny is expressible*.
- **A backend that passes the admission test but cannot state its file-operation coverage** is not a
  candidate, however well it runs. Coverage is a precondition, not a follow-up.

## Consequences

**What this buys.** [C10] stops being a product constraint and becomes a statement about one tool.
"Support Linux" stops being a re-architecture and becomes a bounded piece of work with a name. The
three-part interface is a better description of what we already do than "append a fragment to
Safehouse's output" was — it names the property (`forbid` wins) instead of the mechanism. And the
keychain's deletion is scheduled **after** the configuration change, which is the order the
measurement demands and the reverse of the intuitive one.

**What it costs, stated plainly.**

- **A second backend is a second thing to keep correct.** Two implementations of a security boundary
  is more surface than one, and the mitigation is that the admission test is a test rather than a
  paragraph.
- **The boundary moves into configuration for provider keys.** Box injects a credential per request,
  so the key becomes a property of the route rather than of the agent's store. Stronger for
  ADR-0010's purpose, and it relocates the credential boundary from `agent-store.ts` to the profile.
- **Today's two independent SSH-socket layers become one** under a backend with no unix-socket
  action. Stated, not discovered.
- **The filesystem lists are exact-path only** on the Box backend. We fit *by luck of having already
  been fixed* — `~/.ssh` replaced three name patterns precisely because a list fails open. A future
  rule needing a pattern cannot be expressed, and must be refused rather than silently dropped.

**What this does not decide.** The port's size beyond the boundary, the UI (nothing measured suggests
it moves), and whether Box is the backend. Box is a *candidate the spike examined*, not the decision.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| **A — stay macOS-only** | Defensible, and it is what [C10] implies. Rejected because it rests on a claim about Safehouse, not about the boundary, and because the admission test above is answerable in one command. Staying is a *default*, not a decision, until [#305] is run. |
| **B — define the backend interface, name no backend** (chosen) | The decision the evidence supports today. It unblocks the work that does not depend on [#305] — the interface, `capabilities.ts`, the keychain order — without pre-committing to an implementation. |
| **C — adopt Box as the backend** | Premature. [#305] and [#306] are unmeasured, and this record's own Context is two examples of what happens when a document decides ahead of a measurement. Box remains the leading candidate and is the one the spike examined. |
| **D — degraded mode off macOS** (run `direct`, labelled `NO ISOLATION`) | Refused. It ships a session with no boundary under a label the agent and the reader will both learn to ignore. [C10]'s direct mode exists for *feasibility testing*; a product mode that is silently unsafe is the one outcome worse than not porting. |
| **Swap Safehouse for a portable library** in place, keeping today's call sites | This is B without the admission test: it fixes the language and never asks whether a deny binds the agent's own file tools. It is how a migration looks finished and is open. |

## Enforcement

- The admission test's rows become assertions in the backend's own tests, not prose
  (slice [#308]): a deliberately weak backend **must fail** the invariant test, which is how
  `fragment.test.ts` already proves its broken fragment reports a syntax error.
- `harness/check-layer-distinction.sh` stays runnable so "Dogwood is not a kernel boundary" cannot be
  quietly re-forgotten in a future argument about this design.
- [C10] and the README requirements table are corrected in this slice to name the *pair* (pi, sandbox
  backend) rather than Safehouse, because the measured reason is wider than the named one.

[#303]: https://github.com/sven1103-agent/pi-central/issues/303
[#304]: https://github.com/sven1103-agent/pi-central/issues/304
[#305]: https://github.com/sven1103-agent/pi-central/issues/305
[#306]: https://github.com/sven1103-agent/pi-central/issues/306
[#307]: https://github.com/sven1103-agent/pi-central/issues/307
[#308]: https://github.com/sven1103-agent/pi-central/issues/308
[#313]: https://github.com/sven1103-agent/pi-central/issues/313
[C7]: ../CONSTRAINTS.md
[C10]: ../CONSTRAINTS.md
[C11]: ../CONSTRAINTS.md
[C13]: ../CONSTRAINTS.md
[C15c]: ../CONSTRAINTS.md
