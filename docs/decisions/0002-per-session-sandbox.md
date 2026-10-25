# ADR-0002 — One sandbox per session; never a multi-workdir orchestrator sandbox

- **Status:** Accepted
- **Date:** 2026-06-24
- **Supersedes:** none

## Context

Given ADR-0001, the orchestrator sits outside the sandbox. That raises an obvious question:
should the orchestrator *also* be sandboxed, perhaps with read/write grants to every
working directory it supervises?

Safehouse supports this mechanically:

```
safehouse --workdir /repo-a --add-dirs /repo-b:/repo-c -- ui-server
```

The appeal is uniformity — "everything is sandboxed." The cost is that the grant set is
shared: the orchestrator, and any process it spawns, would hold simultaneous access to all
three workdirs.

## Decision

**No.** The orchestrator is not sandboxed, and the UI server it hosts is not sandboxed.
Isolation is enforced **per session process**, never by granting the orchestrator a union
of workdirs.

Rationale:

- A multi-workdir grant is exactly the union an attacker wants. One prompt injection
  reaching the orchestrator would reach every supervised project at once.
- Session grants stay minimal: each session sees its own workdir and nothing else.
- The orchestrator holds no untrusted content, so it does not need a filesystem boundary.
  Its boundary is that it processes **strings for display** and **spawns only fixed
  binaries**.

The exception that proves the rule: Safehouse's own `20-network.sb` allows loopback bind
and inbound. That means the UI server *would* bind successfully inside a sandbox, so
sandboxing it looks free. It is not free — it is the multi-workdir grant that is expensive.

## Consequences

**Positive**

- Blast radius of a supervisor compromise is bounded by the supervisor's own (small) code
  and the fixed commands it can run, not by a union of project directories.
- Session grants remain per-directory and therefore meaningful.

**Negative**

- The orchestrator is not protected by Seatbelt. Its safety is a **code property**:
  never `eval`, never shell-interpolate untrusted strings, never spawn anything not
  hard-coded.
- Reviewer burden: every new orchestrator feature must be assessed for whether it
  introduces a path from untrusted content to execution.
- Loopback binding is not a security control (C5); access control must be explicit.

## Enforcement

- A test asserts the orchestrator's spawn list contains only `safehouse`, `pi`, and fixed
  arguments — no interpolation of transcript or file content.
- A test asserts `--add-dirs` / `--add-dirs-ro` are never passed for the orchestrator.
- `wide-read` is rejected in configuration validation (it grants read on `/`).

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Sandbox orchestrator with union of workdirs | Union grant defeats per-session isolation; single point of total exposure. |
| Sandbox orchestrator with no workdir, UI only | Grants nothing useful and adds nesting constraints for children (C1). Net negative. |
| Per-request sandbox of orchestrator logic | No per-request sandboxing primitive on macOS; would require a container. |
