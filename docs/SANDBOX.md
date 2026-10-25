# Sandbox model

How Pi Central composes and launches an Agent Safehouse policy per session.

## Invocation

```
safehouse [policy options] [--] <command> [args...]
```

- **Policy mode** (no command): generate a policy file, print its path.
- **Execute mode** (command given): generate a policy and run the command inside it.
- `--stdout`: print policy text instead of executing.
- `--explain`: print effective workdir/grants/profile selection to **stderr**.

## Policy scope options Pi Central uses

| Option | Purpose |
|---|---|
| `--workdir DIR` | main read/write grant; empty string disables it |
| `--add-dirs PATHS` | extra read/write paths (colon-separated) |
| `--add-dirs-ro PATHS` | extra read-only paths |
| `--append-profile PATH` | append a policy profile after generated rules (repeatable) |
| `--enable FEATURES` | optional integrations (comma-separated) |
| `--env-pass NAMES` | pass named host env vars through the sanitized allowlist |
| `--env=FILE` | sanitized allowlist plus vars sourced from FILE |
| `--trust-workdir-config` | trust and load `<workdir>/.safehouse` for this session |
| `--always-trust-workdir-config` | same, and remember in `~/.config/safehouse/trusted-workdirs` |
| `--allow-workdir-config-writes` | skip the terminal deny-write rule for `<workdir>/.safehouse` |
| `--output PATH` | write the policy to a specific file |

Env equivalents: `SAFEHOUSE_WORKDIR`, `SAFEHOUSE_ADD_DIRS`, `SAFEHOUSE_ADD_DIRS_RO`,
`SAFEHOUSE_ENV_PASS`, `SAFEHOUSE_TRUST_WORKDIR_CONFIG`.

## Per-session policy resolution order

```
1. workdir             = the session header's cwd (or the cwd for a new session)
2. workdir config      = <workdir>/.safehouse, loaded only if trusted
3. bespoke layer       = --append-profile <our policy>   (always applied)
4. optional features   = --enable=... per session profile
5. env                 = sanitized allowlist + --env-pass + --env=FILE
```

The bespoke layer (3) is where Pi Central's own policy lives. Because appended profiles
are emitted **after** generated rules, they can tighten what the generated policy allows —
this is the intended hook for project- or team-specific restrictions.

### Automatic deny-write rules worth knowing

Safehouse emits terminal `deny file-write*` rules for:

- `<workdir>/.safehouse`
- every `--append-profile` path

so a sandboxed agent cannot rewrite its own policy. Overriding either requires an explicit
opt-in flag (`--allow-workdir-config-writes`, `--allow-profile-writes`). Pi Central should
**never** pass those flags for supervised sessions.

## Feature selection

Available `--enable` values:

```
1password agent-browser browser-native-messaging chromium-full chromium-headless
cleanshot clipboard cloud-credentials cloud-storage docker electron gpg gpu herdr
keychain kubectl launch-services lldb macos-gui microphone playwright-chrome
process-control shell-init spotlight ssh vscode xcode all-agents all-apps wide-read
```

Implications:

- `electron` implies `gpu` + `macos-gui`
- `chromium-headless` implies `gpu`; `chromium-full` implies `chromium-headless`
- `playwright-chrome` implies `chromium-full` + `chromium-headless`
- `agent-browser` implies `chromium-full` + `chromium-headless`
- `xcode` implies broad developer roots; `lldb` implies `process-control`
- `all-agents` loads every `60-agents` profile; `all-apps` every `65-apps` profile
- `shell-init` reads shell startup files — Safehouse warns to audit them for credentials
- `wide-read` grants read-only on `/` and is emitted **late**, so it can override earlier
  deny-read rules. **Do not enable it** for supervised sessions.

Beyond `pi.sb`, note the agent profiles include `claude-code.sb`, `codex.sb`,
`opencode.sb`, and others. A session that runs one of those agents as a tool needs the
matching profile; `pi.sb` alone does not cover them.

## Default profile selection

`safehouse` auto-selects a scoped profile from the **invoked command's basename**. Verified:

```
$ safehouse --explain -- pi --mode rpc --no-session
  invoked command: pi
  selected scoped profile: pi.sb (command basename match: pi)
  execution PATH matches: /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
```

So `safehouse -- pi …` already pulls `pi.sb`, which grants read/write on `~/.pi` and
`~/.local/bin/pi` plus read-metadata on `~/Library`. Pi Central does not need to add it.

**Caveat:** profile selection is basename-based and does not introspect shell aliases or
functions. If Pi Central ever launches through a wrapper, it must invoke `pi` such that the
basename still matches, or pass the profile explicitly.

## Where sessions can write

| Path | Access | Note |
|---|---|---|
| `<workdir>` | read/write | the session's project |
| `/tmp`, `/private/tmp`, `/var/folders`, `/private/var/folders` | read/write | subprocess temp + IPC sockets |
| `~/.pi` | read/write | **all** sessions' transcripts (C6) |
| `~/Library` | read-metadata only | |
| elsewhere in `$HOME` | **denied** | verified: `~/Documents` is `EPERM` |
| `/` | denied unless `wide-read` | |

## Integration with RpcClient

`RpcClient` spawns `node <cliPath> --mode rpc …` itself. To keep sessions sandboxed, one of:

**Option A — launcher shim (least code).**
Point `RpcClient.cliPath` at a small script that `exec`s `safehouse … -- pi …`. The shim
receives `--mode rpc` from `RpcClient` and forwards it. Risk: `RpcClient` builds argv in a
fixed order, so the shim must tolerate and reorder flags.

**Option B — supervisor owns the spawn (more control).**
The supervisor runs `spawn("safehouse", [...policy, "--", "pi", "--mode", "rpc", ...])`
directly and speaks the JSONL protocol itself (or feeds the child's stdio into a
constructed `RpcClient`-style wrapper). More code, exact control over argv, env, and
process group.

**Option C — `SAFEHOUSE_*` env vars.**
Set `SAFEHOUSE_WORKDIR`, `SAFEHOUSE_ADD_DIRS`, `SAFEHOUSE_ENV_PASS` and invoke safehouse
with a minimal argv. Useful for keeping the command line stable and readable.

**Recommendation:** Option B. It gives deterministic argv, correct process-group handling
for teardown, and avoids depending on `RpcClient`'s internal spawn shape. Reuse
`RpcClient`'s protocol types and correlation logic, not its process management.

## Process-group teardown

`safehouse` + `pi` + Pi's tool subprocesses form a tree. Closing stdin is orderly for Pi,
but a wedged session needs a hard stop:

```
spawn with detached: true → kill(-pgid, SIGTERM) → grace → kill(-pgid, SIGKILL)
```

Pi Central must reap the whole group. An orphaned sandboxed child could otherwise keep
writing to its workdir after the UI shows it as stopped.

## Verification harness

Before any UI work, prove the core claim — **two sessions, two independent profiles**:

1. Spawn `safehouse --workdir /repo-a -- pi --mode rpc`.
2. Spawn `safehouse --workdir /repo-b -- pi --mode rpc`.
3. Via RPC `bash`, attempt to read `/repo-b` from the session in `/repo-a`.
4. Expect denial in both directions, and success within each own workdir.
5. Confirm `--explain` output differs per process.

If step 4 fails, the per-session isolation premise is wrong and the design must be
revisited before proceeding. Track this as the first milestone in
[ROADMAP.md](ROADMAP.md).
