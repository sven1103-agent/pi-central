# Policy: what ships, what an installation may change, and what cannot be widened

**Status:** design for Increment 9, slice 9-11. Nothing here is implemented.
**Decision:** [ADR-0020](decisions/0020-a-sandbox-is-a-defined-boundary.md) §6
**Measured against:** Safehouse on this machine, 2026-11-28. Commands are quoted so they can be re-run.

## The problem this answers

Pi Central's deny set is a literal inside `packages/orchestrator/src/fragment.ts`. The orchestrator
reads **no configuration file at all** — verified by searching `config.ts` and `server.ts` for
`readFileSync`. The only policy surface that exists is `--enable`, and it is *subtractive*: a fixed
`FORBIDDEN_ENABLE` set refuses features.

That is a defensible default and an indefensible product. An organisation that must route model traffic
through its own gateway cannot adopt Pi Central at all, because the route configuration is ours and not
theirs. The constraint arrives on day one, so "we will add an option later" does not help.

The principle, therefore, is not "make the policy configurable". It is:

> **A configuration may only narrow the boundary. Widening it is a separate, explicit, recorded act.**

Narrowing is free because it cannot hurt anyone. Widening is the only dangerous direction, so it is the
only one that needs a ceremony.

## What ships: one named profile, `solo`

Pi Central ships **one** profile, named `solo`, and it is an opinion rather than a neutral default. It
encodes the practices this project was built around:

| The `solo` profile's position | Where it comes from |
|---|---|
| The host's `~/.gitconfig`, `~/.config/git`, `~/.gitattributes` are denied | a credential helper can resolve a token no `~/.ssh` deny would stop |
| The host's `~/.config/gh` is denied read **and write** | the write grant was a config-tampering surface |
| The user's whole `~/.ssh` tree is denied, plus the ssh-agent sockets | a list of key *names* fails open; the directory is the unit |
| `~/.pi/agent/auth.json` is **allowed** | it holds `!command` indirections, not secrets, and denying it makes Pi exit 1 |
| Provider keys are **not** denied | the agent runs on the user's model access; denying it stops the agent thinking |
| The agent's own root is read-write, with ancestor literals | the denies above only help if the agent still reaches what it owns |

Every row above is already implemented and asserted by `fragment.test.ts`. Naming the set `solo` and
shipping it as data rather than as a `const` is the change; the rules themselves do not move.

**Why an opinion and not "sensible defaults".** People override a stated opinion and fight an unstated
one. A profile with a name, a version and a changelog can be cited in an incident review; "our defaults"
cannot.

### The rule that keeps `solo` portable: no package-manager paths

**A shipped profile may name only what it can derive — the workspace, the home directory. It may not
contain a package-manager prefix.**

No `/opt/homebrew/…`, no `/usr/local/…`, no `/nix/store/…`, no `~/.cargo/…`. Those paths are one
machine's furniture: a Homebrew prefix, a formula version, a layout choice. Shipping them means the
profile carries a stranger's install into every copy, and rots silently on the next version bump.

This rule exists because the temptation arrived immediately and looked reasonable. On a Homebrew macOS
machine, the shipped `@box/pi` pack cannot start the agent at all:

```console
/opt/homebrew/Cellar/node/26.13.1_4/bin/node: OpenSSL configuration error:
… BIO_new_file:Operation not permitted … fopen(/opt/homebrew/etc/openssl@4/openssl.cnf, rb)
```

Measured on macOS, 0.3.1, in a run whose composed profile shows Core granting `/etc/ssl` (the *system*
one) while Homebrew's node opens its own copy beside the formula. The obvious fix is one line in the
profile — and it is the wrong line to ship, for four reasons stacked:

| What the path encodes | Whose decision it is |
|---|---|
| `/opt/homebrew` | one person's Homebrew prefix |
| `openssl@4` | a formula version that becomes `@5` |
| `etc/openssl@4/openssl.cnf` | a Homebrew layout choice |
| that node opens it at startup | this node build's compiled `OPENSSLDIR` |

Four local facts, one line, and every one of them can change without the profile changing with it.

**Where it belongs instead**, in order of preference:

1. **Upstream, in the pack.** `@box/pi` already *searches* for node (`pi.node` is a `(search)`
   option); it should find the OpenSSL config beside whichever node it found. That is a bug report
   worth more than any workaround, because it fixes the failure for everyone.
2. **The installation overlay**, where a person who knows their machine can see the line and own its
   staleness.
3. **Never in `solo`.** A shipped profile that does not start on a stock macOS is a smaller problem
   than one that starts by carrying a path that expires.

`scripts/check-profile-portability.mjs` asserts the rule against the shipped profile data, so the
temptation fails a check rather than a review.


## The installation overlay, worked through

The rule above is easier to accept with a concrete case, so here is the one that produced it: a
Homebrew macOS machine, Box 0.3.1, the shipped `@box/pi` pack.

### What fails, and it fails honestly

