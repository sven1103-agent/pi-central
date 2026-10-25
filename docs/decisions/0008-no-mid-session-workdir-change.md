# ADR-0008 — No mid-session working-directory change

- **Status:** Accepted
- **Date:** 2026-06-25
- **Supersedes:** none
- **Rejects:** US-2 (*Set the working directory in one step*)

## Context

[US-2](../USER-STORIES.md) asked for changing a session's working directory without losing
its context: start somewhere convenient, move to the right place once you know what you are
doing. Two mechanisms looked available:

- **Resume with a new cwd** — the design note claimed `switch_session` accepts a
  `cwdOverride`. **This is false in RPC mode.** `cwdOverride` appears only in
  `dist/modes/interactive/interactive-mode.js:4771`; it is not in the RPC command union
  (`modes/rpc/rpc-types.d.ts`) and not in the handler, which calls
  `runtimeHost.switchSession(command.sessionPath)` with **no options**
  (`modes/rpc/rpc-mode.js:475`). The capability is interactive-only, alongside Pi's own
  "continue in current cwd" prompt. Pi Central drives RPC, so it cannot have it.
- **Fork into another directory** — `SessionManager.forkFrom(sourcePath, targetCwd, …)`
  does exist and is exported. It writes a **new** session file with a new ID whose header
  carries the target cwd and whose body copies the source entries. This is what Pi's own
  `--fork` uses.

So the real choice was never "override vs fork". It was **fork-and-abandon-the-old-file**,
or nothing.

## Decision

**Pi Central does not change a running session's working directory.** There is no
mid-session re-target: not via override (unavailable over RPC), and not via automatic fork
(rejected below). A session's working directory is fixed at spawn and immutable for the
life of the process.

To work in a different directory, the user **starts a session there**. Starting is the
cheap path by design ([US-1](../USER-STORIES.md)), so this costs one action, not a lost
context tree.

## Rationale

**1. It is a live policy swap, and those are the worst kind.** The working directory is the
sole input to `composePolicy`, and therefore the sole determinant of the sandbox
(ADR-0002, ADR-0004). Changing it means tearing down one policy and composing another
against a *different tree* while a model — which may be under the influence of injected
content from the **old** tree — is still running. Every prompt-injection story starts from
"content the agent has already read". Re-targeting is the one operation that lets that
agent's influence carry into a new, differently-privileged scope.

**2. It dissolves a boundary that is currently unconditional.** Pi Central can today assert
*"this session's sandbox was composed for the directory it was spawned in, and never
changed."* That is a simple, checkable invariant. Mid-session switching replaces it with
*"…composed for the directory it was spawned in, unless it was moved, in which case the
policy in force is the most recent one, over a history that spans two trees."* The second
sentence cannot be enforced by a policy — it is enforced by trusting the orchestrator's
bookkeeping. That is a much weaker guarantee for a feature nobody asked for by name.

**3. The safe sub-case does not justify the unsafe one.** The tempting use is narrow: a
session that has written nothing, moving from the scratch default to its real project. But
"has written nothing" is not knowable. The agent may have read files in the old scope,
kept them in context, and be one turn away from acting on them — and the old scope's
contents are exactly what the new scope must not inherit. A feature whose safe use requires
proving a negative is not a safe feature.

**4. `forkFrom` leaks another session file.** Forking "moves" the conversation by copying
it, leaving the original behind. Under session identity = `(session file, cwd)`
(ADR-0004), this silently changes identity, and the abandoned file reappears in discovery
([US-4](../USER-STORIES.md)) forever. A "move" that leaves a full copy of the transcript in
the old project is not a move; it is a copy. Cleaning up the source would mean deleting a
session file Pi Central did not create, which crosses a line this project has not agreed to
cross.

**5. It is not required now, and the requirement was soft.** US-2 was rated high, but its
value rested on a *cheap* alternative existing. Starting a correctly-placed session is that
alternative, and it is now the primary path. Deferring an irreversible, security-relevant
operation until someone actually needs it is the correct default — and if it is revisited,
it should be revisited as its own ADR with its own threat model, not slipped into Phase 1.

## Consequences

**Positive**

- The sandbox invariant stays unconditional and checkable: **one process, one directory,
  one policy, for the whole life of the session.**
- No untrusted content path can influence which directory a session later holds.
- Session identity stays stable. No forked-file proliferation, no orphans in discovery.
- Phase 1 shrinks: the riskiest Phase 1 bullet disappears.

**Negative**

- A user who starts in the default workspace and then realizes the work belongs in a repo
  must start a new session there. Context does not carry over. This is a real cost and it is
  accepted deliberately.
- The transcript of the first attempt remains in the scratch workspace until the user
  deletes it ([US-3](../USER-STORIES.md) offers that as an explicit action).

## Effect on the missing-directory case (US-5)

This simplifies it. [US-5](../USER-STORIES.md) previously offered *"continue in another
directory (US-2) or cancel"* when a session's recorded cwd is gone. With US-2 rejected, the
honest choice is:

- resume in its recorded cwd if it exists, or
- **cancel**, with a clear explanation that the directory is gone.

The user who wants that work elsewhere starts fresh in the directory they mean. Pi Central
never silently retargets — including here, where retargeting is what Pi's *interactive* mode
would do on its own. The recorded cwd is still validated **before** spawn (D-4), because RPC
mode exits `1` on a missing cwd rather than prompting (C2, `dist/main.js:558`).

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| `switch_session` + `cwdOverride` | Not reachable over RPC. `cwdOverride` is interactive-only (`interactive-mode.js:4771`); the RPC handler passes no options. |
| Automatic `SessionManager.forkFrom` into the target dir | Live policy swap across a history spanning two trees, plus a leaked source file and a changed session identity (ADR-0004). |
| Fork only when the session "has not written anything" | Cannot be established reliably: the agent may hold files from the old scope in context. |
| Kill and respawn in the new cwd, replaying the transcript | Re-injects the old tree's contents into a process holding the new tree's policy — the exact hazard this ADR exists to prevent. |
| Keep the old policy and only change the displayed path | Dishonest: the UI would show a directory the sandbox does not grant. |
