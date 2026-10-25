# Phase 1 smoke test

Run this from a **plain terminal**, not from inside Pi or another sandbox. Seatbelt does not
nest (C1), so `sandbox-exec` fails with `Operation not permitted` from anywhere sandboxed.
The CLI detects nothing about this; it just fails, and the failure looks like a Pi problem
when it is an environment one.

Everything here is safe to run. `run` creates a session in the app-owned workspace; `resume`
only ever reads its own recorded directory.

## 0. Unit tests and typecheck (safe anywhere)

```bash
cd pi-central
npm test          # node --test across packages
npm run typecheck # tsc --noEmit
```

Expect: 65 tests pass, no type errors. These spawn nothing.

## 1. Discovery against the real store (safe anywhere)

```bash
node packages/orchestrator/src/cli.ts history
```

Expect a list of sessions with their directories, and a count. On this machine: ~500 shown,
0 skipped. Sessions whose directory is gone are flagged `MISSING-CWD` — that flag is the
US-5 case, and it is common.

## 2. Start a scratch session in the default workspace (needs a plain terminal)

```bash
node packages/orchestrator/src/cli.ts run --prompt "Reply with exactly: PI CENTRAL OK"
```

Expect:

- `started s1 in /Users/<you>/.local/share/pi-central/workspaces/s1`
- `isolation: Safehouse workdir=…` — **not** `NONE`
- settled with a reply

Then check it landed where US-3 says, and nowhere else:

```bash
ls -la ~/.local/share/pi-central/workspaces/
ls ~/.local/share/pi-central/workspaces/s1   # the session file is NOT here; sessions live in ~/.pi
```

**The thing to verify:** the workspace contains no stray files, and nothing was written to
`$HOME` proper. A scratch session must not hold a policy over your home directory.

## 3. Start in a real project (needs a plain terminal)

```bash
node packages/orchestrator/src/cli.ts run --cwd ~/git/some-repo --prompt "What is in this directory?"
```

Expect the isolation line to name that workdir. The agent can read it; it cannot reach the
scratch workspace from step 2, nor any other project.

## 4. Resume a historical session (needs a plain terminal)

Pick an id from step 1 that is **not** flagged `MISSING-CWD`:

```bash
node packages/orchestrator/src/cli.ts resume <id-prefix>
```

Expect it to reopen in its own recorded directory — not the default workspace, not the
current shell directory.

Then the trap (US-5). Pick one flagged `MISSING-CWD`:

```bash
node packages/orchestrator/src/cli.ts resume <id-prefix>
```

Expect a refusal **before** anything spawns:

```
Cannot resume this session.

The directory this session worked in no longer exists:
  /some/gone/path

Restore it, or start a new session in the directory you want to work in.
Pi Central does not move a session between directories.
```

If instead you see a raw `MissingSessionCwdError` from Pi or an exit code 1 with no
explanation, the pre-flight check is not running and that is a bug worth reporting.

## 5. Three sessions, three directories, no cross-talk (needs a plain terminal)

The isolation claim is already proven for two sessions in
[`spikes/phase-0/RESULT.md`](../../spikes/phase-0/RESULT.md). The supervisor-level version —
three sessions driven concurrently, each confirming it cannot see the others — is the one
Phase 1 item that still needs a hand.

### What to look for

1. Three sessions run at once, each in its own directory, each answering.
2. Each one, asked to read a sibling's directory, is **denied**.
3. None of the three shares a policy line with another (the `isolation:` lines differ).
4. Stopping one leaves the others running.

If a session can read another's workdir, the supervisor is composing the wrong policy, and
that is the one failure that invalidates the design rather than merely disappointing.