```console
$ box run pi -- --version
… /opt/homebrew/Cellar/node/26.13.1_4/bin/node: OpenSSL configuration error:
    … BIO_new_file:Operation not permitted … fopen(/opt/homebrew/etc/openssl@4/openssl.cnf, rb)
```

That is Seatbelt working. Box's composed profile grants `/etc/ssl` — the system copy — and Homebrew's
node opens its own, beside the formula. The refusal is correct; the grant is incomplete for this node.

### The overlay, which is yours — and where it lives, honestly

**Two different files, and only one of them exists today.** Lumping them together would be the
comfortable thing to write and the wrong thing to ship, so they are kept apart:

| File | Exists today? | Whose problem it fixes |
|---|---|---|
| `~/.strands/box/profiles/<name>/profile.toml` | **yes** — Box reads it | a Box profile that cannot start the agent on this machine |
| `~/.config/pi-central/policy/*.toml` | **not yet** — slice [#314] builds it | Pi Central narrowing its own denied set |

The rule above applies to **both**, and only the first is usable right now. The state root
(`~/.config/pi-central`) is where Pi Central keeps its own state — measured: it holds
`open-sessions.json`, `preferences.json`, `sidecars/` and `policy/` — but `config.ts` reads **no
config file at all** (`readFileSync` appears zero times), so nothing there is consulted for policy
yet. Saying otherwise would be documenting an intention as a feature.

#### Today: the Box profile overlay

`~/.strands/box/profiles/<name>/profile.toml`, beside the `policy.dw` that `box profile create` writes.
Box reads it, so this is the only override that works before slice [#314] lands. Three paths, because
that is what node touches:

```toml
# Installation overlay — NOT shipped, NOT part of the solo profile.
#
# Four local facts are encoded here on purpose, and each is yours to keep current:
#   /opt/homebrew            your Homebrew prefix
#   openssl@4                the formula version (becomes @5)
#   etc/openssl@4/…          Homebrew's layout
#   node opens it at startup this node build's compiled OPENSSLDIR
#
# If node stops starting after an upgrade, this file is the first place to look, and the
# reason it is a separate file is so that it is findable rather than buried in solo.

[agent.filesystem]
read = [
  "/opt/homebrew/etc/openssl@4/openssl.cnf",
  "/opt/homebrew/etc/openssl@4/cert.pem",
  "/opt/homebrew/etc/openssl@4/certs",
]
```

#### Tomorrow: the Pi Central installation policy

`~/.config/pi-central/policy/`, one file per overlay, loaded by the orchestrator and refused if it would
widen. That is slice [#314]'s deliverable and the reason the rule is written now: the mechanism does not
exist, and the constraint on what may go in it does.

**It merges, measured rather than assumed.** `[agent.filesystem] read` in a profile is *appended* to
the pack's list, not substituted for it. The composed result keeps the pack's four entries and adds the
three overlay paths; `write`, `exec` and `deny` are untouched. That matters because substitution
would silently drop the agent's access to pi's own install tree — a failure that would look like "pi
cannot start" and be attributed to the wrong thing.

**What it may not do.** It may not remove a deny, and it may not grant a system root — Box refuses
`/usr/bin` outright (*"a system root is never a grantable tree"*) and the overlay inherits that. It may
add a read, add a deny, and nothing else.

### The bug, stated precisely enough to file

The overlay is a workaround, and the composition shows exactly whose bug it is. In one `box profile
show`:

| Layer | OpenSSL config |
|---|---|
| `[tool.node]` — the tools Box found | **granted**, plus `/opt/homebrew/Cellar/openssl@4/4.1.0`, `/opt/homebrew/etc/openssl@4`, `ca-certificates` and 28 dependency receipts |
| `[agent.filesystem]` — the agent's own list | **granted only because the overlay added it** |

So Box already knows where Homebrew's OpenSSL lives — it derives it for the tool layer from the formula
— and does not carry that derivation to the agent. The pack searches for node (`pi.node` is a
`(search)` option) and then grants that one binary, not the runtime node needs.

That is a one-line fix upstream and a report worth filing. The overlay exists so a person is not
blocked while it is open.

**What it costs.** The staleness is explicit. A version bump moves `openssl@4` to `openssl@5` and the
overlay breaks with a file-not-found, in a file named after the platform — rather than silently, in a
shipped profile nobody thinks to check.

### The same fix, done properly, is upstream

`@box/pi` already searches for node (`pi.node` is a `(search)` option). It should search for the
OpenSSL configuration next to whichever node it found, and the failure disappears for everyone. That
report is worth filing, and the overlay is what a person uses while the report is open.

An overlay is a **stopgap with an owner**, not a second shipped configuration. If a second overlay
appears for a second package manager, that is a signal the pack needs fixing, not that Pi Central needs
a library of them.

## Three layers, and the direction each may move

```
  shipped profile        Pi Central's opinion            narrow or widen: it IS the baseline
        |
  installation policy    the person or organisation      NARROW freely; widen only explicitly
        |
  project policy         a repository's own file         NARROW only, always
```

### The shipped profile

Ships with the release, lives in the package, and is compared by digest so an upgrade that changes it is
visible. An installation may not edit it in place — an edit that is not in the package cannot be reported
as drift.

### The installation policy

Lives in the state root (`~/.config/pi-central`), never in a workdir. The orchestrator reads it; no
session can write it, because a session's filesystem grant is `--workdir <cwd>` and the state root is
outside that.

It holds two distinct things and they must not share a syntax:

- **additions** — extra denies, extra allows-with-a-reason. Applied on top; may only narrow.
- **widening** — a removal of, or an exception to, a shipped deny. Requires an explicit acknowledgement
  field naming the rule and the reason, and it is **logged once at load** so the refusal is visible in the
  record rather than inferred from a policy file.

An installation that adds a deny needs nothing. An installation that removes one is choosing, and the
record says so.

### The project policy — and the measurement that decides its fate

This is where the design almost went wrong, so the measurement is stated in full.

Safehouse already has a **project-level policy surface**: `<workdir>/.safehouse`, loaded only when
trusted. `docs/SANDBOX.md` calls the appended layer "the intended hook for project- or team-specific
restrictions", which reads as though a project file narrows.

**It is `key=value` configuration, not a policy file.** Measured — a policy expression is refused:

```console
$ printf '(allow file-read* (subpath "/tmp/X"))\n' > .safehouse
$ safehouse --stdout --workdir /tmp/wdtest --trust-workdir-config
Invalid config line in /private/tmp/wdtest/.safehouse:1: expected key=value
```

So it **widens by options**, and a widening it applies is a path our fragment may never mention:

```console
$ printf 'add-dirs=/tmp/UNMENTIONED\n' > .safehouse
$ safehouse --stdout --workdir /tmp/wdtest --trust-workdir-config --append-profile ./deny.sb \
    | grep -c UNMENTIONED
3
```

Three occurrences — the grant and its ancestor literals — for a path the appended deny file never names.
Our layer cannot constrain what it does not name, and enumerating is exactly the failure this repository
already fixed once: a four-name deny list that left `~/.gitconfig` readable while reporting the others
refused (C15c). A name list is not a boundary.

The ordering does help where both layers *do* name the same path — the deny is emitted last, so
last-match-wins favours it:

```console
1176:(allow file-read* file-write* (subpath "/private/tmp/WIDEN_TEST"))   <- project's add-dirs
1198:(deny file-read* (subpath "/private/tmp/WIDEN_TEST"))               <- our appended fragment
```

But "the deny wins if we happen to have named it" is not a rule a project can be trusted with.

**Decision: Pi Central does not pass `--trust-workdir-config`.** A project cannot widen the boundary by
committing a file, because the file is never read. This is deny-by-default applied to configuration
itself, and it costs a feature nobody has asked for. A project that needs a narrower boundary gets it from
the installation policy, which a human installed.

If a project policy is ever wanted, the only safe form is: Pi Central parses the file **itself**, accepts a
narrowing subset, and refuses the file rather than passing it through — the same shape as `FORBIDDEN_ENABLE`
refusing a feature instead of forwarding it.

## What this costs, stated plainly

- **One profile ships, so an organisation's first day involves writing a policy.** That is the price of
  shipping an opinion instead of pretending to have none. The installation file is additive, so most
  organisations add denies and stop.
- **A named profile is a compatibility surface.** Renaming `solo` or changing its meaning needs a
  changelog entry and a note in the release, because a person's safety depends on what it contains.
- **Refusing project trust removes a capability Safehouse offers.** Stated here rather than discovered by
  someone whose `.safehouse` silently did nothing.
- **The layering is only safe because `forbid` beats `permit`** under the candidate backend. Under
  today's last-match-wins semantics it depends on emission order — which is why the *interface* must
  require order-independence rather than an appended fragment (ADR-0020 §1).

## The admission-test consequences

ADR-0020's test gains two rows, because a backend that cannot express these is not a candidate:

| Requirement | Why |
|---|---|
| An inner layer can only narrow; a widening is refused at load, not merged | the whole design rests on it |
| The backend can state whether a *project-supplied* configuration is honoured or ignored | silence here is how a repo silently widens everyone who opens it |

## What would prove this wrong

- **An organisation that must ship Pi Central with no filesystem edits at all** — a locked appliance. Then
  an installation policy in the state root is still too much, and the profile must be settable by
  environment at first launch.
- **A project that legitimately needs a *narrower* boundary than its installation.** Then project policy
  returns, as a parsed narrowing subset and never as a passthrough.
- **A `solo` rule that turns out to be wrong for a real workflow**, more than once for the same rule. Then
  it belongs in the installation layer, not the shipped one — the profile is an opinion, and opinions that
  keep being overridden are wrong.

[#314]: https://github.com/sven1103-agent/pi-central/issues/314
