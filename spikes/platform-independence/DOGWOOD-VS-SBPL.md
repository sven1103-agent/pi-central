# Correction: Dogwood is a policy engine, and SBPL is not — the two are not comparable layers

**Status:** correction to [RESULT.md](RESULT.md) §1. The translation measurement stands; the *claim I
drew from it* did not.
**Raised by:** a question on the spike — *"Dogwood is a policy engine, not kernel hardening as we did
with SBPL"*.

## What I got wrong

RESULT.md said *"Pi Central's deny set is expressible in Strands Box's policy language"* and treated
that as the load-bearing portability finding. It is true and it is also beside the point, because the
two languages decide **different things at different layers**, and our security property lives in the
layer Dogwood is not.

### The two layers, stated precisely

| | SBPL (`sandbox-exec`, macOS) | Dogwood (Box) |
|---|---|---|
| What it is | a kernel sandbox profile | a policy engine in a **trusted process outside** the box |
| Who enforces it | the kernel (Seatbelt / `sandbox_init`) | Box Core, per request, in user space |
| Unit decided | a syscall against a path, socket or mach service | an operation on a **declared channel** |
| Filesystem deny | kernel refuses `open()` | **not policy** — a mount-view overmount |
| Network deny | kernel refuses `connect()` | gateway asks policy before it dials |
| Uncovered channel | none: unlisted syscalls are denied by `(deny default)` | anything not routed through the broker |

Box's own reference draws the line in its first paragraph:

> **`box.toml` sets what the workload's own system calls can reach, and the operating system enforces
> that.** Inside that reach, policy decides each request the workload sends through the box's trusted
> process.

So a Dogwood rule is a decision about a request that has **already been intercepted**. SBPL is the
thing that stops the request existing. Those are not two implementations of one interface — they are
a boundary and an admission controller on either side of it.

### The measurement that proves it is not a like-for-like translation

My `check-translation.sh` asserted that our `~/.ssh` deny appears in the composed policy. It does — but
as a *generated rule* from the profile's filesystem list, and that rule is **not what enforces it**.
The Linux backend says so in a comment I had not read when I wrote the claim:

> **Every refusal, planned last, so it overmounts the grant that bound its parent.** A fresh read-only
> tmpfs is how this backend already spells "present, empty, and unwritable" … the workload finds an
> empty directory where the refused tree is, and the bytes are not in the view at all. **That is
> strictly stronger than a rule, and it is why the Linux half needs no path matching.**

And its limits are worse than SBPL's, in a way a policy rule cannot express:

> **A refused file that does not exist yet has no lowering**: an overmount needs an existing target …
> so it is refused by name rather than planned.

So on Linux a filesystem deny is a *kernel* boundary (great) with a *pre-launch path list* (narrow); on
macOS it is a *kernel* boundary with *path matching* (broad). Neither is "the policy language". The
`fs:*` rules in Dogwood are the third thing: an audit and backstop for the box's own shell and Python,
explicitly not bound to the agent's file tools.

## Why this matters more than the wording

It changes what a backend interface must be, and it changes which of my findings survive.

**What survives, unchanged and still measured:**

- Our deny set is *exprimable* in Dogwood, and a broken Dogwood policy is refused. Useful for
  knowing the language is expressive enough to describe intent.
- Dogwood's `forbid`-beats-`permit` is order-independent, which does remove a real class of defect
  from our fragment. That finding is about **rules**, and it stands as a statement about rules.
- `net:connect` has no unix-socket field. **This one gets stronger, not weaker**: our ssh-agent deny is
  a kernel-level `connect()` refusal, and Box has no kernel layer to put it in — the mount view
  mentions "a pathname Unix socket the workload may connect to — a broker route", so sockets are a
  *grant channel*, not a deny channel.

**What does not survive:**

- *"The policy language is not the blocker."* Wrong framing. The right statement is narrower: **our
  deny set has a kernel-enforced equivalent on Linux Box, through a different mechanism (mount view),
  with one gap (sockets) and one narrowing (paths must exist at launch).**
- *"A backend interface is an argv, a policy whose forbid wins, and a coverage statement."* Still
  roughly right, but the third item is now the whole point rather than a footnote: the interface must
  say **which layer enforces what**, because "policy rule" and "kernel view" are different guarantees
  with different failure modes.

## The distinction that decides option C, and I had it backwards

If Dogwood were our replacement for SBPL, then a Box port would move the boundary from the kernel into
a trusted user-space process — a real weakening, and worth saying plainly.

It does not. Box has **both**: a Linux mount view (kernel) and policy (user space). What Box does not
have is a *macOS* mount view — on macOS the boundary is Seatbelt, driven by the same profile mechanism
we already use. So the honest comparison is:

| Platform | Kernel boundary | Policy engine |
|---|---|---|
| macOS today | Safehouse → SBPL | none (`fragment.ts` is SBPL too) |
| macOS under Box | Seatbelt, via Box's profile | Dogwood |
| Linux under Box | mount view + seccomp | Dogwood |
| Linux today | **nothing** | none |

That last row is the actual current state of the world: Linux has *no* boundary today, because
Safehouse refuses to run there (C10). So the comparison is not "kernel versus policy engine" — it is
**"one kernel boundary" versus "one kernel boundary plus an admission controller"**. A port would not
trade our kernel enforcement away; it would add a user-space layer on top of a different kernel
mechanism.

## Corrected one-liner

**Dogwood is not a replacement for SBPL and the spike should never have implied it was. Box enforces
confinement in two layers — a kernel view (mounts, seccomp, or Seatbelt) and a user-space policy engine
in front of the broker — so the port question is not whether a policy engine is as strong as a kernel
sandbox, but whether Box's kernel layer reproduces the macOS Seatbelt boundary we rely on. Measured:
it does for files, with one gap (unix sockets) and one narrowing (refused paths must exist at launch).**
