# ADR-0005 — TypeScript + Node orchestrator, TypeScript + React UI

- **Status:** Accepted
- **Date:** 2026-06-24
- **Supersedes:** none

## Context

Pi Central needs a language and framework for two halves: (1) an orchestrator that
supervises sandboxed Pi processes and speaks the RPC protocol, and (2) a UI that shows
live transcripts, renders Markdown with syntax highlighting, and browses files.

Requirements that constrain the choice:

- **Type reuse.** ADR-0003 commits Pi Central to importing Pi's exported protocol types
  (`RpcCommand`, `RpcResponse`, `RpcSessionState`, `JsonAgentSessionEvent`, the extension
  UI unions) so protocol drift surfaces at type-check time. Those types are TypeScript
  `.d.ts`.
- **Process spawning with exact argv and process groups.** `SAFEHOUSE_*` env, `--`, and
  `kill(-pgid)`.
- **JSONL streaming** with LF-only framing (C7) and backpressure on both pipes.
- **WebSocket** transport to a browser UI.
- **Markdown + syntax highlighting** in a browser.
- **File navigation** over a session's working directory, at the user's UID (ADR-0007).
- One maintainer. Minimize the number of runtimes, toolchains, and packaging stories.

Verified environment: Pi `1.4.0`, `engines.node >= 22.19.0`, ESM (`"type": "module"`),
local `node v26.12.1`. The sibling `pi-metrics` project in the same org is already
TypeScript + Node with `tsc --noEmit` and `node` test scripts.

## Decision

**Orchestrator:** TypeScript on Node (ESM), no framework. One process that owns the
session registry, the supervisor, and a loopback HTTP + WebSocket server.

**UI:** TypeScript + React + Vite, served as static assets by the orchestrator in
production and by the Vite dev server (proxying WS) in development.

**Transport:** WebSocket over loopback, with typed envelopes distinguishing control
(trusted intent) from events (untrusted output) — see ARCHITECTURE.md "Data planes".

**Rendering:** `markdown-it` for Markdown, **Shiki** for syntax highlighting,
**DOMPurify** for sanitization. See ADR-0006 for why sanitization is mandatory.

**Shared package:** one `packages/protocol` workspace holding the envelope types and the
generated/adapted Pi RPC types, imported by both halves. A monorepo is warranted here
because the orchestrator and UI genuinely share a contract.

Dependencies are kept deliberately small: `ws`, `markdown-it`, `shiki`, `dompurify`,
React, Vite. No ORM, no state-management library beyond React primitives, no CSS
framework.

## Why TypeScript, specifically

1. **It is the only language that gets Pi's protocol types for free.** In any other
   language, the entire RPC surface in PROTOCOL.md would be hand-transcribed and would
   silently drift.
2. **Same runtime as Pi.** No second runtime to install, version, or reason about. Node's
   `child_process` gives the process-group and backpressure control the supervisor needs.
3. **The UI must be a browser** (approval dialogs, long transcripts, Markdown). Once the
   UI is TypeScript, sharing envelope types across the boundary removes a whole class of
   integration bug.
4. **Toolchain already exists** in this org (`pi-metrics`), so CI, packaging, and review
   conventions transfer.

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| **Go or Rust orchestrator** | Excellent process control and single-binary distribution, but forfeits Pi's protocol types and makes the shared-contract argument moot. The supervisor is not CPU-bound, so the performance argument does not apply. |
| **Python orchestrator** | Workable (`asyncio` subprocesses), but same type-loss problem, plus a second runtime and a weaker story for sharing types with the UI. |
| **Java / Vaadin** | A legitimate option in this environment (Vaadin tooling is present), and strong for server-driven browser UI. Rejected here because it loses the TypeScript protocol types, adds a JVM build alongside Node, and duplicates ceremony for what is a thin supervisor plus a transcript view. Revisit only if Pi Central grows into a multi-user service. |
| **Electron or Tauri shell** | Native packaging and filesystem access, at the cost of a large distribution and a second sandboxing surface to reason about — directly at odds with ADR-0002's "minimize what runs unsandboxed". |
| **Terminal TUI only** | Matches how Pi is already used and avoids the browser entirely, but renders Markdown and syntax highlighting in ANSI (poorly, and only via `pi-tui`'s `marked` + `Theme`), and makes rich approval dialogs (`select`/`confirm`/`editor`) awkward. |
| **Vue or Svelte UI** | Fine choices; React chosen only for familiarity and the availability of `DOMPurify`/`Shiki` integration examples. Not a load-bearing decision. |

## Consequences

**Positive**

- Protocol drift is a compile error, not a runtime surprise.
- One language, one package manager, one test runner across the repo.
- The UI's rendering requirements (Markdown, highlighting) are the browser's home turf.
- Browser-based approvals map cleanly onto the extension UI dialog subprotocol.

**Negative**

- A browser UI means an HTML rendering surface for **untrusted** model and file content.
  This introduces an XSS risk that a TUI does not have. ADR-0006 is mandatory, not
  optional.
- Shiki and its grammars add bundle weight; grammars must be loaded lazily.
- React + Vite + a monorepo is more moving parts than a single-file TUI would be.
- Node's `readline` is a trap (C7) and must never be used for the RPC stream.

## Operational constraint (important)

**The orchestrator must not be run under `safehouse`.** If it is, it inherits a Seatbelt
profile and can no longer spawn sandboxed sessions, because Seatbelt does not nest (C1).
It is started as a plain `node` process by the user.

This is easy to violate by habit in this environment, where Pi itself is normally launched
via `safehouse`. Startup should detect an inherited sandbox and refuse to run with a clear
message rather than failing later with `sandbox_apply: Operation not permitted`.
