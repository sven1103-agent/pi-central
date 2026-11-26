# Result: the policy language is not the blocker — the agent is

**Status:** spike finished. Two questions answered with measurements, one blocker found that is not
Pi Central's to clear.
**Issue:** [#303](https://github.com/sven1103-agent/pi-central/issues/303)
**Brief:** [README.md](README.md) · **Harness:** [harness/check-translation.sh](harness/check-translation.sh)

## The verdict, in one line

**Pi Central's deny set is expressible in Strands Box's policy language — one rule excepted — but the
agent Pi Central supervises does not run inside a Box on Linux, so adopting Box today moves the
macOS-only boundary rather than removing it.**

That is not "it depends". It says where the coupling actually is: not in the policy language, and not
in the credential store, but in the pair (pi, sandbox backend), which has no cross-platform instance.

The README's requirement line — "**macOS** | Safehouse (the sandbox) has no Linux backend yet" — is
true today, because no other backend exists at all. It becomes the wrong diagnosis the moment a
backend does exist, and someone will spend a week discovering that the *policy* was never the problem.
That correction costs one edit and is worth making whichever option is chosen.

## What was measured, and how

Everything below comes from a real Strands Box, installed into a scratch `HOME` so the machine's own
configuration was never touched, and then asked to validate a real profile. Questions 1 and 2 are
measurements. Question 3 is a quotation, because the only honest way to measure it is on a Linux host
and this is not one — it is marked as such everywhere it appears.

Two notes on how the install was made, because both would otherwise look like a different machine's
result:

- `BOX_ALLOW_UNSIGNED=1`. The installer's Apple signature check fails here with
  `internal error in Code Signing subsystem` — a Gatekeeper assessment cannot run inside the Seatbelt
  sandbox this session lives in. The release was still checksum-verified and its archive inspected, and
  what it was used for is *policy validation*, which is text in and text out. Nothing below depends on
  trusting the binary beyond that.
- The installer defaults to `/var/tmp` for its scratch directory, which is not writable here. The one
  substitution needed was `/var/tmp` → `/tmp`; `RESULT.md` records it rather than shipping a patched
  script in the repository, because the patch is about this sandbox and not about Box.

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | Can Box's policy language express Pi Central's deny set? | **Yes for the three file blocks. The fourth is a network deny with no rule-shaped counterpart.** | [harness/check-translation.sh](harness/check-translation.sh), 9/9 checks |
| 2 | Is the credential model (C13) a blocker? | **No — Box's is cross-platform and better aligned with ADR-0010 than ours is.** | `box profile show --full` on the `@box/pi` pack |
| 3 | Does `pi` run in a Box on Linux? | **The shipped pack says no. Unverified here: no Linux host.** | `@box/pi` pack README, "Limitations" |

## 1. The policy language: three blocks translate, and one rule cannot exist

[harness/.box/pc-denies.dw](harness/.box/pc-denies.dw) is `packages/orchestrator/src/fragment.ts`'s fragment
rewritten in Dogwood, Box's policy language (a Cedar dialect). Each rule names the SBPL it stands in
for. `sh harness/check-translation.sh` runs nine checks and all pass:

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
last-match to lose. If a backend abstraction ever exists, this is the property to require of it, not
"a policy file plus an argv".

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

This is *closer* to ADR-0010's principle than the current design is. ADR-0010 hands the agent its own
credential and denies the host's; Box hands the agent **no** credential and injects one per request.
"Agent-owned secrets, delivered per session" is preserved either way, and "the agent never holds the
secret" is strictly stronger. The cost is real and belongs in any ADR: the key becomes a property of
the *route configuration* rather than of the agent's store, so the credential boundary moves from
`agent-store.ts` to the profile.

## 3. The blocker: `pi` does not run in a Box on Linux

The shipped `@box/pi` pack — its `README.md` under `resources/packs/pi/`, verbatim from the installed
archive:

> **pi doesn't run on Linux yet.** Node.js stops as it starts in the box: the box refuses the memory
> that Node's compiler needs, and Node exits with status 133 and
> `Check failed: 12 == (*__errno_location ())`.

That is the whole answer to option C. Pi Central supervises `pi --mode rpc` and is not a fork of it
(principle 4, ADR-0003). A backend that cannot run `pi` cannot be Pi Central's backend on Linux,
however well its policy language fits — and the fit is *good*, which is what makes the blocker easy to
miss. The pack also records the pair it was tested against; read this as *the last recorded state*, not
as a measurement of the current pair.

Node in a JIT inside a namespace sandbox is neither a Pi Central problem nor a Box bug: it is what
Linux executable-memory restrictions do to a JIT, which Box documents at length. The repair is
upstream, in one project or the other.

## What this spike could not measure, and why

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
- **Linux was not measurable at all.** This is a Mac. Every Linux statement above is a quotation from
  a document, and is marked as one.

## What would have proved this wrong

- **That the deny set does not translate.** It did, except one rule — and that exception is
  demonstrated by a *refusal*, not by an omission, which is the difference between "we could not write
  it" and "we did not".
- **That the credential story is macOS-shaped.** It is not; it is the strongest part of the port.
- **That `pi` runs in a Box on Linux.** The pack says otherwise. One `box run pi` on an ARM64 Linux
  host falsifies this whole result, and is the single experiment worth running next.

## Recommendation for the decision (not taken here)

The issue asks for an ADR or a refusal. Neither is honest yet, but the shape is now determined:

1. **Correct the framing first.** C10 records that *Safehouse* is macOS-only, and the README repeats it.
   The measured statement is wider and less flattering: **the pair (`pi`, sandbox backend) has no
   cross-platform instance today**, and that is true of every backend examined — including the one with
   the better policy language.
2. **Option C is ruled out for now by an upstream blocker**, not by an integration cost. Re-open it
   when `@box/pi` drops that limitation, and expect the port to be cheap when it does, because the two
   hard parts (policy and credentials) measured well.
3. **Option B's interface is now specified by evidence**, and it is three things rather than two: an
   argv, a policy whose `forbid` wins *regardless of order*, and an explicit statement of which file
   operations the policy covers — the agent's own tools or only the shell. A backend that cannot deny a
   unix socket must refuse a deny for one.
4. **Option A's cost is unchanged and should be stated plainly**: the product's own code barely assumes
   Darwin (four `process.platform` checks), and the product stays macOS-only because of a dependency it
   does not own.
