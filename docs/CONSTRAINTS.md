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
- Session discovery for history comes from `SessionManager.listAll()` (exported) or by
  walking `~/.pi/agent/sessions/` directly.

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
