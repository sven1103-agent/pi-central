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
