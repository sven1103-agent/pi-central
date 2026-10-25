# Orchestrator internals

Phase 1: supervise N sessions headlessly. No UI, no transport. The pieces below are each
separately testable, and each maps to a constraint — that mapping is the point, not
decoration.

| Module | Responsibility | Honours |
|---|---|---|
| `config.ts` | Config, and the app-owned default workspace | US-3, D-5 |
| `framing.ts` | LF-only JSONL reader/writer | C7 |
| `registry.ts` | Discover session files; merge with live processes | C3, ADR-0009 |
| `policy.ts` | Compose Safehouse argv for one workdir | C4, ADR-0002, ADR-0004 |
| `rpc.ts` | One supervised `pi --mode rpc` process | ADR-0003 |
| `supervisor.ts` | State machine, `agent_settled` gating, teardown | C8, ARCHITECTURE.md |
| `resume.ts` | Validate recorded cwd before spawning | US-5, D-4, C2 |
| `cli.ts` | Smoke command: start, prompt, observe | ROADMAP Phase 1 |

## Two rules that keep this honest

**1. `policy.ts` is the only place Safehouse argv is assembled.** If a second call site
appears, the guarantee that every session's grant set is derived from exactly one function
is gone.

**2. The orchestrator imports no Pi runtime.** `@earendil-works/pi-coding-agent` is a
`devDependency`, imported with `import type` only (ADR-0005, ADR-0009). The sole runtime
contact with Pi is the `pi --mode rpc` child process. A test asserts this.

## Running

```bash
node --test packages/orchestrator/test/*.test.ts   # unit tests
npm run typecheck                                   # tsc --noEmit
node packages/orchestrator/src/cli.ts --help         # smoke command
```

The smoke command **spawns real sandboxed sessions**, so it must run from a plain terminal:
`sandbox-exec` cannot nest, so a session cannot start from inside another sandbox (C1).
