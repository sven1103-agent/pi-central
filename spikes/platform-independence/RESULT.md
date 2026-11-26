# Result: the policy language is not the blocker, and neither is the agent

**Status:** spike finished. All three of the brief's questions answered, and the last one twice — the
first answer was a quotation, and it was wrong.
**Issue:** [#303](https://github.com/sven1103-agent/pi-central/issues/303)
**Brief:** [README.md](README.md) · **Harness:** [harness/check-translation.sh](harness/check-translation.sh),
[harness/check-pi-linux-claim.sh](harness/check-pi-linux-claim.sh)

## The verdict, in one line

**Nothing measured here blocks a port.** Pi Central's deny set has a kernel-enforced equivalent on
Linux Box through a different mechanism, Box's credential model is cross-platform and replaces the
keychain with something simpler, and the Linux limitation that appeared to rule Box out is a stale
documentation line whose underlying code changed four days before the line was last edited.

The first of those was originally written as *"the deny set translates into Box's policy language"*,
which overstated it. SBPL is a kernel boundary and Dogwood is a policy engine in a trusted process;
they decide different things at different layers. Box has **both** a kernel layer and a policy engine,
so the port does not trade our kernel enforcement away — but the finding belongs to the mount view and
seccomp, not to the language. [DOGWOOD-VS-SBPL.md](DOGWOOD-VS-SBPL.md) has the correction.

Two corrections have been made to this file since it was first written, and both came from asking a
question the first draft had skipped. The Linux one is below; the keychain one is in
[KEYCHAIN.md](KEYCHAIN.md), and it is the sharper of the two — a route is *shadowed* by an `auth.json`
command-key, so the keychain code must be removed **after** the configuration changes, not before.

The recommendation in this file's first version was "option C is ruled out by an upstream blocker".
That recommendation was built on the one claim the spike had not measured, and it does not survive the
measurement. The honest conclusion is narrower, and it is the brief's own: *the dependency is the
sandbox backend, and the product is portable.*

## What was measured

Three questions, and the third is where the first version of this file was wrong.

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | Can Box's policy language *express* Pi Central's deny set? | **Yes for the three file blocks — but Dogwood decides requests, it does not enforce a boundary, so this is an expressiveness result and not a security one.** | [harness/check-translation.sh](harness/check-translation.sh), 9/9, and [DOGWOOD-VS-SBPL.md](DOGWOOD-VS-SBPL.md) |
| 2 | Is the credential model (C13) a blocker? | **No — but Box replaces the keychain rather than porting it.** Provider keys become a route; the `gh` token stays a file. | [KEYCHAIN.md](KEYCHAIN.md), [harness/check-keychain-claim.sh](harness/check-keychain-claim.sh) |
| 3 | Does `pi` run in a Box on Linux? | **Unknown, and the reason I said no was a stale document. Nothing current says it cannot.** | [harness/check-pi-linux-claim.sh](harness/check-pi-linux-claim.sh), 5/5 |

Everything comes from a real Strands Box installed into a scratch `HOME`, so the machine's own
configuration was never touched, plus the upstream repository read through `gh`.

Two notes on how the install was made, because both would otherwise look like a different machine's
result:

- `BOX_ALLOW_UNSIGNED=1`. The installer's Apple signature check fails here with
  `internal error in Code Signing subsystem` — a Gatekeeper assessment cannot run inside the Seatbelt
  sandbox this session lives in. The release was still checksum-verified and its archive inspected, and
  what it was used for is *policy validation*, which is text in and text out. Nothing below depends on
  trusting the binary beyond that.
- The installer defaults to `/var/tmp` for its scratch directory, which is not writable here. The one
  substitution needed was `/var/tmp` → `/tmp`; recorded here rather than shipped as a patched script,
  because the patch is about this sandbox and not about Box.

## 1. The policy language: three blocks translate, and one rule cannot exist

> **Correction, after a question about the two layers.** Dogwood and SBPL are **not comparable layers**:
> SBPL is a kernel sandbox profile and Dogwood is a policy engine in a trusted process outside the box.
> Box enforces confinement in *two* layers — a kernel view (mounts, seccomp, or Seatbelt) plus policy in
> front of the broker — so this section measures *expressiveness* and nothing about enforcement
> strength. What that distinction changes, including the one finding it strengthens and the one claim it
> retires, is in [DOGWOOD-VS-SBPL.md](DOGWOOD-VS-SBPL.md). Read that before using this section as a
> portability argument.

[harness/.box/pc-denies.dw](harness/.box/pc-denies.dw) is `packages/orchestrator/src/fragment.ts`'s
fragment rewritten in Dogwood, Box's policy language (a Cedar dialect). Each rule names the SBPL it
stands in for. `sh harness/check-translation.sh` runs nine checks and all pass:

```text
box: box <the version on PATH — the harness prints it, and no document restates it>

== 1. the translated deny set loads, and its rules are in the run's policy ==
PASS  box profile show accepted the profile (exit 0)
PASS  the ~/.ssh directory deny is in the composed policy
PASS  the host gitconfig deny is in the composed policy
PASS  the [filesystem] deny generated the rules that hold for every process

== 2. an unrecognised action is REFUSED (the check has teeth) ==
PASS  a policy naming fs:teleport is refused (non-zero exit)
PASS  and the refusal is a policy error naming the unrecognised action

== 3. a socket-shaped condition is refused, so the ssh-agent deny has no counterpart ==
PASS  net:connect has no socket field, so that rule refuses to load
PASS  and the refusal names the attribute that does not exist
PASS  and it names the fields net:connect does have

RESULT: all checks passed
```

It also guesses at nothing: with no `box` on `PATH` it fails outright, because three of these checks
look for a *refusal*, and "command not found" is a refusal too.

Check 2 is what makes check 1 mean anything. A validator that accepts a broken policy reports nothing
about the good one; that is the same lesson `fragment.test.ts` already carries ("a deliberately broken
fragment DOES report a syntax error").

### The finding that outranks the translation

**Dogwood makes SBPL's ordering problem disappear.** A large part of `fragment.ts` exists because
SBPL resolves a conflict by last matching rule, which forced Pi Central to restate Safehouse's own
narrower grants at matching specificity — `(home-literal "/.ssh/config")` beside
`(home-subpath "/.ssh")` — and to reason about which filter is "more specific". Box's rule is simpler
and stronger:

> A `forbid` beats a `permit`. Write an exception to a broad permit as a `forbid`.

Order-independent and specificity-independent. The class of defect that `spikes/ui-sidecar/RESULT.md`
records — "a hand-written deny list failed open" — is harder to write here, because there is no
last-match to lose. That stands as a statement about **rules** — which is the only thing it can be,
since Dogwood is a policy engine and the ordering problem was a property of the policy language on both
sides. It is not an argument that a policy engine can replace a kernel boundary; see
[DOGWOOD-VS-SBPL.md](DOGWOOD-VS-SBPL.md).

### The one rule with no counterpart

The fragment's second SSH block is a **network** deny, not a file deny:

```text
(deny network-outbound
    (remote unix-socket (path-regex #"^/tmp/com\\.apple\\.launchd\\.[^/]+/Listeners$"))
    (remote unix-socket (path-regex "^" HOME_DIR "/\\.ssh/agent(/.*)?$")))
```

It exists because a file deny does not cover `connect()` on a unix socket, and a session with agent
access can sign as the user with any loaded key **without reading a key file**. Box has no
unix-socket action, and `net:connect` carries `host`, `port`, `ip4`, `ip6` and nothing else.
Measured — the attempt is refused:

```text
box: error: policy.dw:38: attribute `input.socket_path` in context for
            Box::Action::"net:connect" not found; did you mean `host`?
```

So a Box-based backend would close that socket by **not granting the path** plus a sanitized
environment, rather than by a policy rule. That is weaker than today's two independent layers (C11 and
the fragment), and it is the concrete answer to the brief's question 1: *a policy file and an argv are
not the whole interface*. A backend that cannot deny a unix socket must say so, rather than accept a
parameter named `deny` and drop it.

### The second tier, which the brief did not anticipate

Box confines in **two** places; Pi Central confines in one. The policy decides the box's own shell and
its Python. The agent's *own* file tools and every program the box starts are confined by the profile's
filesystem lists, and a policy rule never sees them. From Box's documentation:

> A file rule in your policy, such as one that forbids reading `.env`, applies only to the box's shell
> and to Python in the box.

That is why [harness/.box/profile.toml](harness/.box/profile.toml) carries a `[filesystem]` `deny`
list as well as rules. The list translates cleanly — measured, one entry
`"${{ home }}/.ssh"` generates all four actions:

```text
@id("filesystem_deny_read_0")   ... forbid (principal, action == Box::Action::"fs:read", ...)
@id("filesystem_deny_write_0")  ... forbid (principal, action == Box::Action::"fs:write", ...)
@id("filesystem_deny_delete_0") ...
@id("filesystem_deny_move_0")   ...
```

But the list's language is **narrower**, and the narrowness is the risk:

```text
box: error: Box Core cannot check the policy: invalid `[agent]` table:
            `filesystem.deny` path "~/.ssh/*" must be exact and contain no
            pattern or control character
```

Exact paths only. Pi Central has no pattern rules today — `~/.ssh` replaced three name patterns
precisely because a list fails open — so it fits *by luck of having already been fixed*. A future rule
that needs a pattern, or that forbids only deletes, cannot be expressed. So the backend interface must
state which operations its policy covers:

> Whether a policy rule applies to the agent's own file tools or only to its shell.

## 2. The credential model (C13) is not the blocker — it is an improvement

C13 says provider keys resolve through a `!security find-generic-password` indirection and there is no
Linux equivalent, which reads as a hard port cost. Box does not read the keychain at all. A route names
a host and where the key comes from, and the box substitutes it as the request leaves:

```toml
[egress.anthropic]
destinations = ["api.anthropic.com"]

[egress.anthropic.secret]
header = "x-api-key"
phantom_prefix = "sk-ant-"
ref = "env://ANTHROPIC_API_KEY"
```

Measured from `box profile show --full` on `@box/pi` — that is the shipped pack's own route, not a
sketch. The agent sees a placeholder, and the real key is inserted outside the sandbox on the way out.
Four sources are supported (`env://`, `aws://`, a local credentials daemon, a password-manager
plugin) and none is macOS-specific.

This is *closer* to ADR-0010's principle than the current design is, for **provider keys**: ADR-0010
hands the agent its own credential and denies the host's, while Box hands the agent **no** credential
and injects one per request. The cost is real and belongs in any ADR — the key becomes a property of
the *route configuration* rather than of the agent's store, so the credential boundary moves from
`agent-store.ts` to the profile.

It is **not** true of the whole credential model, and the first draft of this section said it was. The
`gh` token and the SSH identity stay files, and the shipped `@box/gh` pack declines to route the token
for `git push` at all. [KEYCHAIN.md](KEYCHAIN.md) takes the four jobs apart and measures what actually
happens to each, including the finding that pi prefers a configured `!security` key over a route's
environment variable — so the keychain code is deleted *after* the configuration changes, not by them.

## 3. The claim that `pi` cannot run on Linux is stale — and I repeated it as fact

The first version of this file said, correctly quoting the `@box/pi` pack:

> **pi doesn't run on Linux yet.** Node.js stops as it starts in the box: the box refuses the memory
> that Node's compiler needs, and Node exits with status 133 and
> `Check failed: 12 == (*__errno_location ())`.

I labelled it "a quotation" and moved on, and then let it carry the recommendation. That was the wrong
call twice over: a quotation is a source, not a test, and this one contradicts Box's own behaviour
documentation. [harness/check-pi-linux-claim.sh](harness/check-pi-linux-claim.sh) dates the claim
against the code:

```text
== 1. the pack still claims pi does not run on Linux ==
PASS  the @box/pi README on main still carries the Linux limitation

== 2. the behaviour document says the opposite ==
PASS  platform-differences.md says Linux permits writable-and-executable mmap/mprotect

== 3. the commit that changed it, and when ==
      f7af148b  2026-11-19T15:50:23Z
      fix(containment): allow executable memory on Linux so JIT runtimes run (#488)
PASS  the commit is the one that allowed executable memory for JIT runtimes
      pack README last touched: 2026-11-24T20:13:34Z
PASS  the JIT fix predates the last edit to the pack README, so the README was not re-tested after it

RESULT: the claim is STALE - the behaviour changed before the pack README was last edited
```

The behaviour document — the table an operator reads to learn what the kernel allows where — now says:

> Linux permits writable-and-executable `mmap` and `mprotect` with `PROT_EXEC`, so a JIT runtime
> runs. It refuses every `pkey_mprotect` request. macOS has no filter here.

And Box's design decision states why the per-process opt-in discussed in issue
[#42](https://github.com/strands-agents/box/issues/42) was not needed: macOS has no counterpart rule, so
a per-table key "would add a setting without closing a route". The whole class was permitted instead.
The V8 abort that the pack describes is the *old* behaviour, documented in issue #42 before it was
closed on 2026-11-19 — the same day as the fix.

Two things follow, and both matter more than the correction itself:

1. **A stale line can defeat a correct spike.** The first version of this file recommended *against*
   option C on the strength of a sentence nobody had re-tested. That is exactly the failure
   `docs/PRINCIPLES.md` rule 8 ("never state something false") exists to prevent, arriving from the
   direction of quoting rather than inventing.
2. **Upstream's docs contradict each other.** The same `linux-enforcement.md` that says
   "Writable-and-executable `mmap` … are permitted" carries a glossary row saying "Box refuses
   executable access through `mprotect`". Careful reading is not a substitute for measuring, in either
   project.

## What is still not measured, and what that now means

`box run` cannot start **any** workload from inside this harness:

```text
strands-box: note[B0302]: starting workload
strands-box: error[B0111]: bind the broker socket: Operation not permitted (os error 1)
```

That is C1 arriving one step earlier than Pi Central documents it. This environment is itself
Seatbelt-sandboxed, and every unix-socket `bind` at this UID fails with `EPERM` — measured
independently with a three-line `node` script, to rule Box out as the cause. So:

- **Policy validation was measurable**, and is what the harness checks. `box profile show` composes
  and validates the whole run's policy without starting anything.
- **A workload was not measurable.** Nothing above is inferred from a running box. Whether `box run`
  keeps `pi`'s stdio byte-clean for JSONL framing (C7), whether it exits with the workload's status,
  whether the activity banner can be suppressed in a non-TTY, and whether the broker socket is a
  second non-nesting constraint are all **open**. Each needs a plain terminal.
- **A Linux box was not measurable at all.** This is a Mac. The correction above is documentation and
  repository history — strong evidence that the claim is stale, and not the same as watching `pi`
  start in a Linux box.

The distinction matters for what to do next, so it is worth stating plainly: *the claim is stale* is
**not** the same as *pi runs on Linux*. The first is proven; the second is now the open question, and
it is one command.

## What would settle it

**`box run pi -- --version` on an ARM64 Linux host.** That is the experiment, and it is the only one
this spike leaves undone. It needs a Linux machine, a Box install, and pi installed through npm — none
of which exists here.

- If it works, Box is a live candidate and the port is bounded by the two items above: the unix-socket
  deny (weaker under Box, or expressible only through a sanitized environment) and the exact-path
  limitation of the filesystem lists.
- If it fails, the failure will name its own cause. A V8 abort with `pkey_mprotect` in a `strace` is
  a different problem from exit 133 on a JIT page, and the pack's sentence does not distinguish them.

## What this spike established, independent of that experiment

- The deny set translates, and one deny has no rule-shaped counterpart — measured by a *refusal*, not
  an omission.
- Box's policy semantics are simpler than SBPL's for this use, and the property to require of any
  backend is order-independence rather than "an appended fragment".
- Box's credential model is cross-platform and stronger than ADR-0010 requires **for provider keys**,
  at the cost of moving the boundary into the profile. It does not cover the `gh` token, which
  [KEYCHAIN.md](KEYCHAIN.md) measures and keeps as a file.
- A backend interface is **three** things, not two: an argv, a policy whose `forbid` wins regardless
  of order, and a statement of which file operations that policy covers.
- The macOS-only claim in C10 and the README describes *Safehouse*, and the port's cost is in the
  backend, not in Pi Central: four `process.platform` checks across `packages/`.
