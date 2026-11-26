# Would a port sacrifice kernel enforcement? No — on both platforms

**Status:** direct answer to the question a decision-maker asks: *"to port Pi Central to Linux and
macOS, would we sacrifice kernel hardening completely?"*
**Short answer:** **No.** A port never replaces a kernel boundary with a policy engine. Box has a
kernel boundary on both platforms, and on macOS it is *the same kernel primitive we already use*.

## Why the confusion was my fault

[DOGWOOD-VS-SBPL.md](DOGWOOD-VS-SBPL.md) says "Dogwood is a policy engine, not kernel hardening". That
sentence is about **Dogwood**, and it is easy to read as a statement about **Box**. It is not. Box is
two layers, and only the top one is a policy engine.

```text
Box on macOS                          Box on Linux
----------------                     -----------------
Seatbelt profile  <- kernel            mount view + seccomp  <- kernel
      |                                      |
Dogwood policy    <- user space         Dogwood policy        <- user space
      |                                      |
   workload                              workload
```

The policy engine sits **on top of** the boundary in both columns. It is never instead of it.

## Measured: same kernel primitive on macOS

This is not an inference from documentation. The shipped Box helper binary reports its own backends and
calls the same libc entry point Safehouse calls:

```text
Production apply supports macOS Seatbelt and, on Linux, the namespace
sandbox_init returned error code
fixed macOS Seatbelt Agent profile
```

and the profile vocabulary it emits is the same one our fragment speaks: `file-read`, `subpath`,
`literal`, `network-outbound`, `mach-lookup`, `global-name`. So on macOS a Box port **keeps Seatbelt**,
which is exactly what we depend on today. Our SBPL denies have a direct counterpart in the same
mechanism, not a weaker one.

On Linux it is a mount view plus a seccomp filter plus namespaces — also kernel, also not user space.
Its filesystem refusal is an **overmount**:

> Every refusal, planned last, so it overmounts the grant that bound its parent … the bytes are not in
> the view at all. That is strictly stronger than a rule.

## And today, Linux has no boundary at all

This is the part that makes the answer obvious, and it is the row people miss:

| Platform | Today | After a port |
|---|---|---|
| macOS | Seatbelt via Safehouse | Seatbelt via Box — **unchanged mechanism** |
| Linux | **nothing.** Safehouse refuses to run there (C10) | mount view + seccomp — **a new boundary** |

So a port does not trade kernel enforcement away on either platform. On macOS it is the same kernel
primitive under a different driver; on Linux it goes from *no boundary* to *a boundary*. A port can only
add here.

## The one honest caveat, stated precisely

There **is** a narrowing, and it is not about the boundary — it is about **which channel each layer
covers**. Box's own documentation is explicit:

> A file rule in your policy, such as one that forbids reading `.env`, applies only to the box's shell
> and to Python in the box. The agent's own file tools … are decided by the agent's filesystem lists.

So if we wrote `~/.ssh` in `policy.dw` and stopped there, the agent's own Read tool would not be bound
by it. **But that is not how a deny is written in Box.** The `[filesystem] deny` list is the one every
process keeps to — measured: one entry generated the deny rules *and* appeared in the agent's and every
tool's `deny` list. Written there, the boundary covers the agent's own tools at the kernel level.

What genuinely changes for us:

| | Our fragment today | Box |
|---|---|---|
| Where a deny is written | one place: `fragment.ts` | two: the filesystem list (kernel) and `policy.dw` (rules) |
| Does it bind the agent's own file tools | yes, kernel-level | yes — **via the filesystem list**, not the rule |
| Pattern rules | allowed (`~/.ssh/*`) | **refused** — exact paths only |
| A path that does not exist at launch | deny works | **cannot be lowered**; refused by name instead |
| Unix-socket deny | yes, a network deny | **no counterpart** — sockets are a grant channel |

Those are three real narrowings and a relocation. None of them is "no kernel enforcement".

## What *would* sacrifice kernel enforcement

Worth naming, so the real risk is not confused with the imaginary one:

- **Direct mode**, which already exists and is labelled `NO ISOLATION`. That is the only thing in this
  project that sacrifices it, and it is opt-in and honest.
- **A Box configuration with `native filesystem policy` off and a deny written only in `policy.dw`.**
  That is a configuration mistake, not a property of Box — and it is precisely the kind that this
  spike's own C15c lesson warns about: a deny that looks present and is not.
- **A backend whose `forbid` does not win over a broad `permit`.** The interface must require
  order-independence, because a policy engine that resolves by last match can be widened by accident.

## The one-liner

**A port would not sacrifice kernel enforcement; it would keep Seatbelt on macOS and gain a kernel view
on Linux. What changes is where a deny is written and how narrow it can be: exact paths, no sockets, no
paths that do not exist yet. The policy engine is an addition on top of the boundary in both cases,
never a replacement for it.**
