# Stack

Language, framework, and library choices, with the reasoning. The decisions themselves are
recorded in [ADR-0005](decisions/0005-typescript-stack.md),
[ADR-0006](decisions/0006-untrusted-markdown-rendering.md), and
[ADR-0007](decisions/0007-filesystem-access-model.md); this page is the reference for
*what* the stack is.

## Summary

| Layer | Choice | Notes |
|---|---|---|
| Orchestrator | TypeScript on Node (ESM), no framework | Node ≥ 22.19.0, matching Pi |
| UI | TypeScript + React + Vite | Served as static assets in production |
| Transport | WebSocket over loopback (`ws`) | Typed envelopes: control vs events |
| Shared contract | `packages/protocol` workspace | Envelope types + adapted Pi RPC types |
| Markdown | `markdown-it`, `html: false` | No raw HTML, ever |
| Highlighting | Shiki, lazy grammars | Browser-oriented, unlike Pi's ANSI path |
| Sanitization | DOMPurify + strict CSP | Mandatory: transcripts are untrusted |
| File navigation | Plain `fs` at user UID | No sidecar; see [ADR-0007](decisions/0007-filesystem-access-model.md) |
| Tests | `node --test` + `tsc --noEmit` | Matches `pi-metrics` conventions |

Deliberately absent: no ORM (persistence is JSON), no state-management library (React
primitives suffice), no CSS framework, no bundler beyond Vite, no Electron/Tauri.

## Repository layout

```
pi-central/
├── packages/
│   ├── protocol/          # shared types: envelopes + Pi RPC contract
│   ├── orchestrator/      # registry, supervisor, safehouse launcher, WS server, file ops
│   └── web/               # React UI (Vite)
├── spikes/
│   └── phase-0/           # isolation proof harness (ROADMAP)
├── docs/
└── package.json           # npm workspaces root
```

## Why one runtime

The orchestrator is I/O-bound and spawn-heavy, not CPU-bound. Choosing Node buys three
concrete things and costs nothing meaningful:

1. **Pi's protocol types are TypeScript.** `RpcCommand`, `RpcResponse`, `RpcSessionState`,
   `JsonAgentSessionEvent`, and the extension UI unions are imported directly, so a
   breaking Pi upgrade fails `tsc` instead of silently corrupting the supervisor's
   understanding of the protocol.
2. **Same runtime as Pi.** No second toolchain, and `child_process` gives the process-group
   and backpressure control the supervisor needs.
3. **The UI has to be a browser**, so the shared contract between supervisor and UI is
   worth more than a second language.

Type import is the load-bearing point:

```ts
// packages/protocol/src/pi.ts
import type {
  RpcCommand,
  RpcResponse,
  RpcSessionState,
  JsonAgentSessionEvent,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
} from "@earendil-works/pi-coding-agent";
```

These are consumed as **types only** (`import type`), so Pi is a devDependency of the
protocol package and never enters the runtime bundle.

## Orchestrator internals

Built from small, separately testable pieces — each maps to a constraint:

| Module | Responsibility | Constraint it honours |
|---|---|---|
| `registry` | Merge discovered session files with live processes | C3, ADR-0009 |
| `policy` | Compose Safehouse argv + env for a workdir | C4, ADR-0004 |
| `supervisor` | Spawn, frame, correlate, reap | C7, C8 |
| `framing` | LF-only JSONL reader/writer | C7 (never `readline`) |
| `state` | Session state machine | ARCHITECTURE.md |
| `ws` | Loopback WebSocket server, typed envelopes | C5 |
| `dialogs` | Extension UI request/response relay | PROTOCOL.md |
| `files` | List, read, and operate on files at user UID | ADR-0007 |

**`policy` must be a single function.** It is consumed wherever a session is spawned, and
it is the only place Safehouse argv is assembled.

```ts
composePolicy(cwd: string, opts: SessionPolicyOptions): { argv: string[]; env: string[] }
```

Note that `policy` is used **only** for spawning sandboxed agents. The orchestrator's own
file I/O does not go through it — see [ADR-0007](decisions/0007-filesystem-access-model.md).

## UI internals

| Concern | Approach |
|---|---|
| Session rail | Grouped by `cwd`; live vs historical from registry |
| Transcript | Virtualized list; streaming tail rendered as plain text |
| Markdown | `markdown-it({ html: false })` → DOMPurify → React |
| Highlighting | Shiki, lazy grammar load, theme matching the UI |
| File tree | Lazy expansion; `fs` at user UID, confined to the session's `cwd` |
| Dialogs | Real modals for `confirm`/`select`/`input`/`editor` |
| Chrome | `notify`/`setStatus`/`setWidget` as non-blocking UI |

Rendering pipeline, in order — the order matters:

```
RPC event (untrusted string)
  → buffer deltas (throttled re-render)
  → markdown-it, html:false
  → DOMPurify
  → React children  ← the ONLY insertion point
```

No `dangerouslySetInnerHTML` outside this pipeline. A lint rule should enforce it.

## Operational rules

1. **The orchestrator is never run under `safehouse`** (C1). Start it as plain `node`.
   Detect an inherited sandbox at startup and refuse with a clear message — in this
   environment `pi` is normally launched via safehouse, so the mistake is easy to make.
   The orchestrator acts at the user's UID, on the user's files, for the user
   ([ADR-0007](decisions/0007-filesystem-access-model.md)).
2. Bind the WebSocket to `127.0.0.1` explicitly. Loopback is not a security control (C5);
   it is hygiene plus a prerequisite for the CSP's `connect-src 'self'`.
3. Never pass `--add-dirs` to the orchestrator (ADR-0002).
4. Confine file-browser paths to the session's `cwd` by canonicalizing and checking
   containment, not by string prefixes (ADR-0007).

## Package management

npm workspaces (not pnpm/yarn) to avoid introducing another package manager into an
environment that already uses npm. Root scripts:

```
npm run dev        # vite dev server + orchestrator with watch
npm run build      # protocol → web → orchestrator, in order
npm test           # node --test across workspaces
npm run typecheck  # tsc --noEmit across workspaces
```

## Compatibility

Follow `pi-metrics`' approach: assert the expected Pi RPC command and event names are
present at startup, and fail loudly rather than misbehaving when Pi's surface changes. Pin
the Pi version used for type-checking, and re-verify constraints C1–C13 when upgrading Pi or
Safehouse, since several ADRs rest on them.
