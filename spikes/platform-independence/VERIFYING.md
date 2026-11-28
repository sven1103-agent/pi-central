# Verifying portability without a Linux desktop

**Status:** the practical guide. Answers one question: *"I do not have a Linux desktop, so how do I
verify this?"*
**Milestone:** [Increment 9 — Portable](https://github.com/sven1103-agent/pi-central/milestone/9)

## The short answer

You already have a Linux computer. It is not on your desk — it is
`ubuntu-24.04-arm`, a hosted runner in the GitHub Actions minutes your repository gets **free,
because it is public**. Measured: [ci.yml](../../.github/workflows/ci.yml) already runs on
`ubuntu-latest` and has passed on every push since 2026-11-25.

Two things follow, and they are the whole guide:

1. **A hosted runner is a real Linux kernel.** It can build, run tests, start a sandbox, and produce
   the evidence a port needs. What it cannot do is *look* at a GUI.
2. **Your local options are worse than they sound.** `virtualbox` is present as a **broken symlink**
   (the app is gone), VirtualBox does not run x86 Linux guests on Apple silicon anyway, and `lima` /
   `colima` — which would give you a local ARM64 Linux VM — are not installed. All three are
   unnecessary for this increment.

## What you can verify, and how, in the order it matters

| Slice | Verifiable without a Linux desktop? | How |
|---|---|---|
| #304 the decision | **yes**, fully | writing, on this Mac |
| #305 does `pi` start in a box on Linux | **yes**, fully | a `workflow_dispatch` run |
| #307 stdio byte-clean for JSONL | **yes**, fully | a parse assertion on the same runner |
| #308 the backend interface | **yes**, fully | unit tests, on this Mac |
| #311 `capabilities.ts` survives its subject | **yes**, fully | unit tests, on this Mac |
| #309 retire the keychain | **partly** | the "never invoked" test here; the live model call needs a person |
| #306 unix-socket confinement | **no** — needs a person | a local VM, a cloud VM, or a maintainer on Linux |
| #310 the Linux backend | **no** — needs a person | same |
| #312 the backend is stated | **partly** | the macOS output here; the Linux output on a runner |
| #313 the GitHub identity | **no** — needs a person | a real push, from anywhere |

So **five of ten slices need nothing but this Mac and a button**, two more are half-verifiable, and
three need someone with a Linux box for a few minutes. That is the honest split, and it is why the
increment's slices carry `verified/auto` / `verified/manual` rather than a single "done".

## The lanes, cheapest first

### Lane A — the hosted runner (free, and it is the answer for #305 and #307)

The workflow is **already installed** at `.github/workflows/platform-independence-probe.yml`, so
there is nothing to copy — it appears in the Actions tab as soon as this is on `main`:

```bash
gh workflow run platform-independence-probe.yml
gh run watch
```

If it is not listed yet, the branch carrying it has not merged; you can exercise it from a branch with
`gh workflow run platform-independence-probe.yml --ref <branch>`.

**Why this costs nothing:** GitHub does not bill Actions minutes for standard runners on **public**
repositories, and this one is public (`gh api repos/sven1103-agent/pi-central --jq .private` →
`false`). `ubuntu-24.04-arm` is a standard runner. That is a pricing policy rather than a technical
fact, so check the run page — or GitHub's billing page — rather than trusting this paragraph.

It is `workflow_dispatch` only, so it never fires on an ordinary push. The step keeps stdout and
stderr in full, because the three outcomes are three different findings — see
[NEXT.md](NEXT.md#how-to-read-the-result-and-how-not-to).

The workflow exists in two places on purpose: the canonical source is
[harness/linux-probe.yml](harness/linux-probe.yml) (readable without the workflow existing), and the
installed copy is what GitHub runs. `harness/check-probe-installed.sh` asserts they are identical, and
`ci.yml` runs it, because a duplicate whose copies drift would report on a version nobody is reading.

### Lane B — a local Linux VM, when you want to *look* at something

Not needed for #305, and needed for #306 and #310. Two options on Apple silicon:

```bash
# Recommended: lima. A lightweight ARM64 Linux VM, the same engine colima wraps.
brew install lima
limactl start --name=pi-central template://default
limactl shell pi-central
#   ...inside the VM:
#   uname -m          -> aarch64
#   install Box, install pi with npm, run the probe
```

```bash
# Alternative: a cloud VM, if you would rather not install anything.
# Any ARM64 Ubuntu 24.04 instance will do; Box's own reference target is
# Amazon Linux 2023 ARM64, and both are named in its Linux requirements.
```

**Limits worth knowing before you start**, both measured:

- **Ubuntu 24.04 gates unprivileged user namespaces behind AppArmor.** Box will refuse to build its
  cage until `kernel.apparmor_restrict_unprivileged_userns` is cleared — the host must permit
  `unshare` and `mount`. Box's own CI does exactly this, and the workflow in Lane A copies that step.
- **A VM inside a sandboxed process cannot work.** Lima starts a VM, which needs virtualisation
  entitlements; that is fine from a plain shell on your Mac and *not* fine from inside this
  repository's own sandboxed agent sessions (C1's neighbourhood).

### Lane C — a person on Linux, for the three slices that need eyes

#306, #310 and #313 are `verified/manual` in the tracker, and this repository has a rule about that
label: *"a skipped guarantee is invisible"*, so it is stated rather than hidden. Three ways to close
them without owning a Linux desktop:

- **A contractor or colleague for an hour.** The probe is a script; they run it and paste the output.
  That is all `verified/manual` asks for.
- **A one-off cloud VM.** Half an hour of an ARM64 instance; the probe is the only thing that runs.
- **Yourself, later.** `limactl` from Lane B, when #305 has told you the port is worth the effort.

Do not close these three on the strength of Lane A. A hosted runner proves a process starts; it does
not prove a *person* saw the UI state the right backend, which is what #312 asks and #310 needs.

## What "verified" means here, precisely

This repository has three labels and they are not interchangeable
([INCREMENTS.md](../../docs/INCREMENTS.md)):

| Label | What closes it |
|---|---|
| `verified/auto` | CI fails if it regresses. Nothing else needed. |
| `verified/measured` | The issue states a number, and the number is reproduced. An exit status is one. |
| `verified/manual` | A human confirmed it and pasted the evidence. A passing CI run does **not** close it. |

Lane A closes `verified/measured` and `verified/auto` slices. It cannot close `verified/manual` ones,
and an increment that claimed otherwise would be a badge that implied coverage it does not have — the
exact thing [ci.yml](../../.github/workflows/ci.yml)'s own header refuses to do.

## The one question Lane A answers that nothing else can

**#305: does `pi` start in a Strands Box on Linux?**

Everything in this increment is downstream of it. If the answer is *no* — a V8 abort, or a namespace
error the runner could not clear — the honest outcome is an ADR that **declines** the port with a
measured reason, and #306, #310 and #313 are not worth a person's time. If it is *yes*, the three
`verified/manual` slices are an hour of somebody's afternoon and the port is real.

That is why the workflow exists before the code, and why running it is the next action rather than
reading anything else.
