# ADR-0007 — Filesystem access for the orchestrator and its UI

- **Status:** Accepted
- **Date:** 2026-06-24
- **Supersedes:** the file-navigation portion of the earlier ADR-0006 draft

## Context

Pi Central's UI offers file navigation and basic file operations over a session's working
directory. This ADR decides **how those reads and writes happen**.

An earlier draft of this decision routed all file access through a helper spawned under the
session's Safehouse policy. That was over-engineered. The corrected reasoning:

### The agents are already sandboxed

Safehouse confines the **agent** processes — Pi and its tools. A session running in
`/repo-a` cannot read `/repo-b`, cannot read `~/Documents`, and cannot escape its workdir.
That boundary is enforced by Seatbelt at the agent process, and it is the boundary that
matters: it is what constrains model-generated actions.

### The orchestrator is a user-Level application

The orchestrator is a local application running as the **user**, with the user's UID. It is
not sandboxed, and it does not need to be:

- It is not the thing executing untrusted, model-generated commands.
- It holds no untrusted state — it relays strings and spawns fixed binaries
  ([ADR-0002](0002-per-session-sandbox.md)).
- Sandboxing it is not merely unnecessary but actively harmful: Seatbelt does not nest
  ([C1](../CONSTRAINTS.md#c1--macos-seatbelt-does-not-nest)), so a sandboxed orchestrator
  could no longer spawn sandboxed sessions at all.

### What "the sandbox" is and is not for

Worth stating plainly, because conflating the two is what produced the earlier draft:

| | Protects against | Applies to |
|---|---|---|
| **Safehouse / Seatbelt** | Model-generated actions reaching outside a workdir | Agent processes |
| **User UID** | Other users on the machine | The orchestrator, the UI, any normal app |

The orchestrator operating at user UID is not a gap in Pi Central's security model. It is
the intended model: Pi Central is an application **for the user**, acting **as the user**,
on the user's own files. Confinement applies to the agents, not to the human's own tools.

## Decision

**The orchestrator performs file navigation and file operations directly, with the user's
own permissions.** No sandbox sidecar, no `safehouse` invocation, no routing through the
session's RPC `bash`.

Concretely:

- Directory listing and file reads use `fs` in the orchestrator process.
- File operations (create, rename, delete; see scope below) likewise.
- Paths are resolved and confined to the **session's `cwd`** — not because of the sandbox,
  but to keep the file browser coherent: it belongs to a session, so it shows that
  session's project.
- No `safehouse` involvement in the orchestrator's own I/O path.

### Why not route through the session

Routing reads through the agent's sandbox was rejected on three grounds:

1. **No generic tool-invoke RPC command exists.** The only command that can read a file is
   `bash`, making each read a shell round-trip rather than a filesystem call.
2. **It is slower and more complex** for no security gain — the user's own UID is already
   the correct privilege level for the user's own browser.
3. **It conflates two roles.** The agent sandbox constrains *the model's* reach. The file
   browser serves *the person*. They are not the same actor and should not share a
   mechanism.

## File operation scope

Read-only was too restrictive; the user should be able to manage their own project tree.
In scope:

| Operation | Notes |
|---|---|
| List directory | lazy expansion, hidden files toggle |
| Read file | size-capped, binary-detected and refused, encoding-aware |
| Create file / directory | |
| Rename / move | within the workdir |
| Delete | confirmation required; no silent recursive delete |

Still **out of scope**: editing file *contents* from the UI. Pi (through the agent, inside
its own sandbox) is the mutation path for content; the file browser is for navigation and
structure.

## Guardrails

None of these are about sandboxing; they are correctness and safety properties of a file
manager.

1. **Containment.** Canonicalize with `realpath`, then verify the result is inside the
   session's `cwd`. Do not compare string prefixes — that fails on `..`, on symlinks, and
   on case-insensitive filesystems.
2. **Symlinks.** Resolve before the containment check, so a symlink pointing outside the
   workdir is refused.
3. **Size caps.** Cap reads; detect binary content and refuse to render it.
4. **Confirmation.** Destructive operations require explicit confirmation; recursive delete
   is never implicit.
5. **No execution.** Nothing discovered by browsing is executed, sourced, or interpreted.
   Content is text to display, per [ADR-0006](0006-untrusted-markdown-rendering.md).

## Relationship to the agent sandbox

The two can legitimately disagree, and the UI must make that visible rather than hide it:

- A **session** can only touch its own workdir (plus temp and `~/.pi`).
- The **file browser** can reach anything the user can.

Where they overlap — and for normal work, the browser stays inside the session's `cwd` —
the two agree. If a future feature browses outside the workdir, it must be presented as
"your files, as you", not as "what the agent can see". Do not imply the browser shows the
agent's view.

## Consequences

**Positive**

- Simple, fast, dependency-free file navigation: plain `fs`, no extra process.
- One fewer component to supervise, and one fewer place where policy argv could drift.
- The model is easier to explain: agents are confined, the user's tools are not.

**Negative**

- The orchestrator can read files the agent cannot. Accepted deliberately: it acts for the
  user, not for the model. The UI must not misrepresent this as the agent's capability.
- File operations are destructive by nature, so the guardrails above are load-bearing and
  need tests (containment, symlink escape, confirmation).

## Verification

- Listing/reading a path outside the session's `cwd` is refused, including via `..` and via
  a symlink pointing out of the tree.
- Binary files are refused, not rendered.
- Recursive delete requires explicit confirmation.
- No `safehouse` invocation appears anywhere in the orchestrator's file I/O path.
