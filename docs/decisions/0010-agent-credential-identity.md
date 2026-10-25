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

### 2. Provider credentials are a capability; identity is what gets isolated

**Amended 2026-10-25 — see [Amendment 1](#amendment-1--provider-credentials-are-a-capability-not-an-identity).**
The original text of this section said to **deny** `~/.pi/agent/auth.json`. That was wrong twice
over, and the code implementing it made every sandboxed session exit `1`. Amendment 1 replaces
this section; read it before relying on anything here.

Provider credentials are split from identity credentials, because they behave oppositely:

| | Identity | Infrastructure |
|---|---|---|
| Examples | GitHub account, SSH key, git `user.name`, signing key | the LLM provider key |
| The agent gets its own? | **Yes** — a leak is otherwise the *user's* identity | **No, and it cannot** — it is the user's subscription and endpoint |
| Mechanism | key file + agent-scoped config roots (§3, §4) | Pi's own `!command` lookup into an **agent keychain** |

There is no meaningful "the agent's own litellm key". The agent runs on the user's model
access, so this is a capability that must be granted; what can be limited is the key's *scope*,
not its existence. Denying it does not tighten isolation — it only stops the agent from
thinking.

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

### 6. The keychain is required for providers, but Pi Central must not create one implicitly

**Amended 2026-10-25 (Amendment 1).** The original text said the keychain was optional and
that provider keys could be delivered by env instead. Amendment 1 established that provider
keys are resolved by Pi's own `!command` out of a keychain, so an **unreachable keychain means
a session that starts but cannot reach a model**.

What is genuinely optional is **who creates the keychain**:

- **`external`** — adopt a tree whose keychain already holds the keys (`~/.agent`). Nothing is
  created; the search list must include it. This is the recommended path.
- **`managed`** — Pi Central creates the keychain and writes the keys.

Global search-list mutation is a hazard, and it is the reason `managed` is **never implicit**:
the hardening's own setup script records that `create-keychain` has been observed to drop
`login.keychain-db` from the user-wide list, "which breaks YOUR shell's keychain access". It
needed a restore trap to survive that. Pi Central must not modify a user-wide setting without
an explicit, confirmed action.

### Root resolution, and why `external` is the default when it exists

`resolveAgentRoot` chooses in this order:

1. `PI_CENTRAL_AGENT_ROOT` — explicit always wins, and implies `external` ownership.
2. **An existing `~/.agent` tree is adopted.** That is the hardening project's convention, so a
   machine already set up interactively is **imported rather than duplicated**, and both tools
   share one credential tree instead of drifting (§5: one writer per file).
3. A Pi-Central-owned tree under the state root — the fresh-install default.

Adoption requires a **marker** file (`agent.keychain-db`, `gitconfig`, `gh/`, or `ssh/`), not
mere existence: a stray empty `~/.agent` must not silently become the credential root.

### The keychain grant follows the provider configuration, not the agent tree

The original Amendment-1 draft granted keychain access only when `agentRoot` contained a
keychain. That is wrong, and produced the very C13 failure it was meant to prevent: the keys
in `auth.json` are looked up through the user-wide **search list**, so they need not live in
the agent's own keychain at all. On a machine whose agent root has no keychain, the session
would start, report idle, and be unable to reach a model.

The grant is now derived from `inspectProviderAuth(providerAgentDir)`: if any provider's key is
resolved by a command naming `security`, keychain access is granted. A command-based key is
resolved **lazily**, so Pi cannot report the failure at startup — which is exactly why this has
to be reasoned about in the policy.

`providerAgentDir` is tracked separately from `agentRoot` because a session inherits the
default `~/.pi/agent` for provider configuration unless `PI_CODING_AGENT_DIR` is set. The
policy is derived from where the provider configuration **actually** is rather than from an
assumption; if Pi Central ever sets `PI_CODING_AGENT_DIR`, this field must follow it.

The grant remains bounded: the login and System keychain files stay denied, so it confers the
*capability* to reach a keychain without granting the user's items in it.

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

Items 1–3 were **fixed** in `90ccca1` (spawn env; the `--enable` denylist; `--append-profile`
implemented). One of them then caused a bug that only a live run could reveal, recorded as
[Amendment 1](#amendment-1--provider-credentials-are-a-capability-not-an-identity):

1. ~~`rpc.ts` spawns with inherited `process.env`.~~ **Fixed:** `LaunchSpec.env` is required and
   `env.ts` builds an explicit allowlist.
2. ~~`FORBIDDEN_ENABLE` omits `--enable=ssh`/`keychain`.~~ **Fixed**, plus
   `cloud-credentials`/`cloud-storage`.
3. ~~[SANDBOX.md](../SANDBOX.md) claims an unimplemented `--append-profile`.~~ **Fixed:**
   `fragment.ts` implements it.
4. **The fragment must stop denying `~/.pi/agent/auth.json`**, and must gain the keychain
   grants (Amendment 1). Denying it makes every session exit `1`.
5. **A session must actually reach a model.** "State is idle" only proves Pi started; the
   first live run proved that a session can look healthy and still be unable to resolve a
   provider key. Assert a completed model call, not just a state transition.

## Amendment 1 — provider credentials are a capability, not an identity

- **Date:** 2026-10-25
- **Amends:** §2 (and the `denyPiAuth` fragment rule)
- **Status:** Accepted
- **Trigger:** the first live run of `verify-three.ts`

### What the live run showed

Every sandboxed session exited `1`:

```
EPERM: operation not permitted, open '/Users/sven1103/.pi/agent/auth.json'
  at FileAuthStorageBackend.withLockAsync
pi exited (code=1, signal=-)
```

Pi reads `auth.json` **at startup**, not on first model call. And its error handling
distinguishes two cases that look identical from the outside:

| Case | Pi's behavior |
|---|---|
| **ENOENT** (file absent) | `ReadOnlyAuthStorage.load()` returns `{}` — boots normally |
| **EPERM** (present, denied) | **throws** `Failed to read auth.json` — process exits `1` |

A policy deny produces **EPERM**, never ENOENT. So the deny converted "no access" into a
**fatal error**, and the sandbox appeared to work while making the product unusable. Verified
by booting Pi against a bare agent dir both with and without the file.

### The second error: the file holds no secret

Inspecting the host store showed what `auth.json` actually contains:

```json
"litellm":    { "type": "api_key", "key": "!security find-generic-password -ws 'litellm'" }
```

An **indirection**, not a key. `auth.json` records *which* providers exist and *how* to obtain
each key; `models.json` records *where* each provider lives (`baseUrl`, API shape). Both were
found to contain **zero** inline secrets. Denying the file therefore protected nothing while
breaking Pi.

Indirection requires only that Pi can *read* `auth.json`, not that any secret is reachable
through it: access to the keychain remains independently controlled by the policy.

### The corrected split

**Identity** and **infrastructure** are different, and only the first can meaningfully be
isolated:

| | Identity credentials | Provider (infrastructure) credentials |
|---|---|---|
| Examples | GitHub account, SSH key, git `user.name`, signing key | the LLM provider key |
| A leak is… | the **user's** identity, used as the agent | the user's model access being consumed |
| The agent gets its own | **yes** | **no — it cannot** |
| If denied | correct: the point of this ADR | the agent cannot run at all |

Provider access is a **capability the user must grant**, because an LLM agent cannot think
without one. The honest control is the key's **scope** (a spend-capped or restricted key), not
its existence. Presenting "the agent cannot use the model" as isolation would be dishonest.

### Policy changes

| Path | Before | After |
|---|---|---|
| `~/.pi/agent/auth.json` | **deny** | **allow** — it is configuration, and Pi needs it to boot |
| `~/.gitconfig` | deny | deny (unchanged — the F12 credential-helper route) |
| `~/.config/gh` | deny | deny (unchanged — the user's gh token) |
| `~/.ssh/agent` + launchd sockets | deny | deny (unchanged — sign as the user) |
| `~/.ssh/id_*` | deny | deny (unchanged — the user's private keys) |
| agent keychain | not granted | **allow** (required for provider keys) |
| `com.apple.SecurityServer` | not granted | **allow** (required to read *any* keychain) |
| `~/Library/Keychains` (login + System) | not granted | **deny** (explicit, so the agent keychain is the only one) |
| `~/Library/Preferences/com.apple.security.plist` | not granted | **allow** (holds the search list; no secret) |

### Why the keychain grants are safe

Verified against a freshly generated policy: Safehouse grants **neither** the keychain **nor**
`SecurityServer` by default (`keychain integration: not included`). So these are additive,
purposeful grants rather than a hole punched in an existing protection.

The mechanism is the hardening project's STEP-03b, measured there:

1. `security` needs the `SecurityServer` mach-lookup to read **any** keychain — it is
   all-or-nothing via IPC, so partial path hiding is impossible.
2. Denying the login and System keychain **files** is what bounds the grant. Measured in the
   prior art: with `SecurityServer` allowed but the files denied, **0** login/System items are
   readable.
3. `auth.json` uses **service-only** lookups (`-ws 'litellm'`, no keychain path), which consult
   the **search list**. On this machine that list is:
   `[0] ~/Library/Keychains/login.keychain`, `[1] ~/.agent/agent.keychain-db`. With the login
   keychain file-denied, the lookup **falls through** to the agent keychain.
4. Without read access to `com.apple.security.plist`, `security` silently reverts to the
   built-in `[login, System]` list and **every service-only lookup fails with no useful
   error** — a trap the prior art documents and this ADR inherits.

Net effect: the provider key stays encrypted at rest, is resolved by Pi's own `!command`, and
never appears in an environment variable or an argv.

### Consequence: Pi Central must own or adopt a keychain

This is a real dependency, not a detail. A session with no reachable keychain **starts but
cannot reach a model**, so provisioning is part of making a session usable, not an optional
extra. Two shapes, per §5:

- **`external`** — adopt `~/.agent` (the hardening tree), where the keychain already holds the
  provider keys. Nothing to build; requires the search list to include it.
- **`managed`** — Pi Central creates an agent keychain and stores the keys, which means
  `security create-keychain` and therefore the search-list write the prior art warns can drop
  `login.keychain-db` and break the user's own shell access.

`managed` is therefore **not** safe to do implicitly. Creating a keychain mutates a user-wide
setting, and the prior art needed a restore trap to survive it. Pi Central must not touch the
global search list without an explicit, confirmed action.

### Verification this amendment requires

- [ ] Boot a session with the corrected fragment and confirm it reaches `idle` (the check that
      failed).
- [ ] From inside that session, confirm a model call succeeds — i.e. the `!command` resolved.
      Without this, "idle" only proves Pi started.
- [ ] Confirm the login keychain is still unreadable while the agent keychain works (the
      prior art's `SecurityServer`-without-files measurement).
- [ ] Confirm denying `~/.pi/agent/auth.json` is **removed** and that no deny on a
      Pi-required config file remains — a general lesson: **never deny a file Pi opens during
      startup without booting Pi to check.**
