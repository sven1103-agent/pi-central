# ADR-0010 — Agent credential identity: agent-owned secrets, delivered per session

- **Status:** Accepted
- **Date:** 2026-10-25
- **Supersedes:** none
- **Refines:** [ADR-0002](0002-per-session-sandbox.md), [ADR-0007](0007-filesystem-access-model.md)
- **Informed by:** [`pi-sandbox-hardening`](https://github.com/sven1103-agent/pi-sandbox-hardening) — a
  measured, interactive-terminal hardening of Pi on macOS (`FINDINGS.md` F1–F13, `STEP-01`–`06`)

## Context

A coding agent runs **as the user**: same UID, same `HOME`, same keychain, same environment.
Prompt injection or a leaked token is therefore the user's credential. The hardening project
measured nine credential-exposure routes on a real machine (F2, F3, F4, F5, F7, F12 among
them) and closed them for **interactive terminal** Pi, using a dedicated macOS keychain plus
an appended `grants.sb` and an `env -i` allowlist in a launcher.

Pi Central has four properties that make that approach not directly reusable:

1. **Headless.** Sessions are RPC child processes with **no TTY**. The hardening's keychain
   unlock is a TTY prompt; without a TTY it fails fast (rc 51) rather than hanging.
2. **Concurrent.** Many sessions at once, whereas one unlock state and one search list are
   process-wide.
3. **Orchestrated.** Launched by a supervisor, not a shell, so there is no launcher script to
   hold the policy or the unlock.
4. **Distributable.** Must be installable by other people without shipping one machine's
   paths (`~/.agent`), one identity, or one keychain layout.

An evaluation of "just pass credentials from Pi Central as environment variables" found it
**correct but partial**: it cleanly covers provider keys and HTTPS `GH_TOKEN`, and it is
*impossible* for SSH — `ssh`'s `IdentityFile` is a **path, not key contents**, and no
environment variable carries a private key. SSH push and commit signing were stated as
requirements, so an env-only design cannot satisfy the product.

## Decision

**Each session runs as an agent identity with its own credentials. Secrets live in a
per-agent store; the session receives only what it needs, delivered by the mechanism that
can actually carry it.**

Three layers, which are storage, delivery, and boundary — not alternatives:

| Layer | Mechanism | Covers |
|---|---|---|
| **Storage** | Per-agent root (`agents/<id>/`): keychain, `gitconfig`, `gh/`, `ssh/` | encryption at rest, no argv exposure |
| **Delivery** | Sanitized spawn env + `--env=FILE`; `GH_CONFIG_DIR`, `GIT_CONFIG_GLOBAL` | provider keys, HTTPS `GH_TOKEN`, identity routing |
| **Boundary** | Explicit allowlist built by the orchestrator, handed to `spawn` | stops the host's ambient secrets (C11) |

### 1. The orchestrator, not Safehouse, is the sanitization boundary

Verified against Safehouse `0.12.0` (`bin/safehouse`):

- Its sanitized allowlist **already contains `SSH_AUTH_SOCK`** (line 7055), so a session
  launched through Safehouse still reaches the host's ssh-agent.
- `--env-pass` / `--env=FILE` merge **append-only** (`runtime_append_requested_host_env_entries`),
  so they can *add* a variable but can never *remove* one from the sanitized set.

Therefore `LaunchSpec.env` is **required**, and spawn never inherits `process.env`.
Sanitization is independent of every credential decision below.

### 2. Provider keys: keychain, injected by env, never inherited

Pi resolves a provider key through `~/.pi/agent/auth.json`, whose `"key"` may be a
`!command` (per `docs/providers.md`). The agent's keys are stored in the **agent keychain**
and delivered as environment values from the agent store — never read from the host
environment, and never `--env-pass`ed from the orchestrator's own env.

`~/.pi/agent/auth.json` holds the **host user's** provider credentials and is readable by
every session under the default policy (C6). Pi Central must deny it in the appended
fragment and inject the agent's keys instead.

### 3. GitHub over HTTPS: agent-scoped config root

`GH_CONFIG_DIR` and `GIT_CONFIG_GLOBAL` point into the agent root; `GIT_CONFIG_SYSTEM=/dev/null`.
This closes the measured F12 route, where the host's global gitconfig invoked
`gh auth git-credential` and resolved a token from the login keychain — a path no file deny
on `~/.ssh` would stop.

### 4. SSH push and commit signing: a key file, and no ssh-agent

Adopted from the hardening (its `STEP-04`), including its measurement: an ssh-agent holding
the **user's** keys lets a sandboxed process sign as the user *without reading any key file*.
That is F4.

The agent needs no agent. Its git-over-SSH uses an explicit `IdentityFile` with
`IdentitiesOnly=yes`; signing uses the same key via `gpg.format=ssh` and
`gpg.ssh.program=/usr/bin/ssh-keygen`. The appended fragment **denies** `~/.ssh/agent` and
the launchd `Listeners` sockets, so the exposure is closed at the policy layer as well as
the environment layer.

**This is the one credential that is not encrypted at rest.** SSH reads key *files*, and
there is no keychain indirection for it, so the alternatives were a plaintext `0600` key or a
per-session agent requiring an unlock — which reintroduces the headless-TTY problem (§1).
A managed agent was **rejected**: with a passphrase-less key an agent grants exactly what the
file grants, so it buys nothing while adding a socket and a lifecycle.

### 5. One agent root, two ownership modes

The agent root is a single parameter (`PI_AGENT_HOME`-style). It is either:

- **`managed`** — Pi Central owns it (`<state>/agents/<id>/`), for a fresh install. Portable:
  no `~/.agent` path is assumed.
- **`external`** — the user owns it (e.g. `~/.agent`, shared with the hardening). Pi Central
  **reads and verifies only; it never writes.**

**One writer per file.** Ownership is exclusive and explicit, never shared: two writers on one
credential tree is drift, which the hardening repo itself hit ("the repo copy and the live
copy had already drifted once"). Import is a **pull** and is always safe; handing a tree to
Pi Central is an ownership **transfer**, and must not run concurrently with the other writer.

**Re-import is explicit, and drift is visible.** Pi Central does not re-read an unowned tree
on the launch path. Re-import is an invoked action, and a persistent **drift badge** shows when
the external tree differs from what was imported — so divergence is seen rather than
discovered.

### 6. The keychain is per-agent optional

Global search-list mutation is a hazard, not a mechanism: the hardening's own setup script
records that `create-keychain` has been observed to drop `login.keychain-db` from the user-wide
list, "which breaks YOUR shell's keychain access". A machine that does not want that must
still work, so provider keys may be delivered by env from the agent store **without** a
keychain. The keychain is chosen for encryption at rest, not required for function.

## Consequences

**Positive**

- A session cannot reach the user's ssh-agent, login keychain, host provider keys, or host
  `gh`/git config unless Pi Central grants it — enforced at the environment *and*, for the
  credential paths, the policy layer.
- Provider keys and the `gh` token are encrypted at rest and never appear in a process argv.
- The agent acts as itself: commits and pushes are attributable to the agent account.
- Both a fresh machine and this one (sharing `~/.agent` with the hardening) are supported
  without forking the design.
- The sanitization boundary closes an exposure that Safehouse's defaults do not (C11), which
  is independent of any credential choice.

**Negative — stated honestly**

- **The agent can exfiltrate any credential it legitimately holds.** Egress is unrestricted by
  design (C5); blocking exfiltration is explicitly not Safehouse's threat model. The achievable
  property is **"the agent has its own credentials and not the user's"** — *not* "the agent
  cannot leak a secret it is using." This must not be presented otherwise in the UI.
- The SSH private key is plaintext at `0600`. See §4 for why no better option exists headless.
- Import/export adds a drift surface that must be surfaced to the user rather than silently
  resolved.
- Pi Central now has credential state, so Q7's "no secrets" needs a precise restatement
  (references in `~/.config/pi-central/`, values in the agent store).
- macOS-only: Safehouse `runtime_preflight` hard-fails on non-Darwin and no Linux backend
  exists (C10). "Works on Linux" is a backend decision, not a keychain decision.

## Alternatives considered

- **Port the keychain + TTY unlock + search-list fall-through as-is.** Rejected: no TTY
  (rc 51), one unlock state for N concurrent sessions, mutates a user-wide setting, and
  hardcodes `~/.agent`.
- **Environment variables only.** Rejected: cannot express SSH push or signing (`IdentityFile`
  is a path), and does not remove `SSH_AUTH_SOCK` because the merge is append-only.
- **Pi's `auth.json` `!command` indirection for every provider.** Partially adopted for
  storage, but not relied on as a boundary: off-macOS the command runs *inside* the sandbox and
  needs a grant, so the session could read the file anyway.
- **Per-session `PI_CODING_AGENT_DIR`** (a private `auth.json` per session). Deferred, not
  rejected: it closes C6's shared-key exposure more thoroughly but requires populating
  settings/models/extensions per session and pinning `PI_CODING_AGENT_SESSION_DIR`, or
  discovery breaks (ADR-0009).
- **A credential broker over a socket** (a genuine privilege boundary: the secret never enters
  the session). Deferred as the named future upgrade, not rejected — it is the only design that
  gives the keychain's real property portably, at the cost of a new unsandboxed component.
- **A Pi-Central-owned advisory lock on credential trees.** Rejected for the same reason as
  the session lock (C9): a lock only helps if the other writer takes it, and the other writer
  here is the hardening's own scripts.
- **Reuse Safehouse's defaults.** Rejected: hands the agent `~/.config/gh` and `~/.gitconfig`
  by default and passes `SSH_AUTH_SOCK` — the status quo that leaks.

## Verification

Each experiment has a falsifier; a passing denial proves nothing without one.

| # | Experiment | Falsifier |
|---|---|---|
| 1 | Spawn through Safehouse with `SSH_AUTH_SOCK=/tmp/fake.sock` in the **spawn** env; inspect the child | absent ⇒ spawn-env sanitization is unnecessary |
| 2 | Same, with `SSH_AUTH_SOCK` unset in the spawn env | still present ⇒ an undocumented passthrough exists |
| 3 | `--env=FILE=<file in a session-denied dir>`; `printenv` inside | var absent ⇒ sourcing is not unconfined and a grant *is* needed |
| 4 | From a session: read the agent store path | readable ⇒ the store location is wrong |
| 5 | From a session: `cat ~/.pi/agent/auth.json` | readable and not denied ⇒ the fragment is ineffective |
| 6 | From a session: `git config --get credential.helper`, `git credential fill` | host helper answers ⇒ F12 is still live |
| 7 | Diff `safehouse --stdout … --enable=ssh` against default | no added allows ⇒ the denylist entry is unnecessary |
| 8 | `--env-pass=FAKE -- /bin/sleep 5`; inspect argv from an unconfined shell | absent ⇒ option A's argv cost does not exist |
| 9 | Repeat 1–8 with three concurrent sessions / three workdirs | any cross-session bleed ⇒ injection is not per-session |

Experiments 1, 2, 4–9 require a **plain, unsandboxed terminal**: Seatbelt does not nest (C1),
so `verify-three.ts` exits 2 from inside the development sandbox. This is the same blocker
recorded in [Phase 0](../../spikes/phase-0/RESULT.md).

## Follow-up work this decision requires

These are **open defects** recorded here so they are not lost; none is fixed by this ADR.

1. `rpc.ts` spawns with inherited `process.env` — `SSH_AUTH_SOCK` reaches every session today.
2. `FORBIDDEN_ENABLE` omits `--enable=ssh` and `--enable=keychain`, both of which re-open the
   credential boundary (verified by policy diff).
3. [SANDBOX.md](../SANDBOX.md) claims an `--append-profile` "bespoke layer … always applied"
   that is **not implemented anywhere**.
