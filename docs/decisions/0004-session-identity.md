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

- **In-process:** the supervisor holds at most one live process per `(sessionPath, cwd)`.
  A resume for a session this instance already supervises returns the existing session
  rather than spawning a second (`Supervisor#findLiveByPath`).
- On resume, verify the directory still exists before spawning; surface a clear error if
  not (rather than letting `assertSessionCwdExists` fail inside Pi).
- Fork across projects uses `SessionManager.forkFrom`; never hand-edit a header `cwd`.

### What is NOT enforced, and cannot be

The guarantee covers sessions **this orchestrator spawned**. It cannot cover a `pi` started
by hand in a terminal (the C3 situation), because nothing in the system can detect it:

- Pi takes **no file lock** on a session file (`core/session-manager.js` has no
  `flock`/`O_EXCL`; `appendFileSync` at line 812 is unconditional), so there is no lock to
  contend for.
- Pi holds the file **open only for the instant of each append** — `appendFileSync` opens,
  writes, and closes. So `lsof` shows nothing even while a live Pi is actively writing it.
  There is no OS-level signal to read.

Two writers on one append-only file are therefore possible, and undetectable in advance.
This is a real limitation, not a solved problem: the invariant is enforced among Pi
Central's own sessions and stated honestly as unenforceable beyond them.

A Pi-Central-owned lock was considered and **rejected**. It would be a protocol with
ourselves: Pi would not take it, so it cannot prevent the one case that actually matters (a
foreign writer). It would add lock lifecycle, stale detection, pid-reuse handling, a new
failure mode (a stale lock blocking a legitimate resume), and a storage location that
cannot live in `~/.pi` (C6) — all to guard the contrived two-Pi-Central-instances case,
which `findLiveByPath` does not already cover. Same complexity-to-coverage test that
rejected the filesystem sidecar in [ADR-0007](0007-filesystem-access-model.md).

See [C9](../CONSTRAINTS.md#c9--session-files-are-unlocked-append-only-and-unwatchable) for
the underlying constraint.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Identify by session ID only | Loses the placement dimension; insufficient to compose a profile. |
| Identify by session file path only | Ambiguous if a header's `cwd` and the file's location disagree; the header must win. |
| Identify by working directory only | Many sessions per directory; cannot address one. |
| Treat `cwd` as switchable per process | Contradicted by C2 and by `assertSessionCwdExists` semantics. |
