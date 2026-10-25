# Constraints

Hard limits Pi Central must design around. These were verified against the installed
environment (Pi `1.4.0`, Agent Safehouse `0.12.0`, macOS, `node v26.12.1`), not assumed.

## C1 — macOS Seatbelt does not nest

A process already running inside `sandbox-exec` cannot apply another Seatbelt profile.
`sandbox_init` returns `EPERM` / `Operation not permitted`.

Verified two ways:

```
$ sandbox-exec -p '(version 1)(allow default)' -- /usr/bin/true
sandbox-exec: sandbox_apply: Operation not permitted

$ safehouse -- /usr/bin/true
sandbox-exec: sandbox_apply: Operation not permitted
```

Safehouse's own `55-integrations-optional/electron.sb` states this is a platform
limitation, not a policy gap:

> Re-initializing Seatbelt from inside an existing Seatbelt sandbox is blocked by the OS
> (sandbox_init returns EPERM / "Operation not permitted"). **This is not fixable with
> additional allow rules in this profile.**

### Consequences

- The component that spawns sandboxed sessions **must not itself be sandboxed**.
- Each session must be a **separate `safehouse` invocation**, not a child of another
  sandboxed process.
- An in-process SDK host (a Pi extension that calls `createAgentSession({ cwd })` for
  other directories) **cannot** give those sessions their own profiles. They would
  inherit the host's single profile — unconfined relative to their own workdir.
- "Sandbox per session" and "one orchestrator" are therefore in tension, and the
  orchestrator wins by staying outside the boundary while holding no untrusted state.

## C2 — One RPC process owns one working directory

`switch_session` reopens a session with the **session header's** `cwd`, not the
requested one:

```js
// dist/core/agent-session-runtime.js:138
this.apply(await this.createRuntime({ cwd: sessionManager.getCwd(), ... }))
```

`assertSessionCwdExists()` runs first, so the target directory must exist and be
reachable. There is no `switch_session` field for a cwd override.

### Consequences

- Switching working directory means **switching processes**, not reusing one.
- The UI's "session switcher" is a **focus switcher** over already-running RPC clients.
- Creating work in a new directory means spawning a new `safehouse -- pi` process.
- Sessions for different cwds cannot be multiplexed through a single Pi process.

## C3 — Sessions are files plus private stdio; there is no daemon

- Persisted at `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`.
- The encoding replaces `/` and `:` with `-` and wraps in `--`, e.g.
  `--Users-sven1103-git-idea-factory--`.
- The first line is a header: `{"type":"session","version":3,"id":...,"cwd":...}`.
- RPC stdio is **private to each spawned process**. Pi exposes no attach, port, or
  registry.

### Consequences

- Pi Central **is** the registry and the supervisor. That is the product, not an
  afterthought.
- Pi Central cannot "attach" to a `pi` you started by hand in a terminal. A session is
  visible to Pi Central only if Pi Central spawned it, or if Pi Central reads its file
  (read-only history, no live control).
- Session discovery for history uses Pi Central's own parser over
  `~/.pi/agent/sessions/` (ADR-0009). If `SessionManager.listAll()` is ever used instead,
  note that it is a **runtime** function: it loads Pi's agent core into the calling process.

## C4 — Environment is sanitized by default

`safehouse` runs the wrapped command with a **sanitized env allowlist**, not the
inherited environment (`sandbox-exec -f "$policy" -- /usr/bin/env -i ...`). Additional
variables must be opted in:

- `--env-pass NAMES` — pass named host variables through.
- `--env-pass` / `--env FILE` and `--env=FILE` — richer forms.
- `SAFEHOUSE_ENV_PASS` — env form of `--env-pass`.

### Consequences

- Pi Central must decide **explicitly** what each session's environment contains.
- Provider credentials Pi needs must be passed deliberately, or they will be absent.
- This is a feature: the orchestrator controls leakage per session.

