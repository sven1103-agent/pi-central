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
`gpg.ssh.program=/usr/bin/ssh-keygen`. The appended fragment **denies `~/.ssh` wholesale** — the
directory, not a list of key names — and the launchd `Listeners` sockets, so the exposure is closed
at the policy layer as well as the environment layer. See
[Amendment 3](#amendment-3--the-ssh-boundary-is-the-directory-not-a-list-of-key-names) for why the
original name-pattern version was both redundant and, in one case, load-bearing in the wrong
direction.

**This is safe only because the agent's SSH world is self-contained.** Its `config` (github.com
only), key, `known_hosts`, `allowed_signers` and `ssh-github.sh` all live under the agent root, and
its `core.sshCommand` runs `ssh -F <agentRoot>/ssh/config` — where `-F` **replaces** the per-user
config rather than adding to it. `docs/AGENT-SETUP.md` is the recipe, and it is verified with `HOME`
pointed at an empty directory.

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

| # | Experiment | Falsifier | Status |
|---|---|---|---|
| 1 | Spawn through Safehouse with `SSH_AUTH_SOCK=/tmp/fake.sock` in the **spawn** env; inspect the child | absent ⇒ spawn-env sanitization is unnecessary | ✅ live: `SSH_AUTH_SOCK=absent` |
| 2 | Same, with `SSH_AUTH_SOCK` unset in the spawn env | still present ⇒ an undocumented passthrough exists | ✅ live: an ambient `HF_TOKEN_STRICT` planted in the parent is also absent |
| 3 | `--env=FILE=<file in a session-denied dir>`; `printenv` inside | var absent ⇒ sourcing is not unconfined and a grant *is* needed | ✅ settled by construction: `--env-pass`/`--env=FILE` are never used (C4a) |
| 4 | From a session: read the agent store path | **inverted** — see note | ⚠️ expectation inverted |
| 5 | From a session: `cat ~/.pi/agent/auth.json` | **inverted** — see note | ⚠️ expectation inverted |
| 6 | From a session: `git config --get credential.helper`, `git credential fill` | host helper answers ⇒ F12 is still live | ✅ live: host `~/.gitconfig` denied |
| 7 | Diff `safehouse --stdout … --enable=ssh` against default | no added allows ⇒ the denylist entry is unnecessary | ⏳ static only |
| 8 | `--env-pass=FAKE -- /bin/sleep 5`; inspect argv from an unconfined shell | absent ⇒ option A's argv cost does not exist | ✅ moot: the option was removed rather than used |
| 9 | Repeat 1–8 with three concurrent sessions / three workdirs | any cross-session bleed ⇒ injection is not per-session | ✅ live: 3 sessions, 12/12 probes denied |

