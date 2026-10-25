# Pi Central

> The central station where Pi sessions come together and are orchestrated.

Pi Central is a local dashboard for running, watching, and switching between multiple
[Pi](https://pi.dev) coding-agent sessions that live in **different working directories**,
while keeping every session inside its own **Agent Safehouse** sandbox.

The name is the design brief: a central station is where independent lines arrive, are
dispatched, and are kept apart from one another. Pi Central does the same for agent
sessions.

## The problem

Pi has no fleet concept. One `pi` process owns one session and one working directory:

- Sessions are JSONL files grouped by working directory under `~/.pi/agent/sessions/`.
- RPC mode (`pi --mode rpc`) is a long-lived child process speaking JSONL over stdio.
- There is **no daemon, no attach protocol, no socket registry, and no port**. Each RPC
  process privately owns its own stdin/stdout.

So working on three repositories means three terminals, three scrollbacks, and no single
place to see what is running, what is waiting for approval, or how much context each
session has burned.

## The non-obvious constraint

macOS Seatbelt sandboxing does **not nest**. A process already inside `sandbox-exec`
cannot apply a second profile — `sandbox_init` returns `EPERM`. Safehouse's own Electron
profile documents this as not fixable with additional allow rules.

This single fact rules out the obvious design (a Pi extension that hosts other sessions
in-process) and dictates the architecture: **the orchestrator must live outside any
sandbox, and each session must be its own `safehouse` invocation.** See
[docs/CONSTRAINTS.md](docs/CONSTRAINTS.md).

## Design in one picture

```
┌──────────────────────────────┐
│  Pi Central UI (localhost)   │  session rail · transcript · approvals
│  React + Vite, TypeScript    │  Markdown + Shiki, sanitized (ADR-0006)
└──────────────┬───────────────┘
               │  WebSocket over loopback (typed envelopes)
┌──────────────▼───────────────┐
│  Orchestrator (unsandboxed)  │  session registry · process supervision
│  TypeScript on Node          │  · one sandboxed pi process per session
└──────────────┬───────────────┘
               │  spawn: safehouse --workdir <cwd> -- pi --mode rpc
     ┌─────────┼─────────┐
     ▼         ▼         ▼
  ┌──────┐  ┌──────┐  ┌──────┐
  │ pi   │  │ pi   │  │ pi   │   one sandbox per working directory
  │ /a   │  │ /b   │  │ /c   │   isolation preserved per session
  └──────┘  └──────┘  └──────┘
```

Each session gets a correctly composed Safehouse profile for its own workdir. The
orchestrator never runs untrusted content, so being outside the sandbox is safe by
construction.

See [docs/STACK.md](docs/STACK.md) for the language and library choices.

## Status

**Planning.** No implementation yet. This repository currently holds the design,
constraints, protocol notes, and decision records that the implementation will follow.

Start here:

| Document | What it covers |
|---|---|
| [docs/CONSTRAINTS.md](docs/CONSTRAINTS.md) | The Seatbelt nesting limit and its consequences (C1–C8) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, trust boundaries, lifecycle |
| [docs/STACK.md](docs/STACK.md) | TypeScript/Node orchestrator, React UI, rendering pipeline |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | The Pi RPC surface Pi Central depends on |
| [docs/SANDBOX.md](docs/SANDBOX.md) | How safehouse is invoked per session |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phases from spike to UI |
| [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md) | Unresolved decisions |
| [docs/decisions/](docs/decisions/) | Architecture decision records |

## Principles

1. **Isolation is the feature.** Never trade per-session sandboxing for convenience.
2. **The orchestrator is the trust boundary.** It stays local, holds no untrusted
   content, and never executes model output.
3. **Pi is the source of truth.** Do not re-implement session semantics; consume RPC
   and the persisted session tree.
4. **Additive, not a replacement.** Pi Central supervises `pi`; it does not fork it.
5. **Local first.** No telemetry, no network egress beyond providers Pi already calls.
6. **Untrusted content is inert.** Transcripts and file contents are strings to display,
   never markup to execute — see [ADR-0006](docs/decisions/0006-untrusted-markdown-rendering.md).
7. **Confine the agents, not the user.** Safehouse constrains model-generated actions in a
   workdir. The orchestrator is a user-level app acting as the user, on the user's files —
   see [ADR-0007](docs/decisions/0007-filesystem-access-model.md).

## License

MIT — see [LICENSE](LICENSE).