### C4a — Safehouse's sanitized allowlist is not a security boundary

The allowlist is a convenience default, not a control, and it must not be relied on to keep a
secret out of a session. Two verified properties (Safehouse `0.12.0`, `bin/safehouse`):

1. **`SSH_AUTH_SOCK` is in the allowlist** (line 7055). A session launched through Safehouse
   therefore still reaches the host's ssh-agent by default.
2. **`--env-pass` / `--env=FILE` merge append-only.** The merge helper is
   `runtime_append_requested_host_env_entries`: they can *add* a variable but can never
   *remove* one from the sanitized set.

Consequences:

- The **orchestrator** is the sanitization boundary: it builds an explicit environment and
  passes it to `spawn`. `LaunchSpec.env` is required so that omitting it is a type error
  rather than a silent inheritance of `process.env`.
- A leak of `SSH_AUTH_SOCK` cannot be fixed with a Safehouse flag. It needs the spawn
  environment, and for defence in depth the policy layer too.
- See [ADR-0010](decisions/0010-agent-credential-identity.md) and C11.

## C5 — Inbound loopback is allowed; that is not the boundary

Safehouse's `20-network.sb` allows:

```
(allow network-bind    (local ip))
(allow network-inbound (local ip))
(allow network-outbound (remote ip))
```

It explicitly states the threat model is **not** blocking exfiltration:

> Threat-model note: blocking exfiltration/C2 is explicitly NOT a goal for this
> sandbox. The goal here is reliable agent operation.

### Consequences

- A local dashboard server will bind fine, so C1 is the real blocker, not the network.
- Do **not** treat loopback binding as a security control. Bind to `127.0.0.1`, and
  treat the orchestrator's own logic as the access boundary.
- Restricting inbound peers requires macOS Application Firewall or `pf`, per Safehouse.

## C6 — `~/.pi` is readable and writable inside the `pi.sb` profile

The `60-agents/pi.sb` profile grants:

```
(allow file-read* file-write* (home-subpath "/.pi"))
```

### Consequences

- A sandboxed session can read **every** session transcript under
  `~/.pi/agent/sessions/`, including other projects'.
- Pi Central must not present cross-project transcript access as isolation it does not
  have. If per-project transcript secrecy is required, that needs a policy change, not a
  UI affordance.
