# ADR-0003 — Custom process supervisor instead of `RpcClient`

- **Status:** Accepted
- **Date:** 2026-06-24
- **Supersedes:** none

## Context

`@earendil-works/pi-coding-agent` exports `RpcClient`, a typed wrapper that starts a Pi RPC
child process, correlates responses by `id`, and delivers events to listeners. It is the
supported way to drive RPC from Node.

Its spawn shape, however, is fixed:

```js
// dist/modes/rpc/rpc-client.js
const childProcess = spawn("node", [cliPath, ...args], {
  cwd: this.options.cwd,
  env: { ...process.env, ...this.options.env },
  stdio: ["pipe", "pipe", "pipe"],
});
```

It runs `node <cliPath> --mode rpc …` directly. Pi Central must instead run
`safehouse [policy] -- pi --mode rpc …`, with control over the policy argv, the sanitized
environment (C4), and the process group for teardown.

## Decision

Pi Central implements its **own** process supervisor and speaks the RPC JSONL protocol
directly. It reuses `RpcClient`'s **types** and **correlation patterns**, but not its
process management.

Reused:

- Protocol types: `RpcCommand`, `RpcResponse`, `RpcSessionState`, `JsonAgentSessionEvent`,
  the extension UI request/response unions from `dist/modes/rpc/rpc-types.d.ts`.
- The `id`-based request/response correlation pattern.
- The `promptAndWait` ordering insight: subscribe **before** `prompt` to avoid missing a
  fast completion.

Owned by Pi Central:

- Spawning `safehouse` with deterministic argv and an explicit environment.
- LF-only line framing (C7) — never `readline`.
- Process-group lifecycle (`detached`, `kill(-pgid, …)`).
- State machine and restart policy.
- Backpressure on both pipes.

## Consequences

**Positive**

- Exact control over the sandbox invocation — the core requirement.
- Deterministic argv means the Safehouse profile is inspectable and reproducible.
- Correct teardown of sandboxed grandchildren.
- No coupling to `RpcClient`'s internal spawn assumptions.

**Negative**

- More code to own: framing, correlation, timeouts, error mapping.
- Protocol drift risk: if Pi's RPC surface changes, Pi Central must track it. Mitigated by
  consuming the exported `.d.ts` types from the installed package, so a breaking change
  surfaces at type-check time.
- Must re-implement niceties `RpcClient` already provides (`waitForIdle`, `collectEvents`).

## Mitigations

- Import protocol **types** from the package rather than copying them, so `tsc` catches
  drift.
- Add a Pi-version compatibility check (as `pi-metrics` does) that asserts the expected
  command and event names are present.
- Keep the supervisor's protocol layer thin and separate from session semantics, so it can
  later be swapped for a shim-based `RpcClient` if that becomes preferable.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Use `RpcClient` with `cliPath` pointed at a safehouse shim | `RpcClient` builds argv in a fixed order and prepends `node`; the shim must parse and reorder, and `RpcClient` still owns the process group. Fragile for a security-critical launch path. |
| Fork `RpcClient` and patch its spawn | Divergence from upstream; maintenance burden for the least interesting layer. |
| Contribute a `spawnCommand`/`launcher` hook upstream | Best long-term outcome; noted as a possible follow-up, but Pi Central should not block on it. |
