# Spike: can Pi Central stop being macOS-only?

**Status:** spike finished. Nothing here is implemented, and no decision is recorded yet — see
[RESULT.md](RESULT.md) for the measurements and the shape the decision has to take,
[KEYCHAIN.md](KEYCHAIN.md) for what happens to C13 and ADR-0010 §6, which the first write-up skipped,
and [NEXT.md](NEXT.md) for the four things left and the order they unblock each other.

If you take one thing from this spike, take [DOGWOOD-VS-SBPL.md](DOGWOOD-VS-SBPL.md). The two policy
languages decide different things at different layers — SBPL is the kernel boundary, Dogwood is a policy
engine behind one — and an earlier draft of this spike mistook their comparability for the finding.

Four runnable checks live in `harness/`. Each asserts something the write-ups claim, and each was
written because a claim had already been made once without it:

| Check | What it proves |
|---|---|
| `harness/check-translation.sh` | the deny set loads in Box's policy language, and a broken one is refused |
| `harness/check-pi-linux-claim.sh` | the "pi can't run on Linux" line is older than the fix it describes |
| `harness/check-keychain-claim.sh` | Box has no keychain source, and the `gh` token is not routed either |
| `harness/check-precedence.sh` | pi prefers a configured `!security` key over a route's variable |
| `harness/check-layer-distinction.sh` | the kernel view enforces and Dogwood decides; neither substitutes |

The one question no check here can answer is whether `pi` starts in a box on Linux, because this
machine cannot start a box at all. [harness/linux-probe.yml](harness/linux-probe.yml) is that
experiment as a `workflow_dispatch` workflow; [NEXT.md](NEXT.md) says how to run it and how to read
its three possible outcomes.

## The question

Pi Central's sandboxed mode is macOS-only because its backend is **Safehouse over Seatbelt**.
`docs/CONSTRAINTS.md` states it as C10: `safehouse` hard-fails off Darwin, and the constraint
records that *"'Support Linux' is a backend decision"*.

So: **is the dependency the sandbox backend, or is it the product?** This spike has to answer that
before anyone proposes a port, because the answer decides whether the work is a backend swap or a
re-architecture.

## Prior art to read first

Strands Agents (AWS, open source) has a cross-platform sandbox story, and it is worth reading for
the *shape* of the answer rather than for code to copy:

- Sandbox concept — routes all execution through one environment regardless of which tool started it:
  <https://strandsagents.com/docs/user-guide/concepts/sandbox/>
- Strands Box — kernel-level isolation with a policy layer as the only route out:
  <https://aws.amazon.com/blogs/opensource/introducing-strands-box-ai-agent-sandboxes-powered-by-dogwood/>
- Strands Shell — a sub-millisecond execution environment layered into the deployment:
  <https://strandsagents.com/blog/reduced-cost-better-isolation-more-resilience/>
- The harness quickstart that prompted this spike:
  <https://strandsagents.com/docs/user-guide/harness/quickstart/>

Read them directly. This note is a pointer, not a summary, and a summary of a moving target is how a
spike ends up researching last quarter's design.

## What is actually platform-coupled today

Not just the sandbox. Sort these by how much they cost to move.

A note on the row below that says "policy language (SBPL)": the cost is real, but it is the cost of
*moving the boundary*, not of learning a language. SBPL **is** the macOS kernel boundary; Dogwood is a
policy engine in a trusted process behind Box's own kernel view. [DOGWOOD-VS-SBPL.md](DOGWOOD-VS-SBPL.md)
is the correction, and it is the most important page here.

| Coupling | Constraint / file | Moves easily? |
|---|---|---|
| The kernel boundary itself: SBPL and `sandbox-exec` execution | C10, `docs/SANDBOX.md` | **No** — a different backend means a different kernel mechanism, not merely a different syntax |
| Seatbelt cannot nest | C1, `sandbox-guard.ts` | No — constrains where Pi Central itself may run |
| Provider keys resolved through the macOS Keychain via `security` | C13 | No — needs a different secret store per platform |
| `open -g -R` reveal-in-Finder | `os-actions.ts:152-153` | Yes — one guarded verb, already refused off Darwin |
| `.icns` assembled by hand, and a macOS 26 inset quirk | C17, C18 | Yes — packaging only |
| App shell hardening and notarisation | ADR-0013, `window-security.ts` | Partly |

Only **four** `process.platform` / `darwin` checks exist across `packages/`, which is misleading —
but so is the guess above that the policy language and the credential store are the real coupling. Both
were measured and both were cheaper than this note predicted: the credential store is *replaced* rather
than ported ([KEYCHAIN.md](KEYCHAIN.md)), and the "policy language" cost is really the cost of a
different **kernel** mechanism, because SBPL is not a policy engine at all
([DOGWOOD-VS-SBPL.md](DOGWOOD-VS-SBPL.md)). What is left is the agent: whether `pi` runs inside whatever
boundary the host provides ([NEXT.md](NEXT.md) §1).

## Questions this spike should answer

1. **Is the abstraction "sandbox backend" worth defining?** Concretely: what is the interface a
   session's confinement must satisfy — a policy file, an argv, and a preflight probe — and could a
   second backend implement it without changing `policy.ts`'s "single place a command line is built"
   guarantee?
2. **What would a Linux backend actually be?** Bubblewrap, Landlock, nsjail, firejail, or a
   container. Each has a policy language as expressive as SBPL or it does not, and the *deny* rules
   are what Pi Central depends on (deny-by-default plus an appended fragment that wins by last-match).
3. **What does the credential model become?** C13's keychain indirection has no Linux equivalent;
   `auth.json` resolves keys through a `!command`, so a per-platform command may be enough — or the
   agent store's design may need a real secret backend.
4. **Is a partial answer acceptable?** "Runs on Linux with no sandbox" is already possible (direct
   mode) and is labelled `NO ISOLATION`. Deciding whether degraded mode is a product or a
   non-answer is part of this spike.
5. **What does Strands do that this product cannot copy?** Its sandbox routes *all* execution through
   one environment, including file I/O and skill loading. Pi Central's sessions are already child
   processes with their own policy, which is the same idea at a coarser grain — so the interesting
   part is their kernel-level mechanisms, not their plumbing.

## Deliverable

A short decision document: either an ADR that defines the backend boundary and picks a second
backend to prove it, or a decision **not** to port, with the reason. A spike that ends in "it depends"
has not finished.

Whatever it concludes, it must not weaken the properties the current design buys: deny-by-default,
one sandbox per session (ADR-0002), the appended fragment matching the composed policy, and the
credential boundary in ADR-0010.