- **`~/.pi/agent/auth.json` must NOT be denied**, despite being readable by every session.
  It was denied in the first implementation, and it made **every sandboxed session exit `1`**:
  Pi reads it at startup, and `EPERM` throws where `ENOENT` would have returned `{}` (C12).
  The file also contains **no secret** — it holds `!command` indirections such as
  `!security find-generic-password -ws 'litellm'` — so denying it protected nothing. See
  [ADR-0010 Amendment 1](decisions/0010-agent-credential-identity.md#amendment-1--provider-credentials-are-a-capability-not-an-identity).

## C6a — Ancestor directories are listable by design

Safehouse grants `file-read*` on **literal ancestors** of the workdir, up to
`(literal "/")`. From `bin/safehouse`, the rationale is explicit:

> Agents (notably Claude Code) call readdir() on every ancestor of the working directory
> during startup. If only file-read-metadata (stat) is granted, the agent cannot list
> directory contents, which causes it to blank PATH and break. Using `literal` (not
> `subpath`) keeps this safe: it grants read access to the directory entry itself (i.e.
> listing its immediate children), but does NOT grant recursive read access to files or
> subdirectories under it.

### Consequences

- A session can **list** the directories above its workdir, including `$HOME`.
- It cannot **read the contents** of non-ancestor siblings — verified in
  [Phase 0](../spikes/phase-0/RESULT.md).
- Do not mistake ancestor listing for a leak, and do not write a test asserting the
  parent directory is unlistable: it is listable, and that is intentional. The boundary to
  assert is **sibling contents**, not ancestor names.

## C7 — JSONL framing is LF-only

Pi's framing rules are strict: split on `LF` and strip an optional preceding `CR`.

> Node.js `readline` also splits on `U+2028` and `U+2029`, which are valid inside JSON
> strings.

### Consequences

- Pi Central's line reader must split on bytes/LF, never `readline`.
- Stdout is protocol-only; diagnostics go to stderr and must not be parsed as protocol.

## C8 — `agent_end` is not completion

`agent_end` closes one low-level agent run. Retries, overflow recovery, compaction,
steering, and follow-ups can still follow. **`agent_settled`** means Pi will not continue
automatically.

### Consequences

- Pi Central gates "idle / done" UI state on `agent_settled`.
- "Turn complete" indicators must not be driven by `agent_end`.

## C9 — Session files are unlocked, append-only, and unwatchable

**Verified by execution** against Pi `1.4.0`.

A session file has three properties that together make concurrent writers possible and
undetectable in advance:

1. **No lock.** `core/session-manager.js` contains no `flock`, `O_EXCL`, or lockfile use.
   Writes are a bare `appendFileSync(this.sessionFile, …)` (line 812).
2. **No held descriptor.** `appendFileSync` opens, writes, and closes per append. A live
   `pi` writing a session does **not** appear in `lsof` for that file — checked while a
   session was actively being written.
3. **Append-only, id-linked.** Entries chain by `parentId`. A second writer appends its own
   entries; the file stays **parseable** (no corruption observed: 1,288 entries, 0
   unparseable lines, no duplicate ids) but gains a second child for one parent, i.e. a
   **branch point** Pi did not intend.

### Consequences

- Nothing can reliably answer "is another process using this session right now?" — not a
  lock, not `lsof`, not a registry (C3).
- The one-live-process-per-session rule ([ADR-0004](decisions/0004-session-identity.md))
  is enforceable **only** among processes Pi Central itself spawns.
- Resuming a session that a terminal `pi` is actively using risks a branch in its history.
  This was observed directly: a resume of a live session produced the file's only branch
  point across 50 sampled sessions.
- A file's recent mtime is a **hint**, not evidence — it cannot distinguish a live writer
  from a session that was simply closed a moment ago.

### Why Pi Central does not add its own lock

A Pi-Central-owned lock would not be taken by Pi, so it cannot prevent a foreign writer —
the only case that is not already handled in memory. It would add lock lifecycle, stale
handling, pid reuse, and a new blocking failure mode for no coverage gain. Rejected for the
same reason as the filesystem sidecar ([ADR-0007](decisions/0007-filesystem-access-model.md)).

## C10 — Safehouse is macOS-only

`safehouse` hard-fails off Darwin. `runtime_preflight` (line ~7066):

```
"safehouse requires macOS (Darwin) to execute commands under sandbox-exec."
```

There is **no** Linux backend: no `bubblewrap`, `landlock`, `seccomp`, `nsjail`, or `firejail`
reference exists in the tool (verified by search), and `sandbox-exec` is the only execution
path.

### Consequences

- Pi Central's sandboxed mode is **macOS-only**, and that is a property of the sandbox
  backend, not of any credential choice. "Support Linux" is a backend decision.
- macOS-only is an accepted constraint, which makes macOS-native mechanisms (e.g. the
  Keychain) have **zero marginal platform cost**.
- `safehouse --stdout` still renders a policy on any platform; only *execution* is gated.
- Direct (unsandboxed) mode exists for feasibility testing and is labelled `NO ISOLATION`.

## C11 — Environment sanitization is the orchestrator's job

Environment variables are **not a filesystem concept**: no SBPL grant or deny constrains them,
so no policy can keep a variable out of a session. Combined with C4a, this means:

- A variable exported in the user's shell (e.g. `SSH_AUTH_SOCK`, or any `*_TOKEN`) reaches a
  session if the orchestrator spawns it with an inherited environment.
- Subagents inherit the parent's environment, so the exposure multiplies: `pi-subagents`
  builds each subagent's env from `process.env`, stripping only git-routing and
  extension-binding variables — not secrets.

### Consequences

- Sessions are spawned with an **explicit allowlist**, never `process.env`.
- A denylist is not an option: the set of secret-shaped names is unbounded and user-defined.
- This control is independent of, and a prerequisite to, every credential decision in
  [ADR-0010](decisions/0010-agent-credential-identity.md).

## C12 — Denying a file Pi opens at startup kills the session

Pi reads part of its configuration **during boot**, not lazily on first use. Verified against
Pi `1.4.0`: `FileAuthStorageBackend.withLockAsync` reads `<agent-dir>/auth.json` at startup,
and its error handling distinguishes two cases that a sandbox makes easy to confuse:

| Case | Pi's behavior | Sandbox cause |
|---|---|---|
| **ENOENT** — file absent | returns `{}`, boots normally | nothing there |
| **EPERM** — present, denied | **throws**, process exits `1` | a policy deny |

A Safehouse/SBPL deny produces **EPERM**, never ENOENT. So a deny converts "the agent cannot
read this" into "**the agent cannot start**".

### Consequences

- **Never add a deny for a file Pi touches during startup without booting Pi to check.** The
  policy text can be perfectly valid, correctly ordered, and still make every session fail.
- This is invisible to policy-level verification. It was found only by running
  `verify-three.ts`, which is why that harness exists.
- Prefer **relocating** a config file (`PI_CODING_AGENT_DIR`) over denying an existing one:
  redirection produces no error, so there is nothing to trip over.
- Symptom to recognize: `pi exited (code=1)` plus a Node stack trace naming `EPERM` on a
  `~/.pi` path.

## C13 — Provider keys require a reachable keychain; a session can start without one

`auth.json` stores provider credentials as an **indirection**:

```json
"litellm": { "type": "api_key", "key": "!security find-generic-password -ws 'litellm'" }
```

Pi runs that command when the key is first needed. Two verified properties:

- A **fresh** Safehouse policy grants neither the keychain nor `com.apple.SecurityServer`
  (`keychain integration: not included`). `security` needs `SecurityServer` to read **any**
  keychain, so without it the command fails.
- The lookup is **service-only** (no keychain path), so it consults the user-wide **search
  list** in `~/Library/Preferences/com.apple.security.plist`. If that file is unreadable,
  `security` silently falls back to `[login, System]` and every lookup fails **with no useful
  error**.

### Consequences

- A session with no reachable keychain **starts, reports `idle`, and then cannot reach a
  model**. "State is idle" is not evidence that a session works — assert a completed model
  call (C12 has the same lesson from a different direction).
- Reaching the keychain requires granting `SecurityServer` plus the agent keychain, **and**
  denying the login/System keychain files so the grant is bounded. The keychain is
  all-or-nothing via IPC, so partial path hiding is impossible; least privilege (an agent's
  *own* keychain) is the control, not concealment.
- Creating a keychain mutates the **user-wide search list** and has been observed to drop the
  login keychain, "which breaks YOUR shell's keychain access". Pi Central must never do this
  implicitly ([ADR-0010 §6](decisions/0010-agent-credential-identity.md)).

## C14 — A cached conversation is stale the moment it is taken

Pi emits a session's history only to the client that asked for it, and never re-emits it. Any copy
Pi Central keeps is a snapshot of one instant.

**Consequence:** a client that connects later must **fetch** the conversation, not be handed a
remembered one. Replaying a cache does not merely risk staleness — it *overwrites* whatever the
client already had. The observed failure: a session started fresh cached its own empty opening
state, so every reconnect replaced a correct transcript with an empty one, while `messageCount`
said 11. The UI then claimed to be loading, forever, because a once-only guard prevented recovery.

**Related, same family:** a *failed* read and an *empty* result must be different events. Rendered
as the same thing, a failure becomes an eternal spinner — a claim that work is in progress when
none is.
