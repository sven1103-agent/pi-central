# ADR-0009 — Discovery parses session files directly; the orchestrator does not import Pi's agent core

- **Status:** Accepted
- **Date:** 2026-06-25
- **Supersedes:** none
- **Refines:** [ADR-0002](0002-per-session-sandbox.md), [ADR-0005](0005-typescript-stack.md)

## Context

[ARCHITECTURE.md](../ARCHITECTURE.md) and [STACK.md](../STACK.md) say session discovery
uses `SessionManager.listAll()` from `@earendil-works/pi-coding-agent`. That import is not
a type-only import: `listAll` is a runtime function, so using it means the **unsandboxed,
privileged** orchestrator loads Pi's full agent core at runtime.

Measured on this machine (Pi `1.4.0`):

```
import "./dist/core/session-manager.js"  ->  191 ms,  35 MB RSS,  fine
import "@earendil-works/pi-coding-agent" ->  500 ms,  92 MB RSS,  157 exports
```

Two problems, one of them the important one:

1. **Cost.** Half a second and ~92 MB of agent core loaded into a process whose only job is
   supervision and file I/O.
2. **Trust surface.** ADR-0002 states the orchestrator "holds no untrusted content" and is
   safe precisely because it is small and does only three things. Pulling in Pi's agent
   runtime — tools, providers, MCP, extension loading — to count session files contradicts
   that. The orchestrator would gain a large attack surface for a feature that needs a
   directory listing.

`listAll` also uses `readline`-style CRLF-tolerant reading (`createInterface`), whereas the
project's own framing rule is LF-only (C7) for **RPC**. Different problem, but it confirms
discovery was never required to share machinery with the control plane.

## Decision

**Discovery is implemented in Pi Central by reading session files directly.** The
orchestrator parses `~/.pi/agent/sessions/<encoded-cwd>/*.jsonl` with plain `fs`, mirroring
Pi's directory encoding and JSONL shape. Pi is a **type-only** dependency of the protocol
package and never enters the orchestrator's runtime graph.

Fields Pi Central needs, all recoverable from the file head plus a scan for
`session_info`:

| Field | Source |
|---|---|
| `id`, `cwd`, `timestamp` | the `session` header (first record) |
| `name` | latest `session_info` entry, if any |
| `firstMessage` | first `message` entry with `role: "user"` |
| `messageCount`, `modified`, `size` | `stat` + counting `message` entries |

Measured: **~700 ms for 500 sessions**, no Pi import, streaming reads that cap the head at
64 KB.

### A parser trap, found while verifying this

Pi creates a **sidecar directory next to each session file**, whose name is the session
file name with the `.jsonl` suffix dropped, holding subagent runs:

```
--Users-sven1103-git-idea-factory-typescript--/
  2026-09-20T07-20-23-082Z_01a0bdaf-….jsonl          <- the session file
  2026-09-20T07-20-23-082Z_01a0bdaf-…/              <- sidecar DIR, no .jsonl suffix
     dcf8639b-8d09-40de-8d2b-a54e6a46fd97/run-0/session.jsonl
  subagent-artifacts/
```

The directory name has **no `.jsonl` suffix**, so a `.jsonl` suffix filter already excludes
it — this is not, on its own, a bug. What matters is **never recursing**: a recursive walk
from the project directory would descend into the sidecar and surface each subagent
`run-0/session.jsonl` as if it were a top-level session. Discovery therefore enumerates
exactly one level and takes only regular files.

`isFile()` is still checked rather than assumed, because it costs one call and makes the
invariant explicit; the test asserts the sidecar's nested sessions are not surfaced.

## Rationale

- **Bounded path set.** Discovery reads exactly one directory tree with a fixed shape. It
  does not follow links out of it, does not execute anything, and never surfaces file
  contents beyond a length-capped preview string.
- **Keeps ADR-0002 true.** The orchestrator stays a small program that spawns fixed
  binaries and reads JSON. Adding Pi's agent core would make "the orchestrator holds no
  untrusted content" much harder to argue.
- **The format is stable enough.** It is versioned (`CURRENT_SESSION_VERSION = 3`), and the
  compatibility check (§Compatibility) asserts the shape at startup. If it breaks, we fix a
  parser — not an architecture.

## Consequences

**Positive**

- No runtime dependency on Pi internals; `tsc` still catches protocol drift via the
  type-only imports established in ADR-0005.
- Discovery cannot crash the orchestrator by loading a module that expects a live agent.
- Startup is fast, and the process stays small.

**Negative**

- Pi Central owns a parser for Pi's on-disk format. A format change is our bug to fix, not
  Pi's.
- `listAll`'s richer fields (`firstMessage` with parts, `lastActivityTime`) are not free;
  we implement what we need and no more. Fields we do not implement are not shown, rather
  than shown wrongly.
- **Counts from discovery are a floor.** The head window is 256 KB, so a large session's
  `messageCount` undercounts — measured at 69 for a session whose file holds 869 message
  records. This is acceptable only because a live session's count is corrected from
  `get_state` (`supervisor.ts`), which is authoritative. For a session that is *not* live,
  the rail shows the floor, and the exact figure is not known until the session is opened.
  If a future UI needs exact counts in the list, discovery must read each file fully and
  the timing above must be re-measured.

## Enforcement

- A startup compatibility check asserts the session header has `type === "session"` and a
  `version` the parser knows.
- A test asserts the orchestrator's runtime import graph contains **no**
  `@earendil-works/pi-coding-agent` value import — only `import type`.
- Re-check on Pi upgrade: header shape, `session_info` entries, directory encoding.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| `SessionManager.listAll()` at runtime | Loads the agent core into the privileged orchestrator; contradicts ADR-0002 for a directory listing. |
| `listAll` in a **sandboxed sidecar** | A second sandboxed process just to list files. Rejected as over-engineering, same as the file-access sidecar in ADR-0007. |
| Shell out to `pi --list-sessions` | No such command; and parsing Pi's stdout is a worse contract than parsing its versioned file format. |
| Import only `session-manager.js` (191 ms) | Smaller, but it is an internal `dist/core/` path with no stability guarantee, and it still loads runtime agent code. |