**Experiments 4 and 5 were inverted by [Amendment 1](#amendment-1--provider-credentials-are-a-capability-not-an-identity).**
Both assumed the agent store and `auth.json` should be *unreadable*. Neither is true:

- The agent store must be **readable and writable** — it is the agent's own identity, and a
  session configured with `GH_CONFIG_DIR`/`GIT_CONFIG_GLOBAL` inside it must be able to use it.
- `auth.json` must be **readable**, because Pi opens it at startup and a deny is fatal (C12),
  and because it holds `!command` indirections rather than secrets.

Their real falsifiers are therefore the opposite of what was written: the store being
*unreadable* would be the defect, and `auth.json` being *denied* is the observed fatal case.
The live run confirms both hold in the corrected direction.

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

- [x] Boot a session with the corrected fragment and confirm it reaches `idle` (the check that
      failed). **Live run 2026-10-25:** 3/3 sessions booted, sandboxed, idle.
- [x] From inside that session, confirm a model call succeeds — i.e. the `!command` resolved.
      Without this, "idle" only proves Pi started.
      **Partially:** confirmed by enumeration, not by a call. `get_available_models` returns
      **426 models across the three providers** with a populated `auth.json`, and **0** with an
      empty agent dir — so it reflects resolved provider *configuration*, not merely known
      names. Keys still resolve lazily, so this does not prove a key's `!command` succeeded.
      A real call would make a by-hand harness slow and flaky; ordinary use is the honest proof.
- [ ] Confirm the login keychain is still unreadable while the agent keychain works (the
      prior art's `SecurityServer`-without-files measurement). **Not yet done live** — the
      policy denies both login keychain files and the composed SBPL parses with the correct
      ordering, but a session has not yet been asked to try.
- [x] Confirm denying `~/.pi/agent/auth.json` is **removed** and that no deny on a
      Pi-required config file remains. Live: `~/.pi/agent/auth.json: readable`,
      `~/.pi/agent: writable`. The general lesson stands: **never deny a file Pi opens during
      startup without booting Pi to check.**

## Amendment 2 — signing was configured off, and a key check cannot see it

**Date:** 2026-10-26 · **Status:** Accepted · **Issue:** #27

§4 states that SSH push **and commit signing** are required, and describes the intended mechanism
(`gpg.format=ssh`, `gpg.ssh.program=/usr/bin/ssh-keygen`). The mechanism was never enabled. The
adopted `external` tree at `~/.agent` carried:

```
[commit] gpgsign = false
[tag]    gpgsign = false
```

with no `[user] signingkey` and no `[gpg] format`. The key (`ssh/github_login_ed25519`) and its trust
file (`ssh/allowed_signers`) were present and correct throughout.

**This is a distinct failure from anything §4 anticipated, and it is the reason for the amendment.**
§4 reasoned about which *key* the agent should use and how to keep the host's agent out of reach. It
did not consider that the key's presence says nothing about whether it is used. Measured on this
machine:

| Configuration | Commit result | `git log --show-signature` |
|---|---|---|
| `gpgsign=false` (as adopted) | succeeds, exit 0 | `No signature` |
| `gpgsign=true`, `gpg.format` unset | succeeds, exit 0 | `No signature` — the OpenPGP default finds no gpg |
| `gpgsign=true`, key set, no `allowedSignersFile` | succeeds, exit 0 | signed, but **`verify-commit` fails** (`needs to be configured and exist`) |
| all four settings correct | succeeds | `Good "git" signature for sven1103-agent` |

Every row above exits 0. Three of the four produce no usable signature, and none of them is visible
without asking git to *verify*, which is why the required evidence is a verification rather than an
inspection.

### What the amendment changes

1. **The requirement is unchanged.** Signing stays required; it is now actually configured.
2. **The check is on the settings, not the key.** `signing.ts` audits the agent's own gitconfig for
   `commit.gpgsign`, `tag.gpgsign`, `gpg.format=ssh`, `user.signingkey` and
   `gpg.ssh.allowedSignersFile`, and reports when any is off. `ssh-key`'s presence check is retained
   and is *not* accepted as evidence of signing.
3. **`user.signingkey` must resolve inside the agent root.** ssh takes a path, never key contents, so
   a path outside the root means the agent signs as the host user. Reported as `unreachable`, not as a
   setup step.
4. **Pi Central does not write the tree.** The adopted root is `external` and user-maintained (§5), so
   the fix is produced as explicit `git config --file` commands and printed for a person to run.
   `signingFixCommands` is public for that purpose, and a test runs those commands verbatim and
   asserts the audit then passes.
5. **Verification uses the agent's own `allowed_signers`.** `gpg.ssh.allowedSignersFile` points inside
   the agent root, so a signature is checkable without the host's trust configuration.
6. **The host's signing material stays denied.** `fragment.ts` already denies `~/.ssh/id_*`,
   `*_rsa` and `*_ed25519`; the fragment test now asserts those three denials as regex rules rather
   than relying on the test's existing denies covering them incidentally.

### Verification this amendment requires

- [x] `verify-three.ts` asserts, from **inside** a sandboxed session, that `commit.gpgsign` is `true`,
      that `gpg.format`/`user.signingkey`/`gpg.ssh.allowedSignersFile` all point into the agent root,
      and that a commit made in the session **verifies**: `Good "git" signature`. The commit is the
      load-bearing check — the config values alone cannot show the key survived the sandbox.
- [x] The audit detects the real adopted tree's configuration. Run against `~/.agent`: reported
      `not-provisioned`, with the five fix commands naming agent-root paths only.
- [x] The fix commands, run verbatim against a copy of the real gitconfig, produce a store the audit
      calls `ok`, and a commit made under it verifies as `sven1103-agent`. **Measured 2026-10-26.**
- [ ] **Not run live in a full sandboxed session.** `verify-three.ts` requires an unsandboxed terminal
      (C1: Seatbelt does not nest) and cannot be executed in this environment, so the three new
      probes are written and typechecked but have not been observed passing. Stated rather than
      implied — the difference between "designed to verify" and "verified" is the whole subject of
      this amendment.
- [x] **The live tree is fixed.** The five commands were run against `~/.agent/gitconfig` as the
      explicit, confirmed action this amendment requires (a copy is kept at
      `~/.agent/gitconfig.bak-pre-27`). Re-audited afterwards: **no signing finding**, and a commit
      made under the live `GIT_CONFIG_GLOBAL` verifies as
      `Good "git" signature for sven1103-agent`. **Measured 2026-10-26.**
- [x] The host's own signing configuration is untouched: every command takes `--file` pointing
      inside the agent root, and no command omits it. The host `~/.gitconfig` was not read or
      written — the SHA of its content is unchanged, and its `user.name` is still the user's.

## Amendment 3 — the SSH boundary is the directory, not a list of key names

**Date:** 2026-10-26 · **Status:** Accepted · **Issue:** #46

§4 required that "the user's private keys" stay out of reach, and the fragment implemented that as
three name patterns:

```scheme
(regex #"^.*/\.ssh/id_[^/]*$")
(regex #"^.*/\.ssh/.*_rsa$")
(regex #"^.*/\.ssh/.*_ed25519$")
```

plus a deny on `~/.ssh/agent`, and it **deliberately left `~/.ssh/config` readable**, with the
rationale recorded in the fragment: *"denying it breaks git-over-SSH for no gain - the file holds no
private key."* The defect was reported by the user asking a live session whether it could read
`.ssh`, and the session listed it.

### What was actually wrong

**1. The rationale was false.** The agent does not read `~/.ssh/config`. Its `core.sshCommand` runs
`ssh -F <agentRoot>/ssh/config`, and `-F` *replaces* the per-user config. Measured:

```
$ ssh -G rdm                                 -> hostname 134.2.24.101   identityfile ~/.ssh/id_qbic
$ <agentRoot>/ssh/ssh-github.sh -G rdm       -> hostname rdm            identityfile <agentRoot>/ssh/github_login_ed25519
```

`rdm` is defined **only** in the host's config. Through the wrapper it is not consulted at all. So
the file was left readable to protect a capability that never used it — while exposing 58 `Host`
blocks, 32 non-public hostnames, 56 `User` directives and 5 `ProxyCommand`s.

**2. The name list was redundant where it looked essential.** The base policy grants only
`~/.ssh/config` and `~/.ssh/known_hosts`, as literals; everything else under `~/.ssh` was already
`(deny default)`. With an ordinary project workdir, `cupserver` was denied by the *default*, not by
the regex list.

**3. …and load-bearing in the one case it got wrong.** The base workdir grant is
`(allow file-read* file-write* (subpath <workdir>))`, emitted **before** the fragment. For a session
opened on `$HOME` it covers the entire home directory, so the enumeration became the only control
left. Evaluated against that composition, with the real `~/.ssh`:

| path | size | matched by a name pattern? | readable with workdir = `$HOME`? |
|---|---|---|---|
| `id_rsa`, `id_ed25519`, `id_qbic`, `id_private`, `sven_id_rsa`, `id_borg`, `id_ml_cloud` | — | yes | no |
| **`cupserver`** | 3326 B (+ `.pub`) | **no** | **yes** |
| **`jenkins`** | 3243 B (+ `.pub`) | **no** | **yes** |
| **`sven1103-agent-strongbox`** | 444 B (+ `.pub`) | **no** | **yes** |
| **`~/.ssh/config`** | 7475 B | **no** (left open on purpose) | **yes** |

Three real private keys and the host map were readable, and the rules simultaneously did nothing in
the common case. Note also that `~/.aws/credentials` and `~/.netrc` are readable under a `$HOME`
workdir: **a workdir of `$HOME` defeats every path-based credential deny in this fragment**, and is
worth a separate decision (§ "Open" below).

### What changed

`~/.ssh` is denied **wholesale** — `file-read*`, `file-write*`, `file-read-metadata` on
`(home-subpath "/.ssh")` — and the base policy's own narrower grants are restated at matching
specificity:

```scheme
(deny file-read* file-write* file-read-metadata (home-subpath "/.ssh"))
(deny file-read* file-write* file-read-metadata
    (home-literal "/.ssh") (home-literal "/.ssh/config") (home-literal "/.ssh/known_hosts")
    (home-literal "/.ssh/known_hosts.old") (home-literal "/.ssh/allowed_signers")
    (home-subpath "/.ssh/config.d"))
```

The duplication is deliberate. SBPL resolves a conflict by **last-matching rule**, and Safehouse's
own profiles note that a more specific filter can beat a broader one *regardless of order*
(`10-system-runtime.sb`, the `ssh-agent-default-deny` comment). A `home-literal` is strictly more
specific than a `home-subpath`, so a deny is stated at each baseline's own specificity and wins
under either reading.

The `~/.ssh/agent` **file** deny is removed as subsumed; the **network** deny on the launchd
`Listeners` sockets is retained, because a file deny does not cover `connect()` on a unix socket.

### Why the capability is not lost

`ssh -F` already made the agent independent of `~/.ssh`. Verified with `HOME` pointed at an **empty**
directory — no `~/.ssh` at all:

- `git ls-remote git@github.com:sven1103-agent/pi-central.git` → resolved ✅
- `ssh -T git@github.com` → `Hi sven1103-agent! You've successfully authenticated` ✅
- a commit whose `git log --show-signature` reads `Good "git" signature for sven1103-agent` ✅

### Consequences

- **The agent can reach GitHub over SSH and nothing else.** A project whose `origin` is
  `git@<internal-host>:…` will now fail. That is the intended trade — an agent should have its *own*
  identity, not a route into the user's infrastructure — but it is a capability reduction and is
  documented in `docs/AGENT-SETUP.md` rather than left to be discovered.
- **A `managed` agent root has no SSH identity at all.** Nothing scaffolds `ssh/` there, and denying
  the host's tree does not change that (see "Open").
- **`docs/AGENT-SETUP.md` is new**, and is the reproducible provisioning recipe the fresh-install
  path previously lacked.

### Verification

- [x] `fragment.test.ts` asserts a **coverage property** (does any deny rule cover this path?)
      rather than the text of a rule, and asserts that no name pattern survives in any spelling.
      It names the three keys the old list missed as explicit falsifiers.
- [x] A new `ssh-boundary.test.ts` composes the real fragment through `safehouse --append-profile`
      and evaluates the emitted SBPL for **two workdirs** — a project directory and `$HOME` —
      asserting `~/.ssh/config` and each unnamed key are denied, and that the agent's own `ssh/`
      tree stays readable. It also asserts the premise (that the base grants the whole workdir), so
      the finding cannot silently become untrue.
- [x] **Falsified:** reverting the fragment to the three regexes makes both workdir cases fail
      (`~/.ssh/config must be denied`), and the evaluator shows `cupserver`, `jenkins` and
      `sven1103-agent-strongbox` flipping to `allow` under `$HOME`. Restored; 25/25 pass.
- [ ] **Not yet observed in a live sandboxed session.** `verify-three.ts` gains probes for this, but
      it needs an unsandboxed terminal (C1). Stated rather than implied — the same distinction
      Amendment 2 drew.

### Open, and deliberately not decided here

A workdir of `$HOME` (or `/`) still defeats every path-based deny in this fragment, because the base
workdir grant is emitted first and is `subpath`-wide. Closing `~/.ssh` is a real improvement, but it
is not a general answer: `~/.aws/credentials`, `~/.netrc` and anything else under `$HOME` remain
readable in that configuration. The general answer is a **workdir policy** — warn, refuse, or
restrict the grant when a session's cwd is a credential-bearing root — which is a product decision
rather than a fragment edit.
