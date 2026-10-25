# ADR-0001 — Orchestrate out-of-process rather than in-process

- **Status:** Accepted
- **Date:** 2026-06-24
- **Supersedes:** none

## Context

Pi offers two integration paths: the in-process [SDK](https://pi.dev) and
[CLI Integration](https://pi.dev) (print, JSON, RPC). The SDK would let Pi Central hold
many `AgentSession` objects in one Node process, switching between them directly.

Pi Central must supervise sessions that live in **different working directories**, each
sandboxed by Safehouse with a policy composed for its own directory.

macOS Seatbelt does not nest: a process already inside `sandbox-exec` cannot apply another
profile, and Safehouse documents this as unfixable via allow rules (see
[CONSTRAINTS.md](../CONSTRAINTS.md#c1--macos-seatbelt-does-not-nest)).

An in-process SDK host is itself one process under one Seatbelt profile. Any session it
creates with a different `cwd` runs under the **host's** profile — unconfined relative to
its own working directory. That is precisely the failure Pi Central exists to prevent.

## Decision

Pi Central supervises sessions **out-of-process**, as separate `safehouse` invocations
speaking Pi's RPC protocol. It does not host sessions in-process.

Concretely:

- Each session = one `safehouse [policy] -- pi --mode rpc` process.
- Pi Central is a parent supervisor, never a host.
- Pi Central itself runs outside any sandbox and therefore holds no untrusted content.

## Consequences

**Positive**

- Per-session sandboxing is real, because each session is its own `sandbox-exec` root.
- A crashing or wedged session cannot take down the supervisor or its siblings.
- Pi's own process isolation (tools, extensions, subagents) is preserved intact.
- No dependency on SDK internals; the wire protocol is a documented, versioned surface.

**Negative**

- Pi Central must implement process supervision: spawn, reap, restart policy, stdio
  framing (LF-only), backpressure, and process-group teardown.
- No shared memory: everything crosses a JSONL boundary, including events at delta
  granularity.
- One process per session has real memory cost. Acceptable for a local, single-user tool
  with on the order of tens of sessions.
- `RpcClient` cannot be used for process management as-is, since it spawns Pi directly
  (see ADR-0003).

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| In-process SDK host | Violates per-session isolation (C1). The core requirement. |
| One shared Pi process with `switch_session` per cwd | `switch_session` reopens with the header's `cwd`; cannot multiplex directories (C2). |
| Sandbox the orchestrator and grant it all workdirs | Destroys per-session isolation — one grant set shared by all (see ADR-0002). |
| Run Pi in a container instead of Seatbelt | Would allow nesting, but abandons the existing bespoke Safehouse policy. Revisit only if nesting becomes required. |
