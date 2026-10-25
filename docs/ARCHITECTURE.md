# Architecture

## Component overview

```
┌──────────────────────────────────────────────────────────────┐
│  Pi Central UI            (browser, 127.0.0.1 only)          │
│  session rail · transcript · composer · approval dialogs     │
└───────────────────────────┬──────────────────────────────────┘
                            │ WebSocket (JSONL relay + control)
┌───────────────────────────▼──────────────────────────────────┐
│  Orchestrator             (unsandboxed, one per user)        │
│                                                              │
│  ┌────────────────┐  ┌──────────────────┐  ┌──────────────┐  │
│  │ Session        │  │ Process          │  │ Safehouse    │  │
│  │ Registry       │  │ Supervisor       │  │ Launcher     │  │
│  │ listAll()      │  │ RpcClient × N    │  │ policy build │  │
│  └────────────────┘  └──────────────────┘  └──────────────┘  │
└───────┬───────────────────────┬──────────────────────┬───────┘
        │ spawn                 │ spawn                │ spawn
┌───────▼───────┐       ┌───────▼───────┐      ┌───────▼───────┐
│ safehouse     │       │ safehouse     │      │ safehouse     │
│  workdir /a   │       │  workdir /b   │      │  workdir /c   │
│ └─ pi --rpc   │       │ └─ pi --rpc   │      │ └─ pi --rpc   │
└───────────────┘       └───────────────┘      └───────────────┘
```

## Trust boundaries

There are exactly two, and they must not be blurred.

| Boundary | Inside | Contains untrusted content | May write outside its workdir |
|---|---|---|---|
| **Orchestrator** (unsandboxed) | registry, supervisor, launcher, transport | **No** | n/a — it writes nothing but its own state |
| **Session** (safehouse) | Pi, its tools, model output, extensions | **Yes** | No — scoped by profile |

Rules that follow from this:

1. The orchestrator **never** executes model output, shell strings from transcripts, or
   file contents from a workdir.
2. The orchestrator **only** spawns `safehouse`, `pi`, and nothing derived from
   untrusted input.
3. The UI is a **client** of the orchestrator. If the orchestrator binds a port, that port
   is the attack surface and must be loopback-only with an explicit check.
4. Model output reaches the UI as a **string** for display, never as a command.

## Session supervision

One `RpcClient` per supervised session. RPC is the control plane; the session file is the
history plane.

### States

| State | Meaning | Transitions |
|---|---|---|
| `registered` | File known from `listAll()`, no process | → `starting` |
| `starting` | `safehouse` spawned, awaiting first `get_state` | → `idle` / `failed` |
| `idle` | Process up, `isStreaming: false`, settled | → `streaming` / `stopped` |
| `streaming` | Run in progress | → `idle` on `agent_settled` |
| `awaiting-approval` | Extension UI dialog outstanding | → `streaming` / `idle` |
| `failed` | Spawn error or nonzero exit | → `starting` (retry) / `stopped` |
| `stopped` | stdin closed, process reaped | → `starting` |

`awaiting-approval` is a first-class state, not a modal. It is the highest-value signal a
central station can surface: which session needs a human.

### Restart policy

On unexpected exit, Pi Central does **not** silently restart. It surfaces the failure with
stderr and offers a manual retry. Automatic restart would replay a prompt into a changed
working directory, which is a safety hazard, not a convenience.

## Data planes

| Plane | Source | Direction | Trust |
|---|---|---|---|
| Control | UI → orchestrator → RPC stdin | command | trusted (user intent) |
| Events | RPC stdout → orchestrator → UI | stream | untrusted (model output) |
| History | session JSONL files | read | untrusted |
| Approval | conversion UI request ↔ response | request/response | trusted (human) |

Control and events are **separate directions on the same socket** with different trust
levels, so the transport must distinguish them structurally (typed envelopes), not by
convention.

## Session registry

Two sources, deliberately:

1. **Persisted** — `SessionManager.listAll()` (exported from
   `@earendil-works/pi-coding-agent`) returns `SessionInfo[]` with `path`, `id`, `cwd`,
   `name`, `modified`, `messageCount`, `firstMessage`. This is the full history for the
   switcher.
2. **Live** — the supervisor's own map of running `RpcClient`s. This is the only source of
   truth for "is it running", because Pi has no daemon (C3).

The UI merges them: a session row is *historical* if only in (1), *live* if in (2).

`get_state` per live process supplies `model`, `thinkingLevel`, `isStreaming`,
`sessionName`, `messageCount`, `pendingMessageCount` for the rail.

## Working-directory handling

Because of C2, cwd is a property of the **process**, decided at spawn:

```
new session in /path/to/repo
  → resolve + verify cwd exists
  → compose safehouse profile for that cwd
  → spawn: safehouse <policy args> -- pi --mode rpc --name <name>
  → RpcClient wraps the process; first get_state confirms cwd
```

Resuming an existing session uses the same path: the session header's `cwd` is read
first, the profile is composed for it, and the process is spawned there.

## Deferred decisions

The orchestrator's transport (stdio vs local socket vs HTTP+WS) and whether the UI is a
TUI, a browser app, or both are open — see [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md). The
constraint that binds all options: **whichever surface is chosen must not run inside a
sandbox** (C1).
