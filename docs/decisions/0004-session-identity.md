# ADR-0004 — A session is identified by (session file, working directory)

- **Status:** Accepted
- **Date:** 2026-06-24
- **Supersedes:** none

## Context

Pi Central's UI needs a stable identity for a session. Candidates:

- **Session ID** — a UUID, unique, from the session header.
- **Session file path** — unique, and the actual handle `switch_session` takes.
- **Working directory** — shared by many sessions in the same project.
- **Display name** — user-editable, optional, not unique.

The complication is C2: a running RPC process is bound to the working directory recorded in
its session header. `switch_session` reopens by header `cwd`, and `assertSessionCwdExists`
requires that directory to exist and be reachable.

## Decision

A session is identified by the pair **`(sessionPath, cwd)`**, where `cwd` is read from the
session header.

- `sessionPath` is the durable handle (what `switch_session` accepts, what the file is).
- `cwd` is the **placement** dimension — it decides the sandbox profile and the spawn
  directory, and it is a property of the process, not something switchable in place.

Consequences for the UI:

- The rail groups by `cwd` (project), since that is the isolation unit.
- Switching the focused session **within** a project may be able to reuse a process.
- Switching **across** projects always means a different process — Pi Central never
  pretends otherwise.
- The session header is authoritative. Pi Central reads `cwd` from it before spawning, and
  never assumes the orchestrator's own cwd.

## Consequences

**Positive**

- The identity carries the information that determines sandboxing, so a profile can never
  be composed for the wrong directory.
- Resuming a historical session is well-defined: read header → compose profile → spawn.
- Prevents an entire class of bug where a session is shown under one project while its
  process is writing under another.

**Negative**

- The pair must be kept consistent when a session is forked or cloned into another project.
  `SessionManager.forkFrom(sourcePath, targetCwd, …)` exists for this and produces a new
  file with the target cwd — Pi Central must use it rather than rewriting a header.
- Two live processes for the same `(sessionPath, cwd)` would corrupt the session file.
  The supervisor must enforce **at most one live process per session** (see below).

## Enforcement

- Supervisor invariant: one live process per `(sessionPath, cwd)`. Attempting a second
  spawn for a live pair focuses the existing one instead.
- On resume, verify the directory still exists before spawning; surface a clear error if
  not (rather than letting `assertSessionCwdExists` fail inside Pi).
- Fork across projects uses `SessionManager.forkFrom`; never hand-edit a header `cwd`.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Identify by session ID only | Loses the placement dimension; insufficient to compose a profile. |
| Identify by session file path only | Ambiguous if a header's `cwd` and the file's location disagree; the header must win. |
| Identify by working directory only | Many sessions per directory; cannot address one. |
| Treat `cwd` as switchable per process | Contradicted by C2 and by `assertSessionCwdExists` semantics. |
